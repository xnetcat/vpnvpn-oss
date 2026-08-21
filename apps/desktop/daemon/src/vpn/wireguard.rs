//! WireGuard VPN backend.

use anyhow::{anyhow, Result};
use tracing::{debug, info, warn};
// `error!` is only emitted from the Unix (wg-quick) apply paths; the Windows
// code in this file never uses it, so keep the import Unix-only.
#[cfg(unix)]
use tracing::error;
use vpnvpn_shared::config::{SplitTunnelConfig, VpnBinaryPaths};
use vpnvpn_shared::protocol::{ConnectionState, ConnectionStatus, Protocol, VpnConfig};

const INTERFACE_NAME: &str = "vpnvpn-wg";

/// Get wg-quick path using the tools detection module.
/// Unix-only: the Windows path drives the WireGuard service, not wg-quick.
#[cfg(unix)]
fn get_wg_quick_path(paths: &VpnBinaryPaths) -> Result<String> {
    if let Some(path) = crate::tools::get_wireguard_path(paths) {
        info!("Using wg-quick at: {:?}", path);
        return Ok(path.to_string_lossy().to_string());
    }

    // Fallback: try common paths
    let paths = [
        "/opt/homebrew/bin/wg-quick", // macOS ARM Homebrew
        "/usr/local/bin/wg-quick",    // macOS Intel Homebrew / Linux
        "/usr/bin/wg-quick",          // Linux system
        "/bin/wg-quick",              // Linux system
    ];

    for path in &paths {
        if std::path::Path::new(path).exists() {
            info!("Found wg-quick at: {}", path);
            return Ok(path.to_string());
        }
    }

    warn!("wg-quick not found. Install WireGuard or set a custom path.");
    Err(anyhow::anyhow!(
        "wg-quick not found. Install WireGuard:\n  - macOS: brew install wireguard-tools\n  - Linux: sudo apt install wireguard-tools"
    ))
}

/// Find wg binary in common locations.
fn find_wg() -> Result<String> {
    let paths = [
        "/opt/homebrew/bin/wg", // macOS ARM Homebrew
        "/usr/local/bin/wg",    // macOS Intel Homebrew / Linux
        "/usr/bin/wg",          // Linux system
        "/bin/wg",              // Linux system
    ];

    for path in &paths {
        if std::path::Path::new(path).exists() {
            return Ok(path.to_string());
        }
    }

    // Fall back to PATH lookup
    Ok("wg".to_string())
}

/// Connect to WireGuard VPN.
pub async fn connect(
    config: &VpnConfig,
    paths: &VpnBinaryPaths,
    split_tunnel: &SplitTunnelConfig,
) -> Result<ConnectionStatus> {
    info!("Connecting via WireGuard to {}", config.server_endpoint);

    // Build WireGuard config file
    let wg_config = build_config(config, split_tunnel)?;

    // Write config to persistent location
    let config_path = get_config_path()?;
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&config_path, &wg_config)?;

    // Set restrictive file permissions (read/write for owner only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&config_path)?.permissions();
        perms.set_mode(0o600); // rw------- (owner read/write only)
        std::fs::set_permissions(&config_path, perms)?;
    }

    debug!("WireGuard config written to {:?}", config_path);

    // Apply configuration using platform-specific method
    #[cfg(target_os = "macos")]
    apply_macos(&config_path, paths).await?;

    #[cfg(target_os = "linux")]
    apply_linux(&config_path, paths).await?;

    #[cfg(target_os = "windows")]
    apply_windows(&config_path).await?;

    // Wait for interface to come up and initial handshake
    // Note: Peer may not be synced to VPN node yet (syncs every 10 seconds)
    // So we check status but don't fail immediately if not connected
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Verify connection - retry a few times as peer sync may be delayed
    let mut status = check_status().await?;
    let mut retries = 0;
    const MAX_RETRIES: u32 = 6;

    while status.state != ConnectionState::Connected && retries < MAX_RETRIES {
        retries += 1;
        info!(
            "WireGuard not connected yet (attempt {}/{}), waiting for peer sync...",
            retries, MAX_RETRIES
        );
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        status = check_status().await?;
    }

    if status.state == ConnectionState::Connected {
        info!("WireGuard connection established");
        return Ok(status);
    }

    // At this point the interface is up but we never got a handshake. Leaving it
    // up blackholes traffic (default route points at wg). Proactively tear it
    // down so the user's networking is restored and surface a hard error.
    warn!(
        "WireGuard connection not established after {} attempts. Rolling back interface.",
        MAX_RETRIES + 1
    );
    if let Err(e) = disconnect(paths).await {
        warn!("Failed to rollback WireGuard interface: {}", e);
    }

    Err(anyhow!(
        "WireGuard connection could not be verified after peer-sync retries; configuration was reverted"
    ))
}

/// Disconnect from WireGuard VPN.
// `paths` is only consumed by the Unix (wg-quick) branches; the Windows branch
// disconnects via the WireGuard service without it.
#[cfg_attr(windows, allow(unused_variables))]
pub async fn disconnect(paths: &VpnBinaryPaths) -> Result<()> {
    info!("Disconnecting WireGuard");

    #[cfg(target_os = "macos")]
    disconnect_macos(paths).await?;

    #[cfg(target_os = "linux")]
    disconnect_linux(paths).await?;

    #[cfg(target_os = "windows")]
    disconnect_windows().await?;

    Ok(())
}

/// Check WireGuard connection status.
pub async fn check_status() -> Result<ConnectionStatus> {
    let wg = find_wg()?;

    // wg-quick creates interface based on config filename (without .conf)
    // Config is at: .../wireguard/vpnvpn-wg.conf, so interface is "vpnvpn-wg"
    // But we check for "vpnvpn-wg0" as fallback, or try to find any vpnvpn interface
    let config_path = get_config_path()?;
    let interface_name = config_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(INTERFACE_NAME);

    // Check if interface exists and has a handshake
    let output = tokio::process::Command::new(&wg)
        .args(["show", interface_name])
        .output()
        .await;

    match output {
        Ok(o) if o.status.success() => {
            let stdout = String::from_utf8_lossy(&o.stdout);

            // Parse latest handshake and transfer stats
            let mut bytes_received = None;
            let mut bytes_sent = None;
            let mut has_handshake = false;

            for line in stdout.lines() {
                if line.contains("latest handshake:") {
                    has_handshake = true;
                }
                if line.contains("transfer:") {
                    // Parse "transfer: X received, Y sent"
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 4 {
                        bytes_received = parse_bytes(parts.get(1).unwrap_or(&"0"));
                        bytes_sent = parse_bytes(parts.get(3).unwrap_or(&"0"));
                    }
                }
            }

            Ok(ConnectionStatus {
                state: if has_handshake {
                    ConnectionState::Connected
                } else {
                    ConnectionState::Connecting
                },
                protocol: Some(Protocol::WireGuard),
                interface_name: Some(interface_name.to_string()),
                bytes_sent,
                bytes_received,
                ..Default::default()
            })
        }
        _ => Ok(ConnectionStatus {
            state: ConnectionState::Disconnected,
            protocol: Some(Protocol::WireGuard),
            ..Default::default()
        }),
    }
}

/// Normalize a WireGuard key to ensure it has proper base64 padding.
/// WireGuard keys must be exactly 32 bytes when decoded, which means
/// they should be 44 characters in base64 (with padding).
fn normalize_wg_key(key: &str) -> String {
    let trimmed = key.trim();
    // Base64 encode 32 bytes = 44 chars with padding
    // If key is 43 chars, it's missing padding
    if trimmed.len() == 43 {
        format!("{}=", trimmed)
    } else if trimmed.len() == 42 {
        format!("{}==", trimmed)
    } else {
        trimmed.to_string()
    }
}

/// Compute the WireGuard `AllowedIPs` value from the split-tunnel configuration.
///
/// - `Full`: route everything (`0.0.0.0/0, ::/0`).
/// - `Include`: route only the listed subnets through the tunnel.
/// - `Exclude`: route everything EXCEPT the listed subnets. WireGuard has no
///   native "exclude", so we approximate it by computing the IPv4 complement of
///   the excluded subnets (plus full IPv6). Each excluded subnet must be a valid
///   CIDR; invalid entries cause an error so we never silently mis-route.
fn compute_allowed_ips(split: &SplitTunnelConfig) -> Result<String> {
    use vpnvpn_shared::config::SplitTunnelMode as M;
    match split.mode {
        M::Full => Ok("0.0.0.0/0, ::/0".to_string()),
        M::Include => {
            if split.include_subnets.is_empty() {
                return Err(anyhow!(
                    "split-tunnel mode is 'include' but no subnets are listed"
                ));
            }
            for s in &split.include_subnets {
                crate::vpn::validate::validate_cidr_or_ip("include_subnet", s)?;
            }
            Ok(split.include_subnets.join(", "))
        }
        M::Exclude => {
            for s in &split.exclude_subnets {
                crate::vpn::validate::validate_cidr_or_ip("exclude_subnet", s)?;
            }
            // IPv4 complement of the excluded ranges + all IPv6.
            let mut allowed = exclude_v4_complement(&split.exclude_subnets)?;
            allowed.push("::/0".to_string());
            Ok(allowed.join(", "))
        }
    }
}

/// Compute the set of IPv4 CIDRs that covers everything except the given
/// excluded subnets (a coarse complement against `0.0.0.0/0`). IPv6 excludes are
/// ignored here (IPv6 is routed in full); only IPv4 entries are subtracted.
fn exclude_v4_complement(excludes: &[String]) -> Result<Vec<String>> {
    use std::net::Ipv4Addr;

    // Parse IPv4 excludes into (network_u32, prefix). Skip IPv6 entries.
    let mut ranges: Vec<(u32, u8)> = Vec::new();
    for s in excludes {
        let (addr, prefix) = match s.split_once('/') {
            Some((a, p)) => (a, p.parse::<u8>().unwrap_or(32)),
            None => (s.as_str(), 32),
        };
        if let Ok(ip) = addr.parse::<Ipv4Addr>() {
            let bits = u32::from(ip);
            let mask = if prefix == 0 {
                0
            } else {
                u32::MAX << (32 - prefix as u32)
            };
            ranges.push((bits & mask, prefix));
        }
    }

    if ranges.is_empty() {
        return Ok(vec!["0.0.0.0/0".to_string()]);
    }

    // Build the complement by recursively splitting 0.0.0.0/0 and dropping any
    // block fully contained in an excluded range.
    let mut result: Vec<String> = Vec::new();
    split_block(0, 0, &ranges, &mut result);
    if result.is_empty() {
        // Everything excluded — nothing to route over IPv4.
        return Ok(Vec::new());
    }
    Ok(result)
}

/// Recursively subtract excluded ranges from the block `base/prefix`.
fn split_block(base: u32, prefix: u8, excludes: &[(u32, u8)], out: &mut Vec<String>) {
    use std::net::Ipv4Addr;

    // If this block is fully inside any excluded range, drop it entirely.
    for &(ex_base, ex_prefix) in excludes {
        if ex_prefix <= prefix && covers(ex_base, ex_prefix, base, prefix) {
            return;
        }
    }

    // If no excluded range overlaps this block, keep the whole block.
    let overlaps = excludes
        .iter()
        .any(|&(ex_base, ex_prefix)| ranges_overlap(base, prefix, ex_base, ex_prefix));
    if !overlaps {
        out.push(format!("{}/{}", Ipv4Addr::from(base), prefix));
        return;
    }

    // Otherwise split into two halves and recurse (cap at /32).
    if prefix >= 32 {
        return;
    }
    let child_prefix = prefix + 1;
    let half = 1u32 << (32 - child_prefix as u32);
    split_block(base, child_prefix, excludes, out);
    split_block(base + half, child_prefix, excludes, out);
}

/// Whether range A (a_base/a_prefix) fully covers range B (b_base/b_prefix).
fn covers(a_base: u32, a_prefix: u8, b_base: u32, b_prefix: u8) -> bool {
    if a_prefix > b_prefix {
        return false;
    }
    let mask = if a_prefix == 0 {
        0
    } else {
        u32::MAX << (32 - a_prefix as u32)
    };
    (b_base & mask) == (a_base & mask)
}

/// Whether two CIDR ranges overlap at all.
fn ranges_overlap(a_base: u32, a_prefix: u8, b_base: u32, b_prefix: u8) -> bool {
    let p = a_prefix.min(b_prefix);
    let mask = if p == 0 {
        0
    } else {
        u32::MAX << (32 - p as u32)
    };
    (a_base & mask) == (b_base & mask)
}

fn build_config(config: &VpnConfig, split_tunnel: &SplitTunnelConfig) -> Result<String> {
    // Normalize keys to ensure proper base64 padding for WireGuard
    let private_key = config
        .wg_private_key
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("WireGuard private key not provided"))?;
    let private_key = normalize_wg_key(private_key);

    let server_public_key = config
        .wg_server_public_key
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("WireGuard server public key not provided"))?;
    let server_public_key = normalize_wg_key(server_public_key);

    let assigned_ip = config
        .assigned_ip
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Assigned IP not provided"))?;

    // Ensure assigned_ip has /32 suffix if not already present
    // Server returns IP with /32, but handle both cases
    let assigned_ip = if assigned_ip.contains('/') {
        assigned_ip.clone()
    } else {
        format!("{}/32", assigned_ip)
    };

    let dns = if config.dns_servers.is_empty() {
        "1.1.1.1, 1.0.0.1".to_string()
    } else {
        config.dns_servers.join(", ")
    };

    let endpoint = format!("{}:{}", config.server_endpoint, config.server_port);

    // AllowedIPs is shaped by the split-tunnel configuration (full / include /
    // exclude). Default is full-tunnel (0.0.0.0/0, ::/0).
    let allowed_ips = compute_allowed_ips(split_tunnel)?;

    let mut wg_config = format!(
        r#"[Interface]
PrivateKey = {}
Address = {}
DNS = {}

[Peer]
PublicKey = {}
AllowedIPs = {}
Endpoint = {}
PersistentKeepalive = 25
"#,
        private_key, assigned_ip, dns, server_public_key, allowed_ips, endpoint
    );

    // Add preshared key if provided
    if let Some(psk) = &config.wg_preshared_key {
        wg_config.push_str(&format!("PresharedKey = {}\n", psk.trim()));
    }

    Ok(wg_config)
}

fn get_config_path() -> Result<std::path::PathBuf> {
    let profiles_dir = vpnvpn_shared::config::profiles_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not determine config directory"))?;

    Ok(profiles_dir.join("wireguard").join("vpnvpn-wg.conf"))
}

#[cfg(target_os = "macos")]
async fn apply_macos(config_path: &std::path::Path, paths: &VpnBinaryPaths) -> Result<()> {
    // Check if running as root
    if !nix::unistd::geteuid().is_root() {
        return Err(anyhow::anyhow!(
            "VPN operations require root privileges. Run the daemon with: sudo bun run dev:daemon:watch"
        ));
    }

    let wg_quick = get_wg_quick_path(paths)?;
    info!("Using wg-quick at: {}", wg_quick);

    // Use wg-quick to bring up the interface
    let output = tokio::process::Command::new(&wg_quick)
        .args(["up", config_path.to_str().unwrap()])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        error!("wg-quick up failed. stderr: {}, stdout: {}", stderr, stdout);

        // Provide helpful error messages
        if stderr.contains("sudo") || stderr.contains("password") {
            return Err(anyhow::anyhow!(
                "VPN requires root privileges. Run daemon with: sudo bun run dev:daemon:watch"
            ));
        }

        return Err(anyhow::anyhow!("wg-quick up failed: {}", stderr));
    }

    info!("wg-quick up succeeded");
    Ok(())
}

#[cfg(target_os = "macos")]
async fn disconnect_macos(paths: &VpnBinaryPaths) -> Result<()> {
    let wg_quick = get_wg_quick_path(paths)?;
    let config_path = get_config_path()?;

    info!(
        "Disconnecting WireGuard with: {} down {:?}",
        wg_quick, config_path
    );

    let _ = tokio::process::Command::new(&wg_quick)
        .args(["down", config_path.to_str().unwrap()])
        .output()
        .await;

    Ok(())
}

#[cfg(target_os = "linux")]
async fn apply_linux(config_path: &std::path::Path, paths: &VpnBinaryPaths) -> Result<()> {
    // Check if running as root
    if !nix::unistd::geteuid().is_root() {
        return Err(anyhow::anyhow!(
            "VPN operations require root privileges. Run the daemon with: sudo bun run dev:daemon:watch"
        ));
    }

    let wg_quick = get_wg_quick_path(paths)?;
    info!("Using wg-quick at: {}", wg_quick);

    let output = tokio::process::Command::new(&wg_quick)
        .args(["up", config_path.to_str().unwrap()])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        error!("wg-quick up failed. stderr: {}, stdout: {}", stderr, stdout);

        // Provide helpful error messages
        if stderr.contains("sudo") || stderr.contains("permission") {
            return Err(anyhow::anyhow!(
                "VPN requires root privileges. Run daemon with: sudo bun run dev:daemon:watch"
            ));
        }

        return Err(anyhow::anyhow!("wg-quick up failed: {}", stderr));
    }

    info!("wg-quick up succeeded");
    Ok(())
}

#[cfg(target_os = "linux")]
async fn disconnect_linux(paths: &VpnBinaryPaths) -> Result<()> {
    let wg_quick = get_wg_quick_path(paths)?;
    let config_path = get_config_path()?;

    info!(
        "Disconnecting WireGuard with: {} down {:?}",
        wg_quick, config_path
    );

    let _ = tokio::process::Command::new(&wg_quick)
        .args(["down", config_path.to_str().unwrap()])
        .output()
        .await;

    Ok(())
}

#[cfg(target_os = "windows")]
async fn apply_windows(config_path: &std::path::Path) -> Result<()> {
    // On Windows, use wireguard.exe to install tunnel service
    let output = tokio::process::Command::new("wireguard.exe")
        .args(["/installtunnelservice", config_path.to_str().unwrap()])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!("wireguard install failed: {}", stderr));
    }

    Ok(())
}

#[cfg(target_os = "windows")]
async fn disconnect_windows() -> Result<()> {
    let _ = tokio::process::Command::new("wireguard.exe")
        .args(["/uninstalltunnelservice", INTERFACE_NAME])
        .output()
        .await;

    Ok(())
}

fn parse_bytes(s: &str) -> Option<u64> {
    // Parse human-readable byte strings like "1.2 GiB" or "500 MiB"
    let s = s.trim();

    // Try parsing as plain number first
    if let Ok(n) = s.parse::<u64>() {
        return Some(n);
    }

    // Parse with suffix
    let (num_str, suffix) = s.split_at(s.len().saturating_sub(3));
    let num: f64 = num_str.trim().parse().ok()?;

    let multiplier = match suffix.to_lowercase().as_str() {
        "kib" | "kb" => 1024.0,
        "mib" | "mb" => 1024.0 * 1024.0,
        "gib" | "gb" => 1024.0 * 1024.0 * 1024.0,
        "tib" | "tb" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };

    Some((num * multiplier) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vpnvpn_shared::config::{SplitTunnelConfig, SplitTunnelMode};

    #[test]
    fn full_tunnel_routes_everything() {
        let split = SplitTunnelConfig::default();
        assert_eq!(compute_allowed_ips(&split).unwrap(), "0.0.0.0/0, ::/0");
    }

    #[test]
    fn include_mode_routes_only_listed_subnets() {
        let split = SplitTunnelConfig {
            mode: SplitTunnelMode::Include,
            include_subnets: vec!["10.0.0.0/8".to_string(), "192.168.1.0/24".to_string()],
            exclude_subnets: vec![],
        };
        assert_eq!(
            compute_allowed_ips(&split).unwrap(),
            "10.0.0.0/8, 192.168.1.0/24"
        );
    }

    #[test]
    fn include_mode_rejects_empty_list() {
        let split = SplitTunnelConfig {
            mode: SplitTunnelMode::Include,
            include_subnets: vec![],
            exclude_subnets: vec![],
        };
        assert!(compute_allowed_ips(&split).is_err());
    }

    #[test]
    fn include_mode_rejects_invalid_cidr() {
        let split = SplitTunnelConfig {
            mode: SplitTunnelMode::Include,
            include_subnets: vec!["not-a-cidr".to_string()],
            exclude_subnets: vec![],
        };
        assert!(compute_allowed_ips(&split).is_err());
    }

    #[test]
    fn exclude_mode_omits_excluded_range_and_keeps_ipv6() {
        let split = SplitTunnelConfig {
            mode: SplitTunnelMode::Exclude,
            include_subnets: vec![],
            exclude_subnets: vec!["10.0.0.0/8".to_string()],
        };
        let allowed = compute_allowed_ips(&split).unwrap();
        // IPv6 is always routed.
        assert!(allowed.contains("::/0"), "got: {allowed}");
        // The excluded /8 must not appear as an allowed route.
        assert!(!allowed.contains("10.0.0.0/8"), "got: {allowed}");
        // The complement must include other space (e.g. 0.0.0.0/... blocks).
        assert!(
            allowed.contains("0.0.0.0/") || allowed.contains("/"),
            "got: {allowed}"
        );
        // Sanity: every IPv4 entry is a valid CIDR.
        for part in allowed.split(", ") {
            if part == "::/0" {
                continue;
            }
            crate::vpn::validate::validate_cidr_or_ip("test", part).unwrap();
        }
    }

    #[test]
    fn exclude_complement_does_not_contain_excluded_addresses() {
        // 192.168.0.0/16 excluded -> none of the produced v4 ranges may contain
        // an address inside 192.168.x.x.
        use std::net::Ipv4Addr;
        let ranges = exclude_v4_complement(&["192.168.0.0/16".to_string()]).unwrap();
        let excluded_net = u32::from(Ipv4Addr::new(192, 168, 0, 0));
        let excluded_mask = u32::MAX << 16;
        for cidr in &ranges {
            let (addr, prefix) = cidr.split_once('/').unwrap();
            let base = u32::from(addr.parse::<Ipv4Addr>().unwrap());
            let p: u8 = prefix.parse().unwrap();
            // The block must not be inside the excluded /16.
            let overlap_mask = if p < 16 {
                u32::MAX << (32 - p as u32)
            } else {
                excluded_mask
            };
            let inside = (base & overlap_mask & excluded_mask) == excluded_net && p >= 16;
            assert!(!inside, "block {cidr} overlaps excluded 192.168.0.0/16");
        }
    }
}

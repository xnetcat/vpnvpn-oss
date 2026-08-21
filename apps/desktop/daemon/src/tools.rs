//! VPN tool detection and management.
//!
//! Detects available VPN tools (WireGuard, OpenVPN, IKEv2) and their paths.

use std::path::PathBuf;
use std::process::Command;
use std::sync::RwLock;
use tracing::{debug, info, warn};
use vpnvpn_shared::config::{VpnBinaryPaths, VpnToolInfo, VpnToolsStatus};

/// Global cached tools status (refreshed on demand).
static TOOLS_CACHE: RwLock<Option<VpnToolsStatus>> = RwLock::new(None);

/// Detect all VPN tools and return their status.
pub fn detect_vpn_tools(custom_paths: &VpnBinaryPaths) -> VpnToolsStatus {
    info!("Detecting VPN tools...");

    let wireguard = detect_wireguard(custom_paths);
    let openvpn = detect_openvpn(custom_paths);
    let ikev2 = detect_ikev2(custom_paths);

    let status = VpnToolsStatus {
        wireguard,
        openvpn,
        ikev2,
    };

    // Cache the result
    if let Ok(mut cache) = TOOLS_CACHE.write() {
        *cache = Some(status.clone());
    }

    info!(
        "VPN tools detected: WireGuard={}, OpenVPN={}, IKEv2={}",
        status.wireguard.available, status.openvpn.available, status.ikev2.available
    );

    status
}

/// Get cached tools status or detect if not cached.
pub fn get_vpn_tools(custom_paths: &VpnBinaryPaths) -> VpnToolsStatus {
    if let Ok(cache) = TOOLS_CACHE.read() {
        if let Some(status) = cache.as_ref() {
            return status.clone();
        }
    }
    detect_vpn_tools(custom_paths)
}

/// Refresh the tools cache.
pub fn refresh_vpn_tools(custom_paths: &VpnBinaryPaths) -> VpnToolsStatus {
    detect_vpn_tools(custom_paths)
}

/// Get the path to a specific VPN tool binary.
/// Unix-only: callers are the wg-quick/openvpn launch paths, which Windows
/// does not use (it drives the WireGuard service / openvpn.exe directly).
#[cfg(unix)]
pub fn get_wireguard_path(custom_paths: &VpnBinaryPaths) -> Option<PathBuf> {
    let tools = get_vpn_tools(custom_paths);
    tools.wireguard.path.map(PathBuf::from)
}

#[cfg(unix)]
pub fn get_openvpn_path(custom_paths: &VpnBinaryPaths) -> Option<PathBuf> {
    let tools = get_vpn_tools(custom_paths);
    tools.openvpn.path.map(PathBuf::from)
}

/// Detected IKEv2 tool path (used by the IKEv2 backend's tool resolution helper).
#[allow(dead_code)]
pub fn get_ikev2_path(custom_paths: &VpnBinaryPaths) -> Option<PathBuf> {
    let tools = get_vpn_tools(custom_paths);
    tools.ikev2.path.map(PathBuf::from)
}

// ============ WireGuard Detection ============

fn detect_wireguard(custom_paths: &VpnBinaryPaths) -> VpnToolInfo {
    #[cfg(target_os = "windows")]
    let (binary_name, custom_path) = ("wireguard.exe", custom_paths.wireguard_cli_path.as_deref());

    #[cfg(not(target_os = "windows"))]
    let (binary_name, custom_path) = ("wg-quick", custom_paths.wg_quick_path.as_deref());

    detect_tool(binary_name, custom_path, WIREGUARD_SEARCH_PATHS)
}

#[cfg(target_os = "macos")]
const WIREGUARD_SEARCH_PATHS: &[&str] = &[
    "/opt/homebrew/bin/wg-quick",
    "/opt/homebrew/sbin/wg-quick",
    "/usr/local/bin/wg-quick",
    "/usr/local/sbin/wg-quick",
    "/usr/bin/wg-quick",
    "/usr/sbin/wg-quick",
];

#[cfg(target_os = "linux")]
const WIREGUARD_SEARCH_PATHS: &[&str] = &[
    "/usr/bin/wg-quick",
    "/usr/sbin/wg-quick",
    "/bin/wg-quick",
    "/sbin/wg-quick",
    "/usr/local/bin/wg-quick",
    "/usr/local/sbin/wg-quick",
];

#[cfg(target_os = "windows")]
const WIREGUARD_SEARCH_PATHS: &[&str] = &[
    r"C:\Program Files\WireGuard\wireguard.exe",
    r"C:\Program Files (x86)\WireGuard\wireguard.exe",
];

// ============ OpenVPN Detection ============

fn detect_openvpn(custom_paths: &VpnBinaryPaths) -> VpnToolInfo {
    #[cfg(target_os = "windows")]
    let binary_name = "openvpn.exe";
    #[cfg(not(target_os = "windows"))]
    let binary_name = "openvpn";

    detect_tool(
        binary_name,
        custom_paths.openvpn_path.as_deref(),
        OPENVPN_SEARCH_PATHS,
    )
}

#[cfg(target_os = "macos")]
const OPENVPN_SEARCH_PATHS: &[&str] = &[
    "/opt/homebrew/sbin/openvpn",
    "/opt/homebrew/bin/openvpn",
    "/usr/local/sbin/openvpn",
    "/usr/local/bin/openvpn",
    "/usr/sbin/openvpn",
    "/usr/bin/openvpn",
];

#[cfg(target_os = "linux")]
const OPENVPN_SEARCH_PATHS: &[&str] = &[
    "/usr/sbin/openvpn",
    "/usr/bin/openvpn",
    "/sbin/openvpn",
    "/bin/openvpn",
    "/usr/local/sbin/openvpn",
    "/usr/local/bin/openvpn",
];

#[cfg(target_os = "windows")]
const OPENVPN_SEARCH_PATHS: &[&str] = &[
    r"C:\Program Files\OpenVPN\bin\openvpn.exe",
    r"C:\Program Files (x86)\OpenVPN\bin\openvpn.exe",
    r"C:\Program Files\OpenVPN Connect\openvpn.exe",
];

// ============ IKEv2 Detection ============

fn detect_ikev2(custom_paths: &VpnBinaryPaths) -> VpnToolInfo {
    #[cfg(target_os = "macos")]
    {
        // macOS uses networksetup (built-in)
        detect_tool(
            "networksetup",
            custom_paths.ikev2_path.as_deref(),
            IKEV2_SEARCH_PATHS_MACOS,
        )
    }

    #[cfg(target_os = "linux")]
    {
        // Linux typically uses strongSwan (ipsec command) or NetworkManager (nmcli)
        let mut info = detect_tool(
            "ipsec",
            custom_paths.ikev2_path.as_deref(),
            IKEV2_SEARCH_PATHS_LINUX,
        );
        if !info.available {
            // Try strongswan directly
            info = detect_tool(
                "strongswan",
                None,
                &["/usr/sbin/strongswan", "/usr/local/sbin/strongswan"],
            );
        }
        if !info.available {
            // Try nmcli as fallback
            info = detect_tool("nmcli", None, &["/usr/bin/nmcli"]);
            if info.available {
                info.version = Some("NetworkManager".to_string());
            }
        }
        info
    }

    #[cfg(target_os = "windows")]
    {
        // Windows has built-in IKEv2 support via rasdial/PowerShell
        detect_tool(
            "rasdial.exe",
            custom_paths.ikev2_path.as_deref(),
            IKEV2_SEARCH_PATHS_WINDOWS,
        )
    }
}

#[cfg(target_os = "macos")]
const IKEV2_SEARCH_PATHS_MACOS: &[&str] = &["/usr/sbin/networksetup", "/usr/bin/networksetup"];

#[cfg(target_os = "linux")]
const IKEV2_SEARCH_PATHS_LINUX: &[&str] =
    &["/usr/sbin/ipsec", "/usr/local/sbin/ipsec", "/sbin/ipsec"];

#[cfg(target_os = "windows")]
const IKEV2_SEARCH_PATHS_WINDOWS: &[&str] = &[r"C:\Windows\System32\rasdial.exe"];

// ============ Generic Tool Detection ============

fn detect_tool(binary_name: &str, custom_path: Option<&str>, search_paths: &[&str]) -> VpnToolInfo {
    debug!(
        "Detecting tool: {} (custom_path: {:?})",
        binary_name, custom_path
    );

    // 1. Check custom path first
    if let Some(path) = custom_path {
        let path = path.trim();
        if !path.is_empty() {
            let p = PathBuf::from(path);
            if p.exists() {
                let version = get_tool_version(&p);
                return VpnToolInfo {
                    available: true,
                    path: Some(path.to_string()),
                    version,
                    custom_path: Some(path.to_string()),
                    error: None,
                };
            } else {
                warn!("Custom path for {} does not exist: {}", binary_name, path);
            }
        }
    }

    // 2. Check predefined search paths
    for &search_path in search_paths {
        let p = PathBuf::from(search_path);
        if p.exists() {
            let version = get_tool_version(&p);
            debug!("Found {} at {}", binary_name, search_path);
            return VpnToolInfo {
                available: true,
                path: Some(search_path.to_string()),
                version,
                custom_path: custom_path.map(|s| s.to_string()),
                error: None,
            };
        }
    }

    // 3. Try which/where command
    if let Some(path) = find_in_path(binary_name) {
        let version = get_tool_version(&path);
        debug!("Found {} via PATH at {:?}", binary_name, path);
        return VpnToolInfo {
            available: true,
            path: Some(path.to_string_lossy().to_string()),
            version,
            custom_path: custom_path.map(|s| s.to_string()),
            error: None,
        };
    }

    debug!("{} not found", binary_name);
    VpnToolInfo {
        available: false,
        path: None,
        version: None,
        custom_path: custom_path.map(|s| s.to_string()),
        error: Some(format!(
            "{} not found. Install it or set a custom path.",
            binary_name
        )),
    }
}

fn find_in_path(binary_name: &str) -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    let cmd = "where";
    #[cfg(not(target_os = "windows"))]
    let cmd = "which";

    Command::new(cmd)
        .arg(binary_name)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8(o.stdout)
                .ok()
                .map(|s| PathBuf::from(s.lines().next().unwrap_or("").trim()))
        })
        .filter(|p| !p.as_os_str().is_empty())
}

fn get_tool_version(path: &PathBuf) -> Option<String> {
    // Try common version flags
    for flag in &["--version", "-v", "-V", "version"] {
        if let Ok(output) = Command::new(path).arg(flag).output() {
            if output.status.success() || !output.stdout.is_empty() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                let version_text = if !stdout.is_empty() { stdout } else { stderr };

                // Extract version number from output
                if let Some(version) = extract_version(&version_text) {
                    return Some(version);
                }
            }
        }
    }
    None
}

fn extract_version(text: &str) -> Option<String> {
    // Common patterns: "v1.2.3", "1.2.3", "version 1.2.3"
    let text = text.lines().next().unwrap_or("");

    // Try to find version-like pattern
    for word in text.split_whitespace() {
        let word = word.trim_start_matches('v').trim_start_matches('V');
        if word
            .chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
        {
            // Check if it looks like a version (contains dots and numbers)
            if word.contains('.')
                && word
                    .chars()
                    .all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c == '_')
            {
                return Some(word.to_string());
            }
        }
    }

    // Fallback: return first line truncated
    let first_line = text.lines().next().unwrap_or("").trim();
    if !first_line.is_empty() && first_line.len() < 50 {
        return Some(first_line.to_string());
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_tools_empty_paths() {
        let paths = VpnBinaryPaths::default();
        let status = detect_vpn_tools(&paths);
        // At least one tool should be available on most systems
        println!("WireGuard: {:?}", status.wireguard);
        println!("OpenVPN: {:?}", status.openvpn);
        println!("IKEv2: {:?}", status.ikev2);
    }

    #[test]
    fn test_extract_version() {
        assert_eq!(
            extract_version("WireGuard v1.0.20210914"),
            Some("1.0.20210914".to_string())
        );
        assert_eq!(extract_version("OpenVPN 2.5.5"), Some("2.5.5".to_string()));
        assert_eq!(
            extract_version("networksetup version 1.0"),
            Some("1.0".to_string())
        );
    }
}

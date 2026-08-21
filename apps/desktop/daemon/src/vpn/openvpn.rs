//! OpenVPN backend.

use anyhow::Result;
use tracing::{debug, error, info, warn};
use vpnvpn_shared::config::VpnBinaryPaths;
use vpnvpn_shared::protocol::{ConnectionState, ConnectionStatus, Protocol, VpnConfig};

/// Connect using OpenVPN.
// `paths` is only consumed by the cfg(unix) `start_openvpn_unix` call; the
// Windows starter resolves openvpn.exe itself.
#[cfg_attr(windows, allow(unused_variables))]
pub async fn connect(config: &VpnConfig, paths: &VpnBinaryPaths) -> Result<ConnectionStatus> {
    info!("Connecting via OpenVPN to {}", config.server_endpoint);

    // Get OpenVPN config or generate one
    let ovpn_config = config
        .ovpn_config
        .clone()
        .unwrap_or_else(|| build_config(config));

    // Write config to persistent location
    let config_path = get_config_path()?;
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&config_path, &ovpn_config)?;

    // Write auth file. OpenVPN here always uses username/password auth, so fail
    // with a clear error rather than writing placeholder credentials that would
    // surface only as an opaque server-side auth rejection later.
    let (username, password) = match (&config.username, &config.password) {
        (Some(u), Some(p)) => (u, p),
        _ => {
            return Err(anyhow::anyhow!(
                "OpenVPN connection profile is missing username/password credentials"
            ));
        }
    };
    let auth_path = config_path.parent().unwrap().join("vpnvpn-auth.txt");
    std::fs::write(&auth_path, format!("{}\n{}\n", username, password))?;

    // Set restrictive file permissions (read/write for owner only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        // Config file permissions
        let mut perms = std::fs::metadata(&config_path)?.permissions();
        perms.set_mode(0o600); // rw------- (owner read/write only)
        std::fs::set_permissions(&config_path, perms)?;

        // Auth file permissions
        let mut auth_perms = std::fs::metadata(&auth_path)?.permissions();
        auth_perms.set_mode(0o600);
        std::fs::set_permissions(&auth_path, auth_perms)?;
    }

    debug!("OpenVPN config written to {:?}", config_path);

    // Start OpenVPN process
    #[cfg(unix)]
    start_openvpn_unix(&config_path, paths).await?;

    #[cfg(windows)]
    start_openvpn_windows(&config_path).await?;

    // Wait for the tunnel to actually establish instead of assuming success.
    // OpenVPN writes "Initialization Sequence Completed" to its log once the
    // tunnel is fully up; we poll for that AND for the tun interface presence.
    const MAX_ATTEMPTS: u32 = 15;
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

    for attempt in 1..=MAX_ATTEMPTS {
        tokio::time::sleep(POLL_INTERVAL).await;

        let log_ready = log_indicates_established().await;
        let status = check_status().await?;

        if status.state == ConnectionState::Connected && log_ready {
            info!(
                "OpenVPN connection established after {} attempt(s)",
                attempt
            );
            return Ok(status);
        }

        // If the log reports a fatal error there is no point waiting further.
        if log_indicates_failure().await {
            warn!("OpenVPN log reports a fatal error; aborting");
            break;
        }

        debug!(
            "OpenVPN not established yet (attempt {}/{}): iface={:?}, log_ready={}",
            attempt, MAX_ATTEMPTS, status.interface_name, log_ready
        );
    }

    // Establishment failed: tear down the half-started process so we don't leave
    // a dangling openvpn that could partially route traffic, then return an error
    // (mirrors the WireGuard verify-or-rollback behaviour).
    error!("OpenVPN connection could not be verified; rolling back");
    if let Err(e) = disconnect().await {
        warn!("Failed to roll back OpenVPN: {}", e);
    }

    Err(anyhow::anyhow!(
        "OpenVPN tunnel did not establish (no 'Initialization Sequence Completed'). \
         Check credentials, server reachability, and /var/log/vpnvpn-openvpn.log."
    ))
}

/// Path to the OpenVPN log the daemon starts the process with.
#[cfg(unix)]
const OPENVPN_LOG_PATH: &str = "/var/log/vpnvpn-openvpn.log";

/// Whether the OpenVPN log shows the tunnel finished initialization.
async fn log_indicates_established() -> bool {
    #[cfg(unix)]
    {
        match tokio::fs::read_to_string(OPENVPN_LOG_PATH).await {
            Ok(log) => log.contains("Initialization Sequence Completed"),
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        // On Windows we rely on process/interface presence via check_status.
        true
    }
}

/// Whether the OpenVPN log shows a fatal error (so we can fail fast).
async fn log_indicates_failure() -> bool {
    #[cfg(unix)]
    {
        match tokio::fs::read_to_string(OPENVPN_LOG_PATH).await {
            Ok(log) => {
                log.contains("AUTH_FAILED")
                    || log.contains("Cannot resolve host address")
                    || log.contains("Exiting due to fatal error")
                    || log.contains("TLS Error: TLS handshake failed")
            }
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Disconnect OpenVPN.
pub async fn disconnect() -> Result<()> {
    info!("Disconnecting OpenVPN");

    #[cfg(unix)]
    {
        // Try PID-based kill first to avoid killing unrelated openvpn processes
        let pid_path = get_config_path()?
            .parent()
            .unwrap()
            .join("vpnvpn-openvpn.pid");
        let mut killed = false;
        if let Ok(pid_str) = std::fs::read_to_string(&pid_path) {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                info!("Killing OpenVPN process with PID {}", pid);
                let _ = tokio::process::Command::new("kill")
                    .args(["-SIGTERM", &pid.to_string()])
                    .output()
                    .await;
                killed = true;
            }
            let _ = std::fs::remove_file(&pid_path);
        }
        if !killed {
            // Fallback: kill by name (less precise)
            let _ = tokio::process::Command::new("pkill")
                .args(["-SIGTERM", "openvpn"])
                .output()
                .await;
        }
    }

    #[cfg(windows)]
    {
        let _ = tokio::process::Command::new("taskkill")
            .args(["/IM", "openvpn.exe", "/F"])
            .output()
            .await;
    }

    Ok(())
}

/// Check OpenVPN connection status via tun interface presence.
/// Checks multiple tun interfaces since the server may use tun1.
pub async fn check_status() -> Result<ConnectionStatus> {
    #[cfg(target_os = "macos")]
    let (connected, iface_name) = {
        let mut found = (false, "tun0".to_string());
        for iface in &["tun0", "tun1", "utun3", "utun4", "utun5"] {
            let output = tokio::process::Command::new("ifconfig")
                .arg(iface)
                .output()
                .await;
            if matches!(&output, Ok(o) if o.status.success()
                && String::from_utf8_lossy(&o.stdout).contains("inet "))
            {
                found = (true, iface.to_string());
                break;
            }
        }
        found
    };

    #[cfg(target_os = "linux")]
    let (connected, iface_name) = {
        let mut found = (false, "tun0".to_string());
        for iface in &["tun0", "tun1"] {
            let output = tokio::process::Command::new("ip")
                .args(["addr", "show", iface])
                .output()
                .await;
            if matches!(&output, Ok(o) if o.status.success()
                && String::from_utf8_lossy(&o.stdout).contains("inet "))
            {
                found = (true, iface.to_string());
                break;
            }
        }
        found
    };

    #[cfg(windows)]
    let (connected, iface_name) = {
        let output = tokio::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq openvpn.exe"])
            .output()
            .await;
        let connected =
            matches!(output, Ok(o) if String::from_utf8_lossy(&o.stdout).contains("openvpn.exe"));
        (connected, "OpenVPN".to_string())
    };

    Ok(ConnectionStatus {
        state: if connected {
            ConnectionState::Connected
        } else {
            ConnectionState::Disconnected
        },
        protocol: Some(Protocol::OpenVPN),
        interface_name: Some(iface_name),
        ..Default::default()
    })
}

fn build_config(config: &VpnConfig) -> String {
    let dns = if config.dns_servers.is_empty() {
        "1.1.1.1".to_string()
    } else {
        config.dns_servers.first().cloned().unwrap_or_default()
    };

    format!(
        r#"client
dev tun
proto udp
remote {} {}
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
cipher AES-256-GCM
data-ciphers AES-256-GCM:CHACHA20-POLY1305
tls-version-min 1.2
auth SHA256
verb 3

# DNS
dhcp-option DNS {}

# Keep alive
keepalive 10 60

# Server: {}
"#,
        config.server_endpoint, config.server_port, dns, config.server_region
    )
}

fn get_config_path() -> Result<std::path::PathBuf> {
    let profiles_dir = vpnvpn_shared::config::profiles_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not determine config directory"))?;

    Ok(profiles_dir.join("openvpn").join("vpnvpn-ovpn.conf"))
}

#[cfg(unix)]
async fn start_openvpn_unix(config_path: &std::path::Path, paths: &VpnBinaryPaths) -> Result<()> {
    // Get openvpn path using the tools module
    let openvpn_path = get_openvpn_path(paths)?;
    info!("Using openvpn at: {:?}", openvpn_path);

    // Truncate any stale log so we don't read a previous run's
    // "Initialization Sequence Completed" line when verifying this connection.
    let _ = std::fs::write(OPENVPN_LOG_PATH, b"");

    // Start openvpn as daemon with PID file for targeted disconnect
    let pid_path = config_path.parent().unwrap().join("vpnvpn-openvpn.pid");
    let output = tokio::process::Command::new(&openvpn_path)
        .args([
            "--config",
            config_path.to_str().unwrap(),
            "--daemon",
            "--log",
            "/var/log/vpnvpn-openvpn.log",
            "--writepid",
            pid_path.to_str().unwrap(),
        ])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        error!("OpenVPN failed - stderr: {}, stdout: {}", stderr, stdout);
        return Err(anyhow::anyhow!(
            "openvpn start failed: {}{}",
            stderr,
            if stderr.is_empty() && stdout.is_empty() {
                "Check /var/log/vpnvpn-openvpn.log for details"
            } else {
                ""
            }
        ));
    }

    Ok(())
}

#[cfg(unix)]
fn get_openvpn_path(paths: &VpnBinaryPaths) -> Result<std::path::PathBuf> {
    // Use tools module for detection
    if let Some(path) = crate::tools::get_openvpn_path(paths) {
        return Ok(path);
    }

    // Fallback: try common paths
    let paths = [
        "/opt/homebrew/sbin/openvpn",
        "/opt/homebrew/bin/openvpn",
        "/usr/local/sbin/openvpn",
        "/usr/local/bin/openvpn",
        "/usr/sbin/openvpn",
        "/usr/bin/openvpn",
        "/sbin/openvpn",
        "/bin/openvpn",
    ];

    for path in paths {
        let p = std::path::Path::new(path);
        if p.exists() {
            return Ok(p.to_path_buf());
        }
    }

    Err(anyhow::anyhow!(
        "OpenVPN not found. Please install it:\n  - macOS: brew install openvpn\n  - Ubuntu/Debian: sudo apt install openvpn\n\nAlternatively, use WireGuard which is configured for the local dev stack."
    ))
}

#[cfg(windows)]
async fn start_openvpn_windows(config_path: &std::path::Path) -> Result<()> {
    // Start openvpn process (may need to be run as service)
    tokio::process::Command::new("openvpn.exe")
        .args(["--config", config_path.to_str().unwrap()])
        .spawn()?;

    Ok(())
}

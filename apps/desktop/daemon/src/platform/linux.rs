//! Linux platform initialization.

use anyhow::Result;
use tracing::info;

/// Initialize Linux-specific components.
pub fn init() -> Result<()> {
    info!("Initializing Linux platform...");

    // Verify we're running with elevated privileges
    if !is_root() {
        tracing::warn!("Daemon is not running as root. Some features may not work.");
    }

    // Create required directories
    std::fs::create_dir_all("/var/run")?;

    Ok(())
}

/// Check if running as root.
pub fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

/// Check if we have required capabilities.
pub fn has_net_admin_cap() -> bool {
    // Check CAP_NET_ADMIN capability
    // For simplicity, we just check if we're root
    is_root()
}

/// Systemd unit file content.
#[allow(dead_code)] // Retained for systemd-based daemon install (GUI-driven).
pub fn systemd_unit() -> &'static str {
    r#"[Unit]
Description=vpnVPN Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/vpnvpn-daemon
Restart=always
RestartSec=5
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW
NoNewPrivileges=true

# Security hardening
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
ReadWritePaths=/var/run

[Install]
WantedBy=multi-user.target
"#
}

/// Install script using pkexec.
#[allow(dead_code)] // Retained for systemd-based daemon install (GUI-driven).
pub fn install_daemon_script(bundled_path: &str) -> String {
    format!(
        r#"pkexec sh -c '
            cp "{}" /usr/local/bin/vpnvpn-daemon &&
            chmod 755 /usr/local/bin/vpnvpn-daemon &&
            chown root:root /usr/local/bin/vpnvpn-daemon &&
            cat > /etc/systemd/system/vpnvpn-daemon.service << "EOF"
{}
EOF
            systemctl daemon-reload &&
            systemctl enable vpnvpn-daemon &&
            systemctl start vpnvpn-daemon
        '"#,
        bundled_path,
        systemd_unit()
    )
}

/// Uninstall script.
#[allow(dead_code)] // Retained for systemd-based daemon uninstall (GUI-driven).
pub fn uninstall_daemon_script() -> &'static str {
    r#"pkexec sh -c '
        systemctl stop vpnvpn-daemon 2>/dev/null || true &&
        systemctl disable vpnvpn-daemon 2>/dev/null || true &&
        rm -f /etc/systemd/system/vpnvpn-daemon.service &&
        systemctl daemon-reload &&
        rm -f /usr/local/bin/vpnvpn-daemon &&
        rm -f /var/run/vpnvpn-daemon.sock
    '"#
}

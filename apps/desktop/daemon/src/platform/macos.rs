//! macOS platform initialization.

use anyhow::Result;
use tracing::info;

/// Initialize macOS-specific components.
pub fn init() -> Result<()> {
    info!("Initializing macOS platform...");

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

/// Get the path to the daemon binary in the app bundle.
///
/// Install-helper retained for parity with the Linux platform module; the GUI
/// (src-tauri) drives installation, so the daemon binary itself doesn't call it.
#[allow(dead_code)]
pub fn bundled_daemon_path(app_path: &str) -> String {
    format!(
        "{}/Contents/Library/LaunchServices/com.vpnvpn.daemon",
        app_path
    )
}

/// LaunchDaemon plist content.
#[allow(dead_code)]
pub fn launchdaemon_plist() -> &'static str {
    r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.vpnvpn.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Library/PrivilegedHelperTools/com.vpnvpn.daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/vpnvpn-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/vpnvpn-daemon.log</string>
</dict>
</plist>"#
}

/// Install the daemon using osascript for privilege elevation.
#[allow(dead_code)]
pub fn install_daemon_script(bundled_path: &str) -> String {
    format!(
        r#"do shell script "
            mkdir -p /Library/PrivilegedHelperTools &&
            cp '{}' /Library/PrivilegedHelperTools/com.vpnvpn.daemon &&
            chmod 755 /Library/PrivilegedHelperTools/com.vpnvpn.daemon &&
            chown root:wheel /Library/PrivilegedHelperTools/com.vpnvpn.daemon &&
            cat > /Library/LaunchDaemons/com.vpnvpn.daemon.plist << 'PLIST'
{}
PLIST
            chmod 644 /Library/LaunchDaemons/com.vpnvpn.daemon.plist &&
            launchctl load /Library/LaunchDaemons/com.vpnvpn.daemon.plist
        " with administrator privileges"#,
        bundled_path,
        launchdaemon_plist()
    )
}

/// Uninstall the daemon.
#[allow(dead_code)]
pub fn uninstall_daemon_script() -> &'static str {
    r#"do shell script "
        launchctl unload /Library/LaunchDaemons/com.vpnvpn.daemon.plist 2>/dev/null || true &&
        rm -f /Library/LaunchDaemons/com.vpnvpn.daemon.plist &&
        rm -f /Library/PrivilegedHelperTools/com.vpnvpn.daemon &&
        rm -f /var/run/vpnvpn-daemon.sock
    " with administrator privileges"#
}

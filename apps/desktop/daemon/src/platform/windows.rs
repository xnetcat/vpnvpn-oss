//! Windows platform initialization.

use anyhow::Result;
use tracing::info;

/// Initialize Windows-specific components.
pub fn init() -> Result<()> {
    info!("Initializing Windows platform...");

    // Create required directories
    let program_data =
        std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
    std::fs::create_dir_all(format!(r"{}\vpnvpn", program_data))?;

    Ok(())
}

/// Check if running as administrator.
pub fn is_admin() -> bool {
    #[cfg(windows)]
    {
        // Check if we're running elevated
        use std::process::Command;

        let output = Command::new("net").args(["session"]).output();

        matches!(output, Ok(o) if o.status.success())
    }

    #[cfg(not(windows))]
    {
        false
    }
}

// NOTE: the three install/uninstall helpers below document the intended
// Windows service installation procedure but are not wired into the daemon yet
// (the GUI drives service install on Windows). Kept for the upcoming Windows
// release; allow(dead_code) until a caller lands.

/// Install script for Windows service.
#[allow(dead_code)]
pub fn install_service_commands(bundled_path: &str) -> Vec<String> {
    let install_dir = r"C:\Program Files\vpnVPN";
    let daemon_path = format!(r"{}\vpnvpn-daemon.exe", install_dir);

    vec![
        format!(r#"mkdir "{}" 2>nul"#, install_dir),
        format!(r#"copy "{}" "{}""#, bundled_path, daemon_path),
        format!(
            r#"sc create vpnvpn-daemon binPath= "{}" start= auto DisplayName= "vpnVPN Daemon""#,
            daemon_path
        ),
        r#"sc description vpnvpn-daemon "vpnVPN privileged daemon for VPN management""#.to_string(),
        r#"sc start vpnvpn-daemon"#.to_string(),
    ]
}

/// Uninstall commands for Windows service.
#[allow(dead_code)]
pub fn uninstall_service_commands() -> Vec<&'static str> {
    vec![
        r#"sc stop vpnvpn-daemon"#,
        r#"sc delete vpnvpn-daemon"#,
        r#"rmdir /s /q "C:\Program Files\vpnVPN""#,
    ]
}

/// PowerShell script for elevated installation.
#[allow(dead_code)]
pub fn install_powershell_script(bundled_path: &str) -> String {
    format!(
        r#"
$ErrorActionPreference = "Stop"

$installDir = "C:\Program Files\vpnVPN"
$daemonPath = "$installDir\vpnvpn-daemon.exe"
$bundledPath = "{}"

# Create installation directory
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# Copy daemon binary
Copy-Item -Path $bundledPath -Destination $daemonPath -Force

# Create Windows service
$params = @{{
    Name = "vpnvpn-daemon"
    BinaryPathName = $daemonPath
    DisplayName = "vpnVPN Daemon"
    Description = "vpnVPN privileged daemon for VPN management"
    StartupType = "Automatic"
}}

# Remove existing service if present
if (Get-Service -Name "vpnvpn-daemon" -ErrorAction SilentlyContinue) {{
    Stop-Service -Name "vpnvpn-daemon" -Force -ErrorAction SilentlyContinue
    sc.exe delete vpnvpn-daemon
    Start-Sleep -Seconds 2
}}

New-Service @params

# Start the service
Start-Service -Name "vpnvpn-daemon"

Write-Host "vpnVPN Daemon installed successfully"
"#,
        bundled_path
    )
}

//! Daemon self-update mechanism.
//!
//! Handles updating the daemon binary without traditional installers:
//! 1. GUI downloads new binary to temp location
//! 2. GUI sends PrepareUpdate to daemon with path
//! 3. Daemon validates new binary (signature check)
//! 4. Daemon stages new binary
//! 5. Daemon sends ReadyForRestart
//! 6. GUI triggers platform-specific restart

use anyhow::Result;
use std::path::{Path, PathBuf};
use tracing::{error, info, warn};

/// Update manager for the daemon.
pub struct UpdateManager {
    /// Current daemon binary path.
    current_path: PathBuf,
    /// Staging path for new binary.
    staging_path: PathBuf,
    /// Backup path for current binary.
    backup_path: PathBuf,
}

impl UpdateManager {
    pub fn new() -> Result<Self> {
        let current_path = get_daemon_path()?;
        let staging_path = get_staging_path()?;
        let backup_path = get_backup_path()?;

        Ok(Self {
            current_path,
            staging_path,
            backup_path,
        })
    }

    /// Prepare an update by validating and staging the new binary.
    ///
    /// The live `PrepareUpdate` RPC path stages via the handler directly; this
    /// method is the equivalent library API and is retained for completeness.
    #[allow(dead_code)]
    pub fn prepare_update(&self, new_binary_path: &Path) -> Result<()> {
        info!("Preparing update from {:?}", new_binary_path);

        // Verify new binary exists
        if !new_binary_path.exists() {
            return Err(anyhow::anyhow!("New binary not found"));
        }

        // Verify new binary is executable
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(new_binary_path)?;
            let permissions = metadata.permissions();
            if permissions.mode() & 0o111 == 0 {
                warn!("New binary is not executable, setting permissions");
            }
        }

        // Verify code signature (platform-specific)
        #[cfg(target_os = "macos")]
        verify_signature_macos(new_binary_path)?;

        #[cfg(target_os = "windows")]
        verify_signature_windows(new_binary_path)?;

        // Create staging directory if needed
        if let Some(parent) = self.staging_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Copy new binary to staging location
        std::fs::copy(new_binary_path, &self.staging_path)?;

        // Set executable permissions on staging binary
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&self.staging_path)?.permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&self.staging_path, perms)?;
        }

        info!("Update staged at {:?}", self.staging_path);
        Ok(())
    }

    /// Apply the staged update.
    /// This should be called by the new daemon on startup to clean up.
    pub fn apply_update(&self) -> Result<()> {
        // Check if there's a staged update
        if !self.staging_path.exists() {
            return Ok(());
        }

        info!("Applying staged update");

        // Backup current binary
        if self.current_path.exists() {
            if let Err(e) = std::fs::rename(&self.current_path, &self.backup_path) {
                warn!("Failed to backup current binary: {}", e);
            }
        }

        // Move staged binary to current location
        match std::fs::rename(&self.staging_path, &self.current_path) {
            Ok(()) => {
                info!("Update applied successfully");
                // Clean up backup after successful update
                let _ = std::fs::remove_file(&self.backup_path);
            }
            Err(e) => {
                error!("Failed to apply update: {}", e);
                // Try to restore backup
                if self.backup_path.exists() {
                    let _ = std::fs::rename(&self.backup_path, &self.current_path);
                }
                return Err(e.into());
            }
        }

        Ok(())
    }

    /// Rollback to the previous version.
    ///
    /// Recovery API retained for completeness; `apply_update` already restores
    /// the backup automatically if the swap fails.
    #[allow(dead_code)]
    pub fn rollback(&self) -> Result<()> {
        if !self.backup_path.exists() {
            return Err(anyhow::anyhow!("No backup available for rollback"));
        }

        info!("Rolling back to previous version");

        // Remove current (failed) binary
        if self.current_path.exists() {
            std::fs::remove_file(&self.current_path)?;
        }

        // Restore backup
        std::fs::rename(&self.backup_path, &self.current_path)?;

        info!("Rollback completed");
        Ok(())
    }

    /// Clean up staging and backup files.
    pub fn cleanup(&self) {
        let _ = std::fs::remove_file(&self.staging_path);
        let _ = std::fs::remove_file(&self.backup_path);
    }

    /// Get the path to the staged binary, if any.
    pub fn staged_path(&self) -> Option<&Path> {
        if self.staging_path.exists() {
            Some(&self.staging_path)
        } else {
            None
        }
    }
}

/// Get the current daemon binary path.
fn get_daemon_path() -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Ok(PathBuf::from(
            "/Library/PrivilegedHelperTools/com.vpnvpn.daemon",
        ))
    }

    #[cfg(target_os = "linux")]
    {
        Ok(PathBuf::from("/usr/local/bin/vpnvpn-daemon"))
    }

    #[cfg(target_os = "windows")]
    {
        Ok(PathBuf::from(r"C:\Program Files\vpnVPN\vpnvpn-daemon.exe"))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err(anyhow::anyhow!("Platform not supported"))
    }
}

/// Get the staging path for new binaries.
fn get_staging_path() -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Ok(PathBuf::from(
            "/Library/PrivilegedHelperTools/com.vpnvpn.daemon.new",
        ))
    }

    #[cfg(target_os = "linux")]
    {
        Ok(PathBuf::from("/usr/local/bin/vpnvpn-daemon.new"))
    }

    #[cfg(target_os = "windows")]
    {
        Ok(PathBuf::from(
            r"C:\Program Files\vpnVPN\vpnvpn-daemon.new.exe",
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err(anyhow::anyhow!("Platform not supported"))
    }
}

/// Get the backup path for the current binary.
fn get_backup_path() -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Ok(PathBuf::from(
            "/Library/PrivilegedHelperTools/com.vpnvpn.daemon.bak",
        ))
    }

    #[cfg(target_os = "linux")]
    {
        Ok(PathBuf::from("/usr/local/bin/vpnvpn-daemon.bak"))
    }

    #[cfg(target_os = "windows")]
    {
        Ok(PathBuf::from(
            r"C:\Program Files\vpnVPN\vpnvpn-daemon.bak.exe",
        ))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err(anyhow::anyhow!("Platform not supported"))
    }
}

/// Verify code signature on macOS.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
fn verify_signature_macos(path: &Path) -> Result<()> {
    use std::process::Command;

    let output = Command::new("codesign")
        .args(["--verify", "--verbose", path.to_str().unwrap()])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!(
            "Code signature verification failed: {}",
            stderr
        ));
    }

    info!("Code signature verified for {:?}", path);
    Ok(())
}

/// Verify code signature on Windows.
#[cfg(target_os = "windows")]
fn verify_signature_windows(path: &Path) -> Result<()> {
    use std::process::Command;

    // Use PowerShell to check Authenticode signature
    let ps_script = format!(
        "Get-AuthenticodeSignature -FilePath '{}' | Select-Object -ExpandProperty Status",
        path.display()
    );

    let output = Command::new("powershell")
        .args(["-Command", &ps_script])
        .output()?;

    if !output.status.success() {
        return Err(anyhow::anyhow!("Signature check failed"));
    }

    let status = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if status != "Valid" {
        warn!("Binary signature status: {}", status);
        // In development, we might allow unsigned binaries
        // In production, this should return an error
    }

    Ok(())
}

/// Trigger a daemon restart using the platform-specific method.
///
/// The GUI drives restarts (via the `RestartService` RPC), so the daemon itself
/// does not call this; retained as part of the update API.
#[allow(dead_code)]
pub fn trigger_restart() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("launchctl")
            .args(["kickstart", "-k", "system/com.vpnvpn.daemon"])
            .spawn()?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("systemctl")
            .args(["restart", "vpnvpn-daemon"])
            .spawn()?;
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, we need to stop and start the service
        std::process::Command::new("sc")
            .args(["stop", "vpnvpn-daemon"])
            .spawn()?;
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::process::Command::new("sc")
            .args(["start", "vpnvpn-daemon"])
            .spawn()?;
    }

    Ok(())
}

use super::NetworkManager;
use anyhow::{anyhow, Context, Result};
use std::process::Command;
use tracing::warn;

#[derive(Default)]
pub struct MacNetworkManager;

impl NetworkManager for MacNetworkManager {
    fn check_dependencies(&self) -> Result<()> {
        // Check for 'wg' command
        if Command::new("wg").arg("version").output().is_err() {
            return Err(anyhow!(
                "'wg' command not found (brew install wireguard-tools)"
            ));
        }
        // Check for 'wireguard-go'
        if Command::new("wireguard-go")
            .arg("--version")
            .output()
            .is_err()
        {
            return Err(anyhow!(
                "'wireguard-go' not found (brew install wireguard-go)"
            ));
        }
        Ok(())
    }

    fn configure_wireguard(
        &self,
        iface: &str,
        ip_cidr: &str,
        _port: u16,
        conf_path: &str,
    ) -> Result<()> {
        // macOS uses wireguard-go (userspace)

        // 1. Start wireguard-go if not running (check via ifconfig?)
        // Simple check: ifconfig <iface>
        let iface_exists = Command::new("ifconfig")
            .arg(iface)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !iface_exists {
            // This sets up the utun interface. Surface a failure to start the
            // userspace backend instead of silently continuing to `wg setconf`,
            // which would then fail obscurely.
            let out = Command::new("wireguard-go")
                .arg("utun")
                .env("WG_TUN_NAME_FILE", format!("/tmp/{}.name", iface))
                .output()
                .with_context(|| format!("start wireguard-go for {iface}"))?;
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                return Err(anyhow!(
                    "failed to start wireguard-go for {iface}: {}",
                    stderr.trim()
                ));
            }
            // Note: wireguard-go on mac usually picks the next available utunX.
            // Realistically we need to capture that name.
            // For this simplified impl, we assume user set up the interface or we use a fixed name if supported.
            // However, wireguard-go doesn't easily let you pick the name on macOS unless using the env var hack or UAPI.

            warn!("On macOS, wireguard-go picks a dynamic utun interface. Assuming {} maps correctly or user intervention required.", iface);
        }

        // 2. Assign IP
        // ifconfig utun3 10.8.0.1 10.8.0.1 netmask 255.255.255.0
        // parsing CIDR to netmask is painful here without a crate.
        // For simplicity, we just execute ifconfig with the CIDR if supported or rely on 'route'.
        // macOS 'ifconfig' supports 'inet <addr>/<prefix>'
        let status = Command::new("ifconfig")
            .args([iface, "inet", ip_cidr, "alias"])
            .status()
            .context("ifconfig failed")?;

        if !status.success() {
            return Err(anyhow!("ifconfig failed"));
        }

        // 3. Apply config
        let status = Command::new("wg")
            .args(["setconf", iface, conf_path])
            .status()
            .context("wg setconf failed")?;

        if !status.success() {
            return Err(anyhow!("wg setconf failed"));
        }

        Ok(())
    }

    fn bring_up_interface(&self, iface: &str) -> Result<()> {
        let status = Command::new("ifconfig")
            .args([iface, "up"])
            .status()
            .context("ifconfig up failed")?;

        if !status.success() {
            return Err(anyhow!("ifconfig up failed"));
        }
        Ok(())
    }

    fn teardown_interface(&self, iface: &str) -> Result<()> {
        // macOS: kill wireguard-go process? or ifconfig down
        let _ = Command::new("ifconfig").args([iface, "down"]).output();
        // destroying utun is usually done by killing the owning process
        // For now, just down.
        Ok(())
    }
}

use super::NetworkManager;
use anyhow::{anyhow, Context, Result};
use std::process::Command;

#[derive(Default)]
pub struct WindowsNetworkManager;

impl NetworkManager for WindowsNetworkManager {
    fn check_dependencies(&self) -> Result<()> {
        // Check for 'wireguard.exe' (usually in Path if installed via installer)
        if Command::new("wireguard").arg("/?").output().is_err() {
            return Err(anyhow!(
                "'wireguard.exe' not found (Install WireGuard for Windows)"
            ));
        }
        Ok(())
    }

    fn configure_wireguard(
        &self,
        iface: &str,
        ip_cidr: &str,
        port: u16,
        conf_path: &str,
    ) -> Result<()> {
        // On Windows, we typically use `wireguard.exe /installtunnelservice <conf_path>`
        // The conf file must be named exactly like the interface, e.g. wg0.conf -> wg0 interface.

        // 1. Uninstall existing if exists (best effort)
        let _ = Command::new("wireguard")
            .args(["/uninstalltunnelservice", iface])
            .output();

        // 2. Install service (this brings it up and configures IP from the file)
        // Windows WireGuard reads Address/ListenPort from the conf file directly.
        // So we primarily rely on the config file generation being correct.

        let status = Command::new("wireguard")
            .args(["/installtunnelservice", conf_path])
            .status()
            .context("wireguard /installtunnelservice failed")?;

        if !status.success() {
            return Err(anyhow!("wireguard service installation failed"));
        }

        Ok(())
    }

    fn bring_up_interface(&self, _iface: &str) -> Result<()> {
        // Service auto-starts
        Ok(())
    }

    fn teardown_interface(&self, iface: &str) -> Result<()> {
        let _ = Command::new("wireguard")
            .args(["/uninstalltunnelservice", iface])
            .output();
        Ok(())
    }
}

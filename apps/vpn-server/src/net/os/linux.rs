use super::NetworkManager;
use anyhow::{anyhow, Context, Result};
use std::process::Command;
use tracing::info;

#[derive(Default)]
pub struct LinuxNetworkManager;

impl NetworkManager for LinuxNetworkManager {
    fn check_dependencies(&self) -> Result<()> {
        // Check for 'ip' command
        if Command::new("ip").arg("-V").output().is_err() {
            return Err(anyhow!("'ip' command not found (install iproute2)"));
        }
        // Check for 'wg' command
        if Command::new("wg").arg("version").output().is_err() {
            return Err(anyhow!("'wg' command not found (install wireguard-tools)"));
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
        // On Linux, we use a mix of manual interface creation (for userspace go) or kernel module.
        // We assume userspace or kernel module is loaded.

        // 1. Check if iface exists, if not start wireguard-go if available
        let iface_exists = Command::new("ip")
            .args(["link", "show", iface])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        if !iface_exists {
            // Try wireguard-go (userspace) first; fall back to the kernel module.
            // Surface the failure if neither path can create the interface, instead
            // of silently continuing and then failing obscurely at `wg setconf`.
            match Command::new("wireguard-go").arg(iface).spawn() {
                Ok(_) => info!("Started wireguard-go userspace backend"),
                Err(go_err) => {
                    let out = Command::new("ip")
                        .args(["link", "add", iface, "type", "wireguard"])
                        .output()
                        .with_context(|| {
                            format!(
                                "create interface {iface}: wireguard-go failed ({go_err}) and \
                                 `ip link add` could not be executed"
                            )
                        })?;
                    if !out.status.success() {
                        let stderr = String::from_utf8_lossy(&out.stderr);
                        return Err(anyhow!(
                            "failed to create wireguard interface {iface} \
                             (wireguard-go unavailable: {go_err}; ip link add: {})",
                            stderr.trim()
                        ));
                    }
                }
            }
        }

        // 2. Assign IP. Treat "already assigned" as success so re-runs are idempotent.
        let addr_out = Command::new("ip")
            .args(["address", "add", ip_cidr, "dev", iface])
            .output()
            .with_context(|| format!("assign address {ip_cidr} to {iface}"))?;
        if !addr_out.status.success() {
            let stderr = String::from_utf8_lossy(&addr_out.stderr);
            if stderr.contains("File exists") {
                info!(iface, ip_cidr, "address_already_assigned");
            } else {
                return Err(anyhow!(
                    "failed to assign address {ip_cidr} to {iface}: {}",
                    stderr.trim()
                ));
            }
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
        let status = Command::new("ip")
            .args(["link", "set", "up", "dev", iface])
            .status()
            .context("ip link set up failed")?;

        if !status.success() {
            return Err(anyhow!("ip link set up failed"));
        }
        Ok(())
    }

    fn teardown_interface(&self, iface: &str) -> Result<()> {
        let _ = Command::new("ip")
            .args(["link", "set", "down", "dev", iface])
            .output();
        let _ = Command::new("ip")
            .args(["link", "del", "dev", iface])
            .output();
        Ok(())
    }
}

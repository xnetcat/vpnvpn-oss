#[cfg(test)]
use super::NetworkManager;
#[cfg(test)]
use anyhow::{anyhow, Result};

#[cfg(test)]
struct MockNetworkManager {
    // Simulate different OSs via a flag or just generic mock
    os_type: String,
}

#[cfg(test)]
impl NetworkManager for MockNetworkManager {
    fn check_dependencies(&self) -> Result<()> {
        if self.os_type == "unsupported" {
            Err(anyhow!("unsupported"))
        } else {
            Ok(())
        }
    }
    fn configure_wireguard(
        &self,
        _iface: &str,
        _ip_cidr: &str,
        _port: u16,
        _conf_path: &str,
    ) -> Result<()> {
        // Just return ok for test
        Ok(())
    }
    fn bring_up_interface(&self, _iface: &str) -> Result<()> {
        Ok(())
    }
    fn teardown_interface(&self, _iface: &str) -> Result<()> {
        Ok(())
    }
}

#[test]
fn test_mock_manager_linux() {
    let nm = MockNetworkManager {
        os_type: "linux".into(),
    };
    assert!(nm.check_dependencies().is_ok());
    assert!(nm
        .configure_wireguard("wg0", "10.8.0.1/24", 51820, "/etc/wireguard/wg0.conf")
        .is_ok());
}

#[test]
fn test_mock_manager_windows() {
    let nm = MockNetworkManager {
        os_type: "windows".into(),
    };
    assert!(nm.check_dependencies().is_ok());
    assert!(nm
        .configure_wireguard("wg0", "10.8.0.1/24", 51820, "wg0.conf")
        .is_ok());
}

//! macOS firewall/kill-switch using pf (packet filter).

use anyhow::Result;
use tracing::{debug, info};

const PF_ANCHOR: &str = "com.vpnvpn";
const PF_ANCHOR_FILE: &str = "/etc/pf.anchors/com.vpnvpn";

/// Enable kill-switch using pf.
pub fn enable_kill_switch(
    vpn_interface: &str,
    allow_lan: bool,
    server_ip: Option<&str>,
) -> Result<()> {
    info!(
        "Enabling kill-switch for interface {} (allow_lan={}, server_ip={:?})",
        vpn_interface, allow_lan, server_ip
    );

    let rules = build_pf_rules(vpn_interface, allow_lan, server_ip);

    // Write rules to anchor file
    std::fs::write(PF_ANCHOR_FILE, &rules)?;

    debug!("PF rules written to {}", PF_ANCHOR_FILE);

    // Load the anchor
    let output = std::process::Command::new("pfctl")
        .args(["-a", PF_ANCHOR, "-f", PF_ANCHOR_FILE])
        .output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!("pfctl load failed: {}", stderr));
    }

    // Enable pf if not already enabled
    let _ = std::process::Command::new("pfctl").args(["-e"]).output();

    info!("Kill-switch enabled");
    Ok(())
}

/// Disable kill-switch.
pub fn disable_kill_switch() -> Result<()> {
    info!("Disabling kill-switch");

    // Flush the anchor
    let _ = std::process::Command::new("pfctl")
        .args(["-a", PF_ANCHOR, "-F", "all"])
        .output();

    // Remove anchor file
    let _ = std::fs::remove_file(PF_ANCHOR_FILE);

    info!("Kill-switch disabled");
    Ok(())
}

fn build_pf_rules(vpn_interface: &str, allow_lan: bool, server_ip: Option<&str>) -> String {
    let mut rules = String::new();

    // Header
    rules.push_str("# vpnVPN kill-switch rules\n");
    rules.push_str("# Generated automatically - do not edit\n\n");

    // Block all traffic by default
    rules.push_str("block drop all\n\n");

    // Allow loopback
    rules.push_str("# Allow loopback\n");
    rules.push_str("pass quick on lo0 all\n\n");

    // Allow VPN interface
    rules.push_str("# Allow VPN tunnel\n");
    rules.push_str(&format!("pass quick on {} all\n\n", vpn_interface));

    // Allow traffic to VPN server (for initial handshake)
    // Restrict to server IP when known to prevent leaks to arbitrary destinations
    let dest = server_ip.unwrap_or("any");
    rules.push_str("# Allow VPN protocols (to server only)\n");
    rules.push_str(&format!(
        "pass out quick proto udp to {} port 51820\n",
        dest
    )); // WireGuard
    rules.push_str(&format!("pass out quick proto udp to {} port 1194\n", dest)); // OpenVPN UDP
    rules.push_str(&format!("pass out quick proto tcp to {} port 1194\n", dest)); // OpenVPN TCP
    rules.push_str(&format!("pass out quick proto udp to {} port 500\n", dest)); // IKEv2/IPsec
    rules.push_str(&format!("pass out quick proto udp to {} port 4500\n", dest)); // IKEv2/IPsec NAT-T
    rules.push('\n');

    // Allow DHCP
    rules.push_str("# Allow DHCP\n");
    rules.push_str("pass out quick proto udp from any port 68 to any port 67\n");
    rules.push_str("pass in quick proto udp from any port 67 to any port 68\n\n");

    // Allow DNS to localhost (for local DNS resolver)
    rules.push_str("# Allow local DNS\n");
    rules.push_str("pass out quick proto udp to 127.0.0.1 port 53\n");
    rules.push_str("pass out quick proto tcp to 127.0.0.1 port 53\n\n");

    if allow_lan {
        rules.push_str("# Allow LAN access\n");
        // RFC1918 private address ranges
        rules.push_str("pass quick to 10.0.0.0/8\n");
        rules.push_str("pass quick to 172.16.0.0/12\n");
        rules.push_str("pass quick to 192.168.0.0/16\n");
        // Link-local
        rules.push_str("pass quick to 169.254.0.0/16\n");
        // Multicast/mDNS
        rules.push_str("pass quick to 224.0.0.0/4\n");
        rules.push_str("pass quick proto udp to any port 5353\n"); // mDNS
        rules.push('\n');
    }

    // Allow established connections
    rules.push_str("# Allow established connections\n");
    rules.push_str("pass in quick proto tcp flags S/SA keep state\n");
    rules.push_str("pass out quick proto tcp flags S/SA keep state\n");

    rules
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_pf_rules() {
        let rules = build_pf_rules("utun5", false, Some("1.2.3.4"));
        assert!(rules.contains("pass quick on utun5 all"));
        assert!(rules.contains("block drop all"));
        assert!(!rules.contains("192.168.0.0/16"));
        assert!(rules.contains("to 1.2.3.4 port 51820"));
        assert!(!rules.contains("to any port 51820"));
    }

    #[test]
    fn test_build_pf_rules_with_lan() {
        let rules = build_pf_rules("utun5", true, None);
        assert!(rules.contains("pass quick on utun5 all"));
        assert!(rules.contains("192.168.0.0/16"));
        assert!(rules.contains("10.0.0.0/8"));
        assert!(rules.contains("to any port 51820"));
    }
}

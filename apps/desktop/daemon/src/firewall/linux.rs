//! Linux firewall/kill-switch using nftables.

use anyhow::Result;
use tracing::{debug, info, warn};

const NFT_TABLE: &str = "vpnvpn_killswitch";

/// Enable kill-switch using nftables.
pub fn enable_kill_switch(
    vpn_interface: &str,
    allow_lan: bool,
    server_ip: Option<&str>,
) -> Result<()> {
    info!(
        "Enabling kill-switch for interface {} (allow_lan={}, server_ip={:?})",
        vpn_interface, allow_lan, server_ip
    );

    // First, try nftables
    if has_nftables() {
        enable_nftables(vpn_interface, allow_lan, server_ip)?;
    } else {
        // Fall back to iptables
        warn!("nftables not available, falling back to iptables");
        enable_iptables(vpn_interface, allow_lan, server_ip)?;
    }

    info!("Kill-switch enabled");
    Ok(())
}

/// Disable kill-switch.
pub fn disable_kill_switch() -> Result<()> {
    info!("Disabling kill-switch");

    if has_nftables() {
        disable_nftables()?;
    } else {
        disable_iptables()?;
    }

    info!("Kill-switch disabled");
    Ok(())
}

fn has_nftables() -> bool {
    std::process::Command::new("nft")
        .args(["--version"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn enable_nftables(vpn_interface: &str, allow_lan: bool, server_ip: Option<&str>) -> Result<()> {
    let rules = build_nftables_rules(vpn_interface, allow_lan, server_ip);

    debug!("Applying nftables rules:\n{}", rules);

    // Apply rules via stdin
    let mut child = std::process::Command::new("nft")
        .arg("-f")
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .spawn()?;

    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin.write_all(rules.as_bytes())?;
    }

    let status = child.wait()?;
    if !status.success() {
        return Err(anyhow::anyhow!("nft command failed"));
    }

    Ok(())
}

fn disable_nftables() -> Result<()> {
    // Delete the table (and all its chains/rules)
    let _ = std::process::Command::new("nft")
        .args(["delete", "table", "inet", NFT_TABLE])
        .output();

    Ok(())
}

fn build_nftables_rules(vpn_interface: &str, allow_lan: bool, server_ip: Option<&str>) -> String {
    let mut rules = String::new();

    // Delete existing table if present (flush first, then delete to avoid nft parse errors)
    rules.push_str(&format!("flush table inet {} ;\n", NFT_TABLE));
    rules.push_str(&format!("delete table inet {} ;\n", NFT_TABLE));

    // Create table
    rules.push_str(&format!("table inet {} {{\n", NFT_TABLE));

    // Output chain
    rules.push_str("    chain output {\n");
    rules.push_str("        type filter hook output priority 0; policy drop;\n\n");

    // Allow loopback
    rules.push_str("        # Allow loopback\n");
    rules.push_str("        oif lo accept\n\n");

    // Allow VPN interface
    rules.push_str("        # Allow VPN tunnel\n");
    rules.push_str(&format!("        oif {} accept\n\n", vpn_interface));

    // Allow VPN protocols (restricted to server IP when known)
    rules.push_str("        # Allow VPN protocols\n");
    if let Some(ip) = server_ip {
        rules.push_str(&format!("        ip daddr {} udp dport 51820 accept\n", ip));
        rules.push_str(&format!("        ip daddr {} udp dport 1194 accept\n", ip));
        rules.push_str(&format!("        ip daddr {} tcp dport 1194 accept\n", ip));
        rules.push_str(&format!("        ip daddr {} udp dport 500 accept\n", ip));
        rules.push_str(&format!(
            "        ip daddr {} udp dport 4500 accept\n\n",
            ip
        ));
    } else {
        rules.push_str("        udp dport 51820 accept  # WireGuard\n");
        rules.push_str("        udp dport 1194 accept   # OpenVPN UDP\n");
        rules.push_str("        tcp dport 1194 accept   # OpenVPN TCP\n");
        rules.push_str("        udp dport 500 accept    # IKEv2\n");
        rules.push_str("        udp dport 4500 accept   # IKEv2 NAT-T\n\n");
    }

    // Allow DHCP
    rules.push_str("        # Allow DHCP\n");
    rules.push_str("        udp sport 68 udp dport 67 accept\n\n");

    if allow_lan {
        rules.push_str("        # Allow LAN access\n");
        rules.push_str("        ip daddr 10.0.0.0/8 accept\n");
        rules.push_str("        ip daddr 172.16.0.0/12 accept\n");
        rules.push_str("        ip daddr 192.168.0.0/16 accept\n");
        rules.push_str("        ip daddr 169.254.0.0/16 accept\n");
        rules.push_str("        ip daddr 224.0.0.0/4 accept  # Multicast\n\n");
    }

    rules.push_str("    }\n\n");

    // Input chain
    rules.push_str("    chain input {\n");
    rules.push_str("        type filter hook input priority 0; policy drop;\n\n");
    rules.push_str("        # Allow loopback\n");
    rules.push_str("        iif lo accept\n\n");
    rules.push_str("        # Allow VPN tunnel\n");
    rules.push_str(&format!("        iif {} accept\n\n", vpn_interface));
    rules.push_str("        # Allow established connections\n");
    rules.push_str("        ct state established,related accept\n\n");

    if allow_lan {
        rules.push_str("        # Allow LAN access\n");
        rules.push_str("        ip saddr 10.0.0.0/8 accept\n");
        rules.push_str("        ip saddr 172.16.0.0/12 accept\n");
        rules.push_str("        ip saddr 192.168.0.0/16 accept\n\n");
    }

    rules.push_str("    }\n");
    rules.push_str("}\n");

    rules
}

// iptables fallback

fn enable_iptables(vpn_interface: &str, allow_lan: bool, server_ip: Option<&str>) -> Result<()> {
    // Create chains
    let _ = std::process::Command::new("iptables")
        .args(["-N", "VPNVPN_OUTPUT"])
        .output();

    let _ = std::process::Command::new("iptables")
        .args(["-N", "VPNVPN_INPUT"])
        .output();

    // Flush chains
    let _ = std::process::Command::new("iptables")
        .args(["-F", "VPNVPN_OUTPUT"])
        .output();

    let _ = std::process::Command::new("iptables")
        .args(["-F", "VPNVPN_INPUT"])
        .output();

    // Insert jumps at beginning of OUTPUT and INPUT chains
    let _ = std::process::Command::new("iptables")
        .args(["-I", "OUTPUT", "-j", "VPNVPN_OUTPUT"])
        .output();

    let _ = std::process::Command::new("iptables")
        .args(["-I", "INPUT", "-j", "VPNVPN_INPUT"])
        .output();

    // OUTPUT rules
    let mut output_rules: Vec<Vec<&str>> = vec![
        vec!["-A", "VPNVPN_OUTPUT", "-o", "lo", "-j", "ACCEPT"],
        vec!["-A", "VPNVPN_OUTPUT", "-o", vpn_interface, "-j", "ACCEPT"],
    ];

    // VPN protocol port rules — restrict to server IP when known
    let ports = ["51820", "1194", "500", "4500"];
    let protos = ["udp", "udp", "udp", "udp"];
    for (port, proto) in ports.iter().zip(protos.iter()) {
        if let Some(ip) = server_ip {
            output_rules.push(vec![
                "-A",
                "VPNVPN_OUTPUT",
                "-d",
                ip,
                "-p",
                proto,
                "--dport",
                port,
                "-j",
                "ACCEPT",
            ]);
        } else {
            output_rules.push(vec![
                "-A",
                "VPNVPN_OUTPUT",
                "-p",
                proto,
                "--dport",
                port,
                "-j",
                "ACCEPT",
            ]);
        }
    }

    for rule in &output_rules {
        std::process::Command::new("iptables").args(rule).output()?;
    }

    if allow_lan {
        for cidr in ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"] {
            std::process::Command::new("iptables")
                .args(["-A", "VPNVPN_OUTPUT", "-d", cidr, "-j", "ACCEPT"])
                .output()?;
        }
    }

    // Default drop
    std::process::Command::new("iptables")
        .args(["-A", "VPNVPN_OUTPUT", "-j", "DROP"])
        .output()?;

    // INPUT rules
    std::process::Command::new("iptables")
        .args(["-A", "VPNVPN_INPUT", "-i", "lo", "-j", "ACCEPT"])
        .output()?;

    std::process::Command::new("iptables")
        .args(["-A", "VPNVPN_INPUT", "-i", vpn_interface, "-j", "ACCEPT"])
        .output()?;

    std::process::Command::new("iptables")
        .args([
            "-A",
            "VPNVPN_INPUT",
            "-m",
            "state",
            "--state",
            "ESTABLISHED,RELATED",
            "-j",
            "ACCEPT",
        ])
        .output()?;

    std::process::Command::new("iptables")
        .args(["-A", "VPNVPN_INPUT", "-j", "DROP"])
        .output()?;

    Ok(())
}

fn disable_iptables() -> Result<()> {
    // Remove jumps
    let _ = std::process::Command::new("iptables")
        .args(["-D", "OUTPUT", "-j", "VPNVPN_OUTPUT"])
        .output();

    let _ = std::process::Command::new("iptables")
        .args(["-D", "INPUT", "-j", "VPNVPN_INPUT"])
        .output();

    // Flush and delete chains
    let _ = std::process::Command::new("iptables")
        .args(["-F", "VPNVPN_OUTPUT"])
        .output();

    let _ = std::process::Command::new("iptables")
        .args(["-X", "VPNVPN_OUTPUT"])
        .output();

    let _ = std::process::Command::new("iptables")
        .args(["-F", "VPNVPN_INPUT"])
        .output();

    let _ = std::process::Command::new("iptables")
        .args(["-X", "VPNVPN_INPUT"])
        .output();

    Ok(())
}

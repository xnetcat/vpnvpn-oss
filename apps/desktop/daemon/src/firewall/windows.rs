//! Windows firewall/kill-switch using Windows Filtering Platform (WFP).

use anyhow::Result;
use tracing::info;

/// Enable kill-switch on Windows.
pub fn enable_kill_switch(vpn_interface: &str, allow_lan: bool) -> Result<()> {
    info!(
        "Enabling kill-switch for interface {} (allow_lan={})",
        vpn_interface, allow_lan
    );

    // Use Windows Firewall (netsh) as a simpler alternative to WFP
    // WFP requires more complex setup

    // Block all outbound except VPN
    enable_netsh_rules(vpn_interface, allow_lan)?;

    info!("Kill-switch enabled");
    Ok(())
}

/// Disable kill-switch on Windows.
pub fn disable_kill_switch() -> Result<()> {
    info!("Disabling kill-switch");

    disable_netsh_rules()?;

    info!("Kill-switch disabled");
    Ok(())
}

// The interface name is currently unused: rules match generic VPN adapter
// patterns (TAP-*/wg*/tun*) below instead of the specific interface GUID.
fn enable_netsh_rules(_vpn_interface: &str, allow_lan: bool) -> Result<()> {
    // Delete existing rules first
    let _ = disable_netsh_rules();

    // Create firewall rules using netsh

    // Block all outbound traffic
    std::process::Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "add",
            "rule",
            "name=vpnVPN-KillSwitch-BlockAll",
            "dir=out",
            "action=block",
            "enable=yes",
        ])
        .output()?;

    // Allow VPN protocols
    let vpn_ports = [
        ("51820", "udp", "WireGuard"),
        ("1194", "udp", "OpenVPN-UDP"),
        ("1194", "tcp", "OpenVPN-TCP"),
        ("500", "udp", "IKEv2"),
        ("4500", "udp", "IKEv2-NAT"),
    ];

    for (port, proto, name) in vpn_ports {
        std::process::Command::new("netsh")
            .args([
                "advfirewall",
                "firewall",
                "add",
                "rule",
                &format!("name=vpnVPN-KillSwitch-Allow-{}", name),
                "dir=out",
                "action=allow",
                &format!("protocol={}", proto),
                &format!("remoteport={}", port),
                "enable=yes",
            ])
            .output()?;
    }

    // Allow loopback
    std::process::Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "add",
            "rule",
            "name=vpnVPN-KillSwitch-AllowLoopback",
            "dir=out",
            "action=allow",
            "remoteip=127.0.0.0/8",
            "enable=yes",
        ])
        .output()?;

    // Allow DHCP
    std::process::Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "add",
            "rule",
            "name=vpnVPN-KillSwitch-AllowDHCP",
            "dir=out",
            "action=allow",
            "protocol=udp",
            "localport=68",
            "remoteport=67",
            "enable=yes",
        ])
        .output()?;

    if allow_lan {
        // Allow LAN traffic
        let lan_ranges = [
            "10.0.0.0/8",
            "172.16.0.0/12",
            "192.168.0.0/16",
            "169.254.0.0/16",
        ];

        for (i, range) in lan_ranges.iter().enumerate() {
            std::process::Command::new("netsh")
                .args([
                    "advfirewall",
                    "firewall",
                    "add",
                    "rule",
                    &format!("name=vpnVPN-KillSwitch-AllowLAN-{}", i),
                    "dir=out",
                    "action=allow",
                    &format!("remoteip={}", range),
                    "enable=yes",
                ])
                .output()?;
        }
    }

    // Allow traffic on VPN interface (by interface name or all TAP/TUN adapters)
    // This is tricky because we need to identify the interface GUID
    // For now, allow all traffic on common VPN adapter names
    for adapter_pattern in ["TAP-*", "wg*", "tun*"] {
        let _ = std::process::Command::new("netsh")
            .args([
                "advfirewall",
                "firewall",
                "add",
                "rule",
                &format!("name=vpnVPN-KillSwitch-AllowVPN-{}", adapter_pattern),
                "dir=out",
                "action=allow",
                &format!("interfacetype={}", adapter_pattern),
                "enable=yes",
            ])
            .output();
    }

    Ok(())
}

fn disable_netsh_rules() -> Result<()> {
    // Delete all vpnVPN kill-switch rules
    let output = std::process::Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "show",
            "rule",
            "name=all",
            "dir=out",
        ])
        .output()?;

    let rules = String::from_utf8_lossy(&output.stdout);

    // Find and delete all vpnVPN rules
    for line in rules.lines() {
        if line.contains("vpnVPN-KillSwitch") {
            // Extract rule name
            if let Some(name) = line.strip_prefix("Rule Name:") {
                let name = name.trim();
                let _ = std::process::Command::new("netsh")
                    .args([
                        "advfirewall",
                        "firewall",
                        "delete",
                        "rule",
                        &format!("name={}", name),
                    ])
                    .output();
            }
        }
    }

    // Also try deleting by known names
    let known_rules = [
        "vpnVPN-KillSwitch-BlockAll",
        "vpnVPN-KillSwitch-AllowLoopback",
        "vpnVPN-KillSwitch-AllowDHCP",
        "vpnVPN-KillSwitch-Allow-WireGuard",
        "vpnVPN-KillSwitch-Allow-OpenVPN-UDP",
        "vpnVPN-KillSwitch-Allow-OpenVPN-TCP",
        "vpnVPN-KillSwitch-Allow-IKEv2",
        "vpnVPN-KillSwitch-Allow-IKEv2-NAT",
        "vpnVPN-KillSwitch-AllowLAN-0",
        "vpnVPN-KillSwitch-AllowLAN-1",
        "vpnVPN-KillSwitch-AllowLAN-2",
        "vpnVPN-KillSwitch-AllowLAN-3",
    ];

    for rule in known_rules {
        let _ = std::process::Command::new("netsh")
            .args([
                "advfirewall",
                "firewall",
                "delete",
                "rule",
                &format!("name={}", rule),
            ])
            .output();
    }

    Ok(())
}

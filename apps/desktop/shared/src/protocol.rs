//! VPN protocol definitions.

use serde::{Deserialize, Serialize};

/// Supported VPN protocols.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    WireGuard,
    OpenVPN,
    IKEv2,
}

impl std::fmt::Display for Protocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Protocol::WireGuard => write!(f, "wireguard"),
            Protocol::OpenVPN => write!(f, "openvpn"),
            Protocol::IKEv2 => write!(f, "ikev2"),
        }
    }
}

impl std::str::FromStr for Protocol {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "wireguard" | "wg" => Ok(Protocol::WireGuard),
            "openvpn" | "ovpn" => Ok(Protocol::OpenVPN),
            "ikev2" | "ipsec" => Ok(Protocol::IKEv2),
            _ => Err(format!("Unknown protocol: {}", s)),
        }
    }
}

/// VPN connection status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    #[default]
    Disconnected,
    Connecting,
    Connected,
    Disconnecting,
    Reconnecting,
    Error,
    /// macOS IKEv2 only: the VPN profile (.mobileconfig) has been handed to the
    /// user but is not yet approved in System Settings. Not an error — the GUI
    /// should show an instruction + retry affordance. Once the user approves the
    /// profile, subsequent connects drive the built-in client via `scutil --nc`.
    #[serde(rename = "pending_approval")]
    PendingApproval,
}

/// Detailed connection status information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStatus {
    pub state: ConnectionState,
    pub protocol: Option<Protocol>,
    pub server_id: Option<String>,
    pub server_region: Option<String>,
    pub interface_name: Option<String>,
    pub assigned_ip: Option<String>,
    pub connected_at: Option<chrono::DateTime<chrono::Utc>>,
    pub bytes_sent: Option<u64>,
    pub bytes_received: Option<u64>,
    pub last_handshake: Option<chrono::DateTime<chrono::Utc>>,
}

impl Default for ConnectionStatus {
    fn default() -> Self {
        Self {
            state: ConnectionState::Disconnected,
            protocol: None,
            server_id: None,
            server_region: None,
            interface_name: None,
            assigned_ip: None,
            connected_at: None,
            bytes_sent: None,
            bytes_received: None,
            last_handshake: None,
        }
    }
}

/// VPN configuration for a connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpnConfig {
    pub protocol: Protocol,
    pub server_id: String,
    pub server_region: String,
    pub server_endpoint: String,
    pub server_port: u16,

    // WireGuard-specific
    pub wg_private_key: Option<String>,
    pub wg_public_key: Option<String>,
    pub wg_server_public_key: Option<String>,
    pub wg_preshared_key: Option<String>,

    // Assigned IP from server
    pub assigned_ip: Option<String>,

    // OpenVPN-specific
    pub ovpn_config: Option<String>,

    // IKEv2-specific
    pub ikev2_identity: Option<String>,
    pub ikev2_remote_id: Option<String>,

    // Generic credentials (OpenVPN/IKEv2)
    pub username: Option<String>,
    pub password: Option<String>,

    // DNS settings
    pub dns_servers: Vec<String>,
}

impl Default for VpnConfig {
    fn default() -> Self {
        Self {
            protocol: Protocol::WireGuard,
            server_id: String::new(),
            server_region: String::new(),
            server_endpoint: String::new(),
            server_port: 51820,
            wg_private_key: None,
            wg_public_key: None,
            wg_server_public_key: None,
            wg_preshared_key: None,
            assigned_ip: None,
            ovpn_config: None,
            ikev2_identity: None,
            ikev2_remote_id: None,
            username: None,
            password: None,
            dns_servers: vec!["1.1.1.1".to_string(), "1.0.0.1".to_string()],
        }
    }
}

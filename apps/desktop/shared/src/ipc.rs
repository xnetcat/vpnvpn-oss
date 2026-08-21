//! IPC message types for GUI-daemon communication.
//!
//! Uses a JSON-RPC 2.0-like protocol over platform-specific transports:
//! - macOS/Linux: Unix Domain Socket at /var/run/vpnvpn-daemon.sock
//! - Windows: Named Pipe at \\.\pipe\vpnvpn-daemon

use crate::{
    config::{DaemonSettings, DaemonStatus},
    error::IpcError,
    protocol::{ConnectionStatus, VpnConfig},
};
use serde::{Deserialize, Serialize};

/// IPC socket/pipe paths.
pub mod paths {
    /// Unix domain socket path (macOS/Linux).
    #[cfg(unix)]
    pub const SOCKET_PATH: &str = "/var/run/vpnvpn-daemon.sock";

    /// Named pipe path (Windows).
    #[cfg(windows)]
    pub const PIPE_NAME: &str = r"\\.\pipe\vpnvpn-daemon";

    /// Nonce file path for authentication.
    #[cfg(unix)]
    pub fn nonce_path() -> std::path::PathBuf {
        std::path::PathBuf::from("/var/run/vpnvpn-daemon.nonce")
    }

    #[cfg(windows)]
    pub fn nonce_path() -> std::path::PathBuf {
        std::path::PathBuf::from(r"C:\ProgramData\vpnvpn\daemon.nonce")
    }
}

/// JSON-RPC 2.0 request wrapper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    pub params: serde_json::Value,
    /// Optional session token established via the challenge-response handshake
    /// (`RequestChallenge` -> `Authenticate`). Privileged methods require a
    /// valid token here; open methods (ping, status, handshake) ignore it.
    /// Omitted on the wire when absent so older peers stay compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
}

impl JsonRpcRequest {
    pub fn new(id: u64, request: DaemonRequest) -> Self {
        let (method, params) = match &request {
            DaemonRequest::GetStatus => ("get_status", serde_json::Value::Null),
            DaemonRequest::Connect { .. } => ("connect", serde_json::to_value(&request).unwrap()),
            DaemonRequest::Disconnect => ("disconnect", serde_json::Value::Null),
            DaemonRequest::GetConnectionStatus => {
                ("get_connection_status", serde_json::Value::Null)
            }
            DaemonRequest::EnableKillSwitch { .. } => (
                "enable_kill_switch",
                serde_json::to_value(&request).unwrap(),
            ),
            DaemonRequest::DisableKillSwitch => ("disable_kill_switch", serde_json::Value::Null),
            DaemonRequest::UpdateSettings { .. } => {
                ("update_settings", serde_json::to_value(&request).unwrap())
            }
            DaemonRequest::GetSettings => ("get_settings", serde_json::Value::Null),
            DaemonRequest::GetVpnTools => ("get_vpn_tools", serde_json::Value::Null),
            DaemonRequest::RefreshVpnTools => ("refresh_vpn_tools", serde_json::Value::Null),
            DaemonRequest::UpdateBinaryPaths { .. } => (
                "update_binary_paths",
                serde_json::to_value(&request).unwrap(),
            ),
            DaemonRequest::StoreCredential { .. } => {
                ("store_credential", serde_json::to_value(&request).unwrap())
            }
            DaemonRequest::GetCredential { .. } => {
                ("get_credential", serde_json::to_value(&request).unwrap())
            }
            DaemonRequest::DeleteCredential { .. } => {
                ("delete_credential", serde_json::to_value(&request).unwrap())
            }
            DaemonRequest::InstallService => ("install_service", serde_json::Value::Null),
            DaemonRequest::UninstallService => ("uninstall_service", serde_json::Value::Null),
            DaemonRequest::RestartService => ("restart_service", serde_json::Value::Null),
            DaemonRequest::PrepareUpdate { .. } => {
                ("prepare_update", serde_json::to_value(&request).unwrap())
            }
            DaemonRequest::RequestChallenge => ("request_challenge", serde_json::Value::Null),
            DaemonRequest::Authenticate { .. } => {
                ("authenticate", serde_json::to_value(&request).unwrap())
            }
            DaemonRequest::Ping => ("ping", serde_json::Value::Null),
        };

        Self {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.to_string(),
            params,
            session_token: None,
        }
    }

    /// Attach a session token to this request (builder-style).
    pub fn with_session_token(mut self, token: Option<String>) -> Self {
        self.session_token = token;
        self
    }
}

/// JSON-RPC 2.0 response wrapper.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

/// JSON-RPC 2.0 error.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl From<IpcError> for JsonRpcError {
    fn from(err: IpcError) -> Self {
        Self {
            code: err.code,
            message: err.message,
            data: None,
        }
    }
}

/// Requests from GUI to daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DaemonRequest {
    // Service management
    GetStatus,
    InstallService,
    UninstallService,
    RestartService,

    // VPN operations
    Connect {
        config: VpnConfig,
    },
    Disconnect,
    GetConnectionStatus,

    // Kill-switch
    EnableKillSwitch {
        allow_lan: bool,
    },
    DisableKillSwitch,

    // Settings
    UpdateSettings {
        settings: DaemonSettings,
    },
    GetSettings,

    // VPN Tools
    GetVpnTools,
    RefreshVpnTools,
    UpdateBinaryPaths {
        paths: crate::config::VpnBinaryPaths,
    },

    // Credentials
    StoreCredential {
        key: String,
        value: String,
    },
    GetCredential {
        key: String,
    },
    DeleteCredential {
        key: String,
    },

    // Updates
    PrepareUpdate {
        new_binary_path: String,
    },

    // Authentication
    /// Request a fresh challenge (nonce) from the daemon. The client must echo
    /// the returned nonce back in a subsequent `Authenticate` request.
    RequestChallenge,
    Authenticate {
        nonce: String,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        signature: Option<String>,
    },

    // Health check
    Ping,
}

/// Responses from daemon to GUI.
///
/// The variants differ a lot in size (e.g. `Status` carries the full daemon
/// status). Boxing would change the ergonomics of constructing these responses
/// across the daemon for no real benefit on this low-frequency control channel,
/// so we accept the size disparity.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DaemonResponse {
    Ok,
    Pong,
    Status(DaemonStatus),
    ConnectionStatus(ConnectionStatus),
    Settings(DaemonSettings),
    VpnTools(crate::config::VpnToolsStatus),
    Credential {
        value: Option<String>,
    },
    /// A freshly issued authentication challenge (nonce) the client must echo
    /// back in `Authenticate`. `expires_at` is informational for the client.
    Challenge {
        nonce: String,
        expires_at: chrono::DateTime<chrono::Utc>,
    },
    Authenticated {
        session_token: String,
    },
    UpdateReady,
    Error(IpcError),
}

impl DaemonResponse {
    pub fn ok() -> Self {
        DaemonResponse::Ok
    }

    pub fn error(code: i32, message: impl Into<String>) -> Self {
        DaemonResponse::Error(IpcError {
            code,
            message: message.into(),
        })
    }
}

/// Event notifications from daemon to GUI (pushed without request).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum DaemonEvent {
    /// Connection state changed.
    ConnectionStateChanged { status: ConnectionStatus },

    /// Kill-switch state changed.
    KillSwitchStateChanged { enabled: bool },

    /// Daemon is shutting down.
    ShuttingDown { reason: String },

    /// Error occurred.
    Error { code: i32, message: String },

    /// Statistics update.
    StatsUpdate {
        bytes_sent: u64,
        bytes_received: u64,
    },
}

/// Authentication challenge from daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthChallenge {
    /// Random nonce to sign.
    pub nonce: String,

    /// Timestamp when challenge expires.
    pub expires_at: chrono::DateTime<chrono::Utc>,
}

/// Client info sent during authentication.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    /// Process ID of the client.
    pub pid: u32,

    /// Client version.
    pub version: String,

    /// Client identifier (for logging).
    pub client_id: String,
}

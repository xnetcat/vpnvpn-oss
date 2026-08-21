//! Error types for vpnVPN daemon and GUI communication.

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Error codes for daemon responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(i32)]
pub enum ErrorCode {
    // General errors (1-99)
    Unknown = 1,
    InvalidRequest = 2,
    InternalError = 3,
    NotImplemented = 4,

    // Authentication errors (100-199)
    AuthenticationFailed = 100,
    UnauthorizedClient = 101,
    InvalidSignature = 102,
    InvalidNonce = 103,

    // Connection errors (200-299)
    ConnectionFailed = 200,
    AlreadyConnected = 201,
    NotConnected = 202,
    ConnectionTimeout = 203,
    ServerUnreachable = 204,
    InvalidConfig = 205,

    // Service errors (300-399)
    ServiceNotRunning = 300,
    ServiceStartFailed = 301,
    ServiceStopFailed = 302,
    ServiceInstallFailed = 303,
    ServiceUninstallFailed = 304,
    PermissionDenied = 305,

    // Firewall errors (400-499)
    FirewallError = 400,
    KillSwitchEnableFailed = 401,
    KillSwitchDisableFailed = 402,

    // Credential errors (500-599)
    CredentialStoreFailed = 500,
    CredentialNotFound = 501,
    CredentialDeleteFailed = 502,

    // Platform-specific errors (600-699)
    PlatformNotSupported = 600,
    MissingDependency = 601,
    PrivilegeElevationFailed = 602,
}

impl From<i32> for ErrorCode {
    fn from(code: i32) -> Self {
        match code {
            1 => ErrorCode::Unknown,
            2 => ErrorCode::InvalidRequest,
            3 => ErrorCode::InternalError,
            4 => ErrorCode::NotImplemented,
            100 => ErrorCode::AuthenticationFailed,
            101 => ErrorCode::UnauthorizedClient,
            102 => ErrorCode::InvalidSignature,
            103 => ErrorCode::InvalidNonce,
            200 => ErrorCode::ConnectionFailed,
            201 => ErrorCode::AlreadyConnected,
            202 => ErrorCode::NotConnected,
            203 => ErrorCode::ConnectionTimeout,
            204 => ErrorCode::ServerUnreachable,
            205 => ErrorCode::InvalidConfig,
            300 => ErrorCode::ServiceNotRunning,
            301 => ErrorCode::ServiceStartFailed,
            302 => ErrorCode::ServiceStopFailed,
            303 => ErrorCode::ServiceInstallFailed,
            304 => ErrorCode::ServiceUninstallFailed,
            305 => ErrorCode::PermissionDenied,
            400 => ErrorCode::FirewallError,
            401 => ErrorCode::KillSwitchEnableFailed,
            402 => ErrorCode::KillSwitchDisableFailed,
            500 => ErrorCode::CredentialStoreFailed,
            501 => ErrorCode::CredentialNotFound,
            502 => ErrorCode::CredentialDeleteFailed,
            600 => ErrorCode::PlatformNotSupported,
            601 => ErrorCode::MissingDependency,
            602 => ErrorCode::PrivilegeElevationFailed,
            _ => ErrorCode::Unknown,
        }
    }
}

/// Daemon error type.
#[derive(Debug, Error)]
pub enum DaemonError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Connection error: {0}")]
    Connection(String),

    #[error("Authentication error: {0}")]
    Authentication(String),

    #[error("VPN error: {0}")]
    Vpn(String),

    #[error("Firewall error: {0}")]
    Firewall(String),

    #[error("Credential error: {0}")]
    Credential(String),

    #[error("Service error: {0}")]
    Service(String),

    #[error("Platform error: {0}")]
    Platform(String),

    #[error("Configuration error: {0}")]
    Config(String),

    #[error("{message}")]
    Custom { code: ErrorCode, message: String },
}

impl DaemonError {
    pub fn code(&self) -> ErrorCode {
        match self {
            DaemonError::Io(_) => ErrorCode::InternalError,
            DaemonError::Serialization(_) => ErrorCode::InvalidRequest,
            DaemonError::Connection(_) => ErrorCode::ConnectionFailed,
            DaemonError::Authentication(_) => ErrorCode::AuthenticationFailed,
            DaemonError::Vpn(_) => ErrorCode::ConnectionFailed,
            DaemonError::Firewall(_) => ErrorCode::FirewallError,
            DaemonError::Credential(_) => ErrorCode::CredentialStoreFailed,
            DaemonError::Service(_) => ErrorCode::ServiceNotRunning,
            DaemonError::Platform(_) => ErrorCode::PlatformNotSupported,
            DaemonError::Config(_) => ErrorCode::InvalidConfig,
            DaemonError::Custom { code, .. } => *code,
        }
    }

    pub fn custom(code: ErrorCode, message: impl Into<String>) -> Self {
        DaemonError::Custom {
            code,
            message: message.into(),
        }
    }
}

/// Serializable error for IPC responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcError {
    pub code: i32,
    pub message: String,
}

impl From<DaemonError> for IpcError {
    fn from(err: DaemonError) -> Self {
        IpcError {
            code: err.code() as i32,
            message: err.to_string(),
        }
    }
}

impl From<IpcError> for DaemonError {
    fn from(err: IpcError) -> Self {
        DaemonError::Custom {
            code: ErrorCode::from(err.code),
            message: err.message,
        }
    }
}

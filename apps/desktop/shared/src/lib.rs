//! Shared types and protocols for vpnVPN GUI and daemon communication.
//!
//! This crate contains:
//! - IPC message types (requests/responses)
//! - Configuration schemas
//! - Error types
//! - Protocol definitions

pub mod config;
pub mod error;
pub mod ipc;
pub mod protocol;

pub use config::*;
pub use error::*;
pub use ipc::*;
pub use protocol::*;

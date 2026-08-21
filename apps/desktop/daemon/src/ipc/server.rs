//! IPC server implementation.
//!
//! Uses Unix Domain Sockets on macOS/Linux and Named Pipes on Windows.

use crate::state::DaemonState;
use anyhow::Result;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Run the IPC server.
pub async fn run(state: Arc<RwLock<DaemonState>>) -> Result<()> {
    #[cfg(unix)]
    {
        super::unix::run_server(state).await
    }

    #[cfg(windows)]
    {
        super::windows::run_server(state).await
    }
}

/// Generate a new session token.
pub fn generate_session_token() -> String {
    use base64::Engine;
    use rand::Rng;

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Generate a new nonce for authentication challenge.
///
/// Kept as part of the auth API; live challenges are issued via
/// [`crate::ipc::auth::NonceStore`] which tracks issuance/expiry.
#[allow(dead_code)]
pub fn generate_nonce() -> String {
    use base64::Engine;
    use rand::Rng;

    let mut bytes = [0u8; 16];
    rand::thread_rng().fill(&mut bytes);
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

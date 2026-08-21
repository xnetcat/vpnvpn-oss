//! Unix Domain Socket IPC server implementation.

use crate::state::DaemonState;
use anyhow::Result;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};
use vpnvpn_shared::ipc::{DaemonRequest, DaemonResponse, JsonRpcRequest, JsonRpcResponse};

/// Run the Unix Domain Socket server.
pub async fn run_server(state: Arc<RwLock<DaemonState>>) -> Result<()> {
    let socket_path = crate::get_socket_path();

    info!("Starting IPC server...");

    // Remove existing socket file
    if let Err(e) = std::fs::remove_file(&socket_path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            warn!("Failed to remove existing socket: {}", e);
        }
    }

    // Create parent directory if needed
    if let Some(parent) = std::path::Path::new(&socket_path).parent() {
        info!("Creating directory: {:?}", parent);
        std::fs::create_dir_all(parent)?;
    }

    // Bind to socket
    info!("Binding to socket: {}", socket_path);
    let listener = UnixListener::bind(&socket_path)?;
    info!("Socket bound successfully");

    // SECURITY: do NOT make the socket world-writable. The peer-credential UID
    // check is the authoritative gate, but we also tighten the filesystem perms
    // as defence in depth so only the authorized user (and root) can open it.
    //
    // Scheme: the daemon runs as root and the GUI runs as the installing user.
    // We chown the socket to that user and set 0o600 (owner rw only). When the
    // owning user can't be determined we fall back to 0o660 with the root group,
    // which still excludes other unprivileged users. World access is never set.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let owner_uid = owning_user_uid();
        match owner_uid {
            Some(uid) => {
                // 0o600 owned by the authorized user: only that user and root can
                // connect, matching the daemon (root) ↔ GUI (user) topology.
                let permissions = std::fs::Permissions::from_mode(0o600);
                std::fs::set_permissions(&socket_path, permissions)?;
                // chown(socket, uid, -1): keep current group, set owner.
                let c_path = std::ffi::CString::new(socket_path.as_str())
                    .map_err(|e| anyhow::anyhow!("invalid socket path: {e}"))?;
                let rc = unsafe { libc::chown(c_path.as_ptr(), uid, u32::MAX) };
                if rc != 0 {
                    warn!(
                        "Failed to chown socket to uid {}: {}",
                        uid,
                        std::io::Error::last_os_error()
                    );
                }
                info!("Socket permissions set to 0600 (owner uid {})", uid);
            }
            None => {
                // No identifiable owner: restrict to owner+group (root) only.
                let permissions = std::fs::Permissions::from_mode(0o660);
                std::fs::set_permissions(&socket_path, permissions)?;
                info!("Socket permissions set to 0660 (no owner uid resolved)");
            }
        }
    }

    info!("IPC server listening on {}", socket_path);

    loop {
        match listener.accept().await {
            Ok((stream, _addr)) => {
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, state).await {
                        error!("Connection error: {}", e);
                    }
                });
            }
            Err(e) => {
                error!("Accept error: {}", e);
            }
        }
    }
}

/// Best-effort resolution of the unprivileged user that owns/installed the
/// daemon, used to chown the IPC socket. Prefers `SUDO_UID`, then the owner of
/// the socket's parent directory. Returns `None` (→ 0o660 fallback) when only
/// root is identifiable.
#[cfg(unix)]
fn owning_user_uid() -> Option<u32> {
    if let Ok(sudo_uid) = std::env::var("SUDO_UID") {
        if let Ok(uid) = sudo_uid.trim().parse::<u32>() {
            if uid != 0 {
                return Some(uid);
            }
        }
    }

    let socket_path = crate::get_socket_path();
    if let Some(parent) = std::path::Path::new(&socket_path).parent() {
        if let Ok(meta) = std::fs::metadata(parent) {
            use std::os::unix::fs::MetadataExt;
            let owner = meta.uid();
            if owner != 0 {
                return Some(owner);
            }
        }
    }

    None
}

async fn handle_connection(
    stream: tokio::net::UnixStream,
    state: Arc<RwLock<DaemonState>>,
) -> Result<()> {
    // Resolve the peer's credentials before splitting the stream so we can bind
    // any session established on this connection to a verified client. The
    // configured Linux UID allowlist is read from settings so a non-authorized
    // local user is rejected (prevents local privilege escalation).
    #[cfg(target_os = "linux")]
    let allowed_uids = {
        let guard = state.read().await;
        guard.settings.allowed_uids.clone()
    };
    let client = resolve_client_context(
        &stream,
        #[cfg(target_os = "linux")]
        allowed_uids,
    );
    debug!(
        "New connection established (pid={}, uid={:?}, verified={:?})",
        client.pid, client.uid, client.verified
    );

    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).await?;

        if bytes_read == 0 {
            debug!("Client disconnected");
            break;
        }

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // Redacted: the raw line carries the session token and request params.
        debug!("Received request ({} bytes)", line.len());

        // Parse JSON-RPC request
        let response = match serde_json::from_str::<JsonRpcRequest>(line) {
            Ok(rpc_request) => {
                // Parse the inner request
                let request = parse_request(&rpc_request);

                let daemon_response = match request {
                    Ok(req) => {
                        super::handler::handle_request_with_client(
                            Arc::clone(&state),
                            req,
                            client.clone(),
                            rpc_request.session_token.clone(),
                        )
                        .await
                    }
                    Err(e) => {
                        warn!("Invalid request: {}", e);
                        DaemonResponse::error(-32600, format!("Invalid request: {}", e))
                    }
                };

                JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: rpc_request.id,
                    result: match &daemon_response {
                        DaemonResponse::Error(_) => None,
                        _ => Some(serde_json::to_value(&daemon_response).unwrap()),
                    },
                    error: match daemon_response {
                        DaemonResponse::Error(e) => Some(e.into()),
                        _ => None,
                    },
                }
            }
            Err(e) => {
                warn!("Failed to parse request: {}", e);
                JsonRpcResponse {
                    jsonrpc: "2.0".to_string(),
                    id: 0,
                    result: None,
                    error: Some(vpnvpn_shared::ipc::JsonRpcError {
                        code: -32700,
                        message: format!("Parse error: {}", e),
                        data: None,
                    }),
                }
            }
        };

        // Send response
        let response_json = serde_json::to_string(&response)?;
        // Redacted: the authenticate response body carries the session token.
        debug!("Sending response ({} bytes)", response_json.len());
        writer.write_all(response_json.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
    }

    Ok(())
}

/// Resolve peer credentials and verify the connecting client.
///
/// On Linux this uses `SO_PEERCRED`; on macOS it uses `LOCAL_PEERCRED` /
/// `LOCAL_PEERPID`. The resulting [`ClientContext`] is attached to every request
/// on the connection so `Authenticate` can bind a session to a verified peer.
fn resolve_client_context(
    stream: &tokio::net::UnixStream,
    #[cfg(target_os = "linux")] allowed_uids: Vec<u32>,
) -> super::handler::ClientContext {
    use std::os::unix::io::AsRawFd;

    let fd = stream.as_raw_fd();
    match super::auth::get_peer_credentials(fd) {
        Ok((uid, _gid, pid)) => {
            #[cfg(target_os = "linux")]
            let verified = super::auth::ClientVerifier::with_allowed_uids(allowed_uids)
                .verify_client(uid, _gid, pid)
                .ok();

            #[cfg(target_os = "macos")]
            let verified = super::auth::ClientVerifier::new().verify_client(pid).ok();

            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            let verified: Option<bool> = None;

            super::handler::ClientContext {
                pid: pid.max(0) as u32,
                uid: Some(uid),
                verified,
            }
        }
        Err(e) => {
            // SECURITY: if we cannot resolve the peer's credentials we cannot
            // authorize it. Mark it explicitly unverified so the Authenticate
            // handler rejects it rather than treating "unknown" as acceptable.
            warn!(
                "Failed to resolve peer credentials, rejecting client: {}",
                e
            );
            super::handler::ClientContext {
                pid: 0,
                uid: None,
                verified: Some(false),
            }
        }
    }
}

fn parse_request(rpc: &JsonRpcRequest) -> Result<DaemonRequest> {
    match rpc.method.as_str() {
        "ping" => Ok(DaemonRequest::Ping),
        "get_status" => Ok(DaemonRequest::GetStatus),
        "get_connection_status" => Ok(DaemonRequest::GetConnectionStatus),
        "get_settings" => Ok(DaemonRequest::GetSettings),
        "get_vpn_tools" => Ok(DaemonRequest::GetVpnTools),
        "refresh_vpn_tools" => Ok(DaemonRequest::RefreshVpnTools),
        "disconnect" => Ok(DaemonRequest::Disconnect),
        "disable_kill_switch" => Ok(DaemonRequest::DisableKillSwitch),
        "install_service" => Ok(DaemonRequest::InstallService),
        "uninstall_service" => Ok(DaemonRequest::UninstallService),
        "restart_service" => Ok(DaemonRequest::RestartService),

        "connect" => {
            let req: DaemonRequest = serde_json::from_value(rpc.params.clone())?;
            Ok(req)
        }
        "update_settings" => {
            let req: DaemonRequest = serde_json::from_value(rpc.params.clone())?;
            Ok(req)
        }
        "enable_kill_switch" => {
            let req: DaemonRequest = serde_json::from_value(rpc.params.clone())?;
            Ok(req)
        }
        "update_binary_paths" => {
            let req: DaemonRequest = serde_json::from_value(rpc.params.clone())?;
            Ok(req)
        }
        "store_credential" => {
            let req: DaemonRequest = serde_json::from_value(rpc.params.clone())?;
            Ok(req)
        }
        "get_credential" => {
            let req: DaemonRequest = serde_json::from_value(rpc.params.clone())?;
            Ok(req)
        }
        "delete_credential" => {
            let req: DaemonRequest = serde_json::from_value(rpc.params.clone())?;
            Ok(req)
        }
        "prepare_update" => {
            let req: DaemonRequest = serde_json::from_value(rpc.params.clone())?;
            Ok(req)
        }
        "request_challenge" => Ok(DaemonRequest::RequestChallenge),
        "authenticate" => {
            let req: DaemonRequest = serde_json::from_value(rpc.params.clone())?;
            Ok(req)
        }

        _ => Err(anyhow::anyhow!("Unknown method: {}", rpc.method)),
    }
}

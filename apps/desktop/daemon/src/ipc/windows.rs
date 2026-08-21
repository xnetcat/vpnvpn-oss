//! Named Pipe IPC server implementation for Windows.

#![cfg(windows)]

use crate::state::DaemonState;
use anyhow::Result;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};
use vpnvpn_shared::ipc::{DaemonRequest, DaemonResponse, JsonRpcRequest, JsonRpcResponse};

const PIPE_NAME: &str = r"\\.\pipe\vpnvpn-daemon";

/// Run the Named Pipe server on Windows.
///
/// Mirrors the Unix-socket accept loop: it keeps exactly one listening pipe
/// instance available at all times. When a client connects, the connected
/// instance is handed off to a task and a fresh listening instance is created
/// before the loop blocks on the next connection.
pub async fn run_server(state: Arc<RwLock<DaemonState>>) -> Result<()> {
    info!("Starting Named Pipe server at {}", PIPE_NAME);

    // The very first instance claims the pipe name (`first_pipe_instance(true)`)
    // so a non-elevated process cannot squat the name ahead of us.
    let mut server = create_pipe_instance(true)?;

    loop {
        // Wait for a client to connect to the current listening instance.
        if let Err(e) = server.connect().await {
            error!("Pipe connect error: {}", e);
            // Recreate the listening instance and continue.
            server = create_pipe_instance(false)?;
            continue;
        }

        // Hand off the connected instance and immediately create a new one so
        // there is always an instance available for the next client.
        let connected = server;
        server = create_pipe_instance(false)?;

        let state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(e) = handle_connection(connected, state).await {
                error!("Connection error: {}", e);
            }
        });
    }
}

#[cfg(windows)]
fn create_pipe_instance(first: bool) -> Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe = ServerOptions::new()
        .first_pipe_instance(first)
        .create(PIPE_NAME)?;

    Ok(pipe)
}

#[cfg(windows)]
async fn handle_connection(
    pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    state: Arc<RwLock<DaemonState>>,
) -> Result<()> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    // NOTE: unverified on host (Windows-only)
    // Resolve the connecting client's process id and verify it before splitting
    // the pipe, so any session established on this connection is bound to a
    // verified client.
    let client = resolve_client_context(&pipe);
    debug!(
        "New pipe connection established (pid={}, verified={:?})",
        client.pid, client.verified
    );

    let (reader, mut writer) = tokio::io::split(pipe);
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

/// Resolve and verify the client connected to a named-pipe server instance.
///
/// Uses `GetNamedPipeClientProcessId` to obtain the peer's process id, then runs
/// Authenticode verification of its image via [`super::auth::ClientVerifier`].
///
/// NOTE: unverified on host (Windows-only)
#[cfg(windows)]
fn resolve_client_context(
    pipe: &tokio::net::windows::named_pipe::NamedPipeServer,
) -> super::handler::ClientContext {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;

    let raw = pipe.as_raw_handle();
    let mut pid: u32 = 0;

    // Safety: `raw` is a valid pipe handle owned by `pipe` for the duration of
    // this call; `pid` is a valid out-param.
    let ok = unsafe { GetNamedPipeClientProcessId(HANDLE(raw as _), &mut pid) }.is_ok();

    if !ok || pid == 0 {
        warn!("Could not resolve named-pipe client process id");
        return super::handler::ClientContext::default();
    }

    let verifier = super::auth::ClientVerifier::new();
    let verified = verifier.verify_client(pid).ok();

    super::handler::ClientContext {
        pid,
        uid: None,
        verified,
    }
}

#[cfg(windows)]
fn parse_request(rpc: &JsonRpcRequest) -> Result<DaemonRequest> {
    // Same parsing logic as Unix
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

// Stub for non-Windows platforms
#[cfg(not(windows))]
pub async fn run_server(_state: Arc<RwLock<DaemonState>>) -> Result<()> {
    Err(anyhow::anyhow!(
        "Windows named pipes not available on this platform"
    ))
}

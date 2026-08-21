//! Client for communicating with the vpnVPN daemon.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[cfg(unix)]
use std::os::unix::net::UnixStream;

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// Cached session token from the challenge-response handshake with the daemon.
///
/// Established lazily on the first privileged request (or after the previous
/// token is rejected) and reused for every subsequent privileged request so we
/// only handshake when necessary.
static SESSION_TOKEN: Mutex<Option<String>> = Mutex::new(None);

/// Daemon `ErrorCode::AuthenticationFailed` (see `shared/src/error.rs`). Returned
/// when a privileged request carries a missing/invalid/expired session token, so
/// the client knows it must re-run the handshake.
const ERR_AUTHENTICATION_FAILED: i32 = 100;
/// Daemon `ErrorCode::InvalidNonce`. Surfaced if a handshake races and the nonce
/// is consumed/expired; treated the same as an auth failure for retry purposes.
const ERR_INVALID_NONCE: i32 = 103;

/// Production socket path (requires root daemon)
#[cfg(unix)]
const SOCKET_PATH: &str = "/var/run/vpnvpn-daemon.sock";

/// Development socket path (user-accessible, for hot reload)
#[cfg(unix)]
const DEV_SOCKET_PATH: &str = "/tmp/vpnvpn-daemon.sock";

/// Windows named pipe served by the daemon (mirrors `daemon/src/ipc/windows.rs`).
#[cfg(windows)]
const PIPE_NAME: &str = r"\\.\pipe\vpnvpn-daemon";

fn allow_dev_socket() -> bool {
    cfg!(debug_assertions)
        || matches!(
            std::env::var("APP_CHANNEL")
                .ok()
                .as_deref()
                .map(|s| s.to_lowercase()),
            Some(ref v) if v == "devel" || v == "dev" || v == "development"
        )
}

/// Get the active socket path, preferring dev socket if available.
/// This allows hot reload development without touching the production daemon.
#[cfg(unix)]
fn get_socket_path() -> &'static str {
    // In dev, prefer the /tmp socket if it exists
    if allow_dev_socket() && std::path::Path::new(DEV_SOCKET_PATH).exists() {
        eprintln!("[daemon_client] Using dev socket: {}", DEV_SOCKET_PATH);
        return DEV_SOCKET_PATH;
    }

    // Fall back to production socket
    SOCKET_PATH
}

#[derive(Debug, Serialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: u64,
    method: String,
    params: serde_json::Value,
    /// Session token from the handshake. Skipped on the wire when absent so the
    /// daemon sees no field for open (unauthenticated) requests.
    #[serde(skip_serializing_if = "Option::is_none")]
    session_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: u64,
    result: Option<serde_json::Value>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

/// Daemon status response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub running: bool,
    pub version: String,
    pub uptime_secs: u64,
    pub has_network_permission: bool,
    pub has_firewall_permission: bool,
    pub kill_switch_active: bool,
}

impl Default for DaemonStatus {
    fn default() -> Self {
        Self {
            running: false,
            version: "0.0.0".to_string(),
            uptime_secs: 0,
            has_network_permission: false,
            has_firewall_permission: false,
            kill_switch_active: false,
        }
    }
}

/// Check if daemon is available (checks dev socket first, then production).
pub fn is_daemon_available() -> bool {
    eprintln!("[daemon_client] Checking if daemon is available...");

    #[cfg(unix)]
    {
        // Check dev socket first
        if allow_dev_socket() && std::path::Path::new(DEV_SOCKET_PATH).exists() {
            eprintln!(
                "[daemon_client] Dev socket {} exists, trying to connect...",
                DEV_SOCKET_PATH
            );
            if UnixStream::connect(DEV_SOCKET_PATH).is_ok() {
                eprintln!("[daemon_client] Successfully connected to dev socket");
                return true;
            }
        }

        // Check production socket
        let socket_exists = std::path::Path::new(SOCKET_PATH).exists();
        eprintln!(
            "[daemon_client] Production socket {} exists: {}",
            SOCKET_PATH, socket_exists
        );

        if socket_exists {
            match UnixStream::connect(SOCKET_PATH) {
                Ok(_) => {
                    eprintln!("[daemon_client] Successfully connected to production socket");
                    true
                }
                Err(e) => {
                    eprintln!(
                        "[daemon_client] Failed to connect to production socket: {}",
                        e
                    );
                    false
                }
            }
        } else {
            false
        }
    }

    #[cfg(windows)]
    {
        // NOTE: unverified on host (Windows-only)
        // Attempt to open the daemon's named pipe. If the pipe exists and we can
        // open it (or it merely reports "all instances busy", which still means
        // the server is running), the daemon is available.
        match connect_pipe() {
            Ok(_) => {
                eprintln!("[daemon_client] Successfully connected to named pipe");
                true
            }
            Err(e) => {
                use std::io::ErrorKind;
                // ERROR_PIPE_BUSY surfaces as WouldBlock/Other; the pipe still
                // exists so the daemon is up.
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) {
                    eprintln!("[daemon_client] Named pipe busy but present (daemon running)");
                    true
                } else if e.kind() == ErrorKind::NotFound {
                    eprintln!("[daemon_client] Named pipe not found (daemon not running)");
                    false
                } else {
                    eprintln!("[daemon_client] Failed to open named pipe: {}", e);
                    false
                }
            }
        }
    }
}

/// Windows system error: all pipe instances are busy.
#[cfg(windows)]
const ERROR_PIPE_BUSY: u32 = 231;

/// Open a blocking connection to the daemon's named pipe.
///
/// Named pipes on Windows behave like files for byte-mode duplex pipes (which is
/// what the daemon's `ServerOptions::new()` creates), so we use std file I/O to
/// avoid pulling in async/`windows` dependencies. If every server instance is
/// momentarily busy we retry briefly, mirroring `WaitNamedPipe` semantics.
///
/// NOTE: unverified on host (Windows-only)
#[cfg(windows)]
fn connect_pipe() -> std::io::Result<std::fs::File> {
    use std::fs::OpenOptions;

    const MAX_ATTEMPTS: u32 = 10;
    let mut last_err: Option<std::io::Error> = None;

    for attempt in 0..MAX_ATTEMPTS {
        match OpenOptions::new().read(true).write(true).open(PIPE_NAME) {
            Ok(file) => return Ok(file),
            Err(e) => {
                // Retry only while instances are busy; other errors are fatal.
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) {
                    eprintln!(
                        "[daemon_client] Pipe busy, retrying ({}/{})",
                        attempt + 1,
                        MAX_ATTEMPTS
                    );
                    std::thread::sleep(std::time::Duration::from_millis(100));
                    last_err = Some(e);
                    continue;
                }
                return Err(e);
            }
        }
    }

    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::TimedOut, "Named pipe busy timeout")
    }))
}

/// Structured RPC failure so the handshake/retry layer can distinguish a
/// daemon-reported error (with a code) from a transport/parse failure.
#[derive(Debug)]
enum RpcError {
    /// The daemon answered with a JSON-RPC error of the given code/message.
    Daemon { code: i32, message: String },
    /// Transport, serialization, or parse failure (no daemon error code).
    Transport(String),
}

impl RpcError {
    /// Whether this error indicates the session token was missing/invalid/expired
    /// and the client should re-run the handshake and retry once.
    fn is_auth_failure(&self) -> bool {
        matches!(
            self,
            RpcError::Daemon { code, .. }
                if *code == ERR_AUTHENTICATION_FAILED || *code == ERR_INVALID_NONCE
        )
    }

    fn into_string(self) -> String {
        match self {
            RpcError::Daemon { code, message } => format!("Daemon error ({}): {}", code, message),
            RpcError::Transport(message) => message,
        }
    }
}

/// Perform a single request/response round-trip with the daemon, attaching the
/// given session token (if any). This is transport-only: it does NOT perform the
/// handshake or retry — that is layered on top in [`send_request`].
#[cfg(unix)]
fn send_raw(
    method: &str,
    params: serde_json::Value,
    session_token: Option<String>,
) -> Result<serde_json::Value, RpcError> {
    eprintln!("[daemon_client] send_raw: method={}", method);

    let socket_path = get_socket_path();

    // Connect to socket
    eprintln!("[daemon_client] Connecting to socket: {}", socket_path);
    let mut stream = UnixStream::connect(socket_path).map_err(|e| {
        eprintln!("[daemon_client] Failed to connect: {}", e);
        RpcError::Transport(format!("Failed to connect to daemon: {}", e))
    })?;
    eprintln!("[daemon_client] Connected to socket");

    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .ok();
    stream
        .set_write_timeout(Some(std::time::Duration::from_secs(5)))
        .ok();

    // Build request
    let request = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: REQUEST_ID.fetch_add(1, Ordering::SeqCst),
        method: method.to_string(),
        params,
        session_token,
    };

    // Send request
    let request_json = serde_json::to_string(&request)
        .map_err(|e| RpcError::Transport(format!("Failed to serialize request: {}", e)))?;

    // Log only the method and id — never the serialized body, which carries the
    // session token on privileged calls (and may carry credentials in params).
    eprintln!(
        "[daemon_client] Sending request: method={} id={}",
        request.method, request.id
    );

    stream
        .write_all(request_json.as_bytes())
        .map_err(|e| RpcError::Transport(format!("Failed to send request: {}", e)))?;
    stream
        .write_all(b"\n")
        .map_err(|e| RpcError::Transport(format!("Failed to send newline: {}", e)))?;
    stream
        .flush()
        .map_err(|e| RpcError::Transport(format!("Failed to flush: {}", e)))?;

    eprintln!("[daemon_client] Request sent, waiting for response...");

    // Read response
    let mut reader = BufReader::new(stream);
    let mut response_line = String::new();
    reader.read_line(&mut response_line).map_err(|e| {
        eprintln!("[daemon_client] Failed to read response: {}", e);
        RpcError::Transport(format!("Failed to read response: {}", e))
    })?;

    // Log only the size — the authenticate response body carries the session
    // token, so the raw line must not be written to logs.
    eprintln!(
        "[daemon_client] Received response ({} bytes)",
        response_line.trim().len()
    );

    parse_rpc_response(&response_line)
}

/// Parse a single JSON-RPC response line into either the result value or a
/// structured [`RpcError`].
fn parse_rpc_response(response_line: &str) -> Result<serde_json::Value, RpcError> {
    let response: JsonRpcResponse = serde_json::from_str(response_line).map_err(|e| {
        eprintln!("[daemon_client] Failed to parse response: {}", e);
        RpcError::Transport(format!("Failed to parse response: {}", e))
    })?;

    if let Some(error) = response.error {
        eprintln!(
            "[daemon_client] Daemon returned error: {} - {}",
            error.code, error.message
        );
        return Err(RpcError::Daemon {
            code: error.code,
            message: error.message,
        });
    }

    eprintln!("[daemon_client] Request successful");
    response
        .result
        .ok_or_else(|| RpcError::Transport("Empty response".to_string()))
}

/// Perform a single request/response round-trip with the daemon over the
/// Windows named pipe, attaching the given session token (if any).
///
/// Mirrors the Unix-socket [`send_raw`] above: connect to the pipe the daemon
/// serves, write the JSON-RPC request line, then read and parse the response
/// line. Transport-only — handshake/retry is layered in [`send_request`].
///
/// NOTE: unverified on host (Windows-only)
#[cfg(windows)]
fn send_raw(
    method: &str,
    params: serde_json::Value,
    session_token: Option<String>,
) -> Result<serde_json::Value, RpcError> {
    eprintln!("[daemon_client] send_raw (named pipe): method={}", method);

    // Connect to the named pipe.
    let pipe = connect_pipe().map_err(|e| {
        eprintln!("[daemon_client] Failed to connect to pipe: {}", e);
        RpcError::Transport(format!("Failed to connect to daemon: {}", e))
    })?;
    eprintln!("[daemon_client] Connected to named pipe");

    // The pipe is duplex; clone the handle so we can wrap one end in a
    // BufReader while writing to the other.
    let mut writer = pipe
        .try_clone()
        .map_err(|e| RpcError::Transport(format!("Failed to clone pipe handle: {}", e)))?;

    // Build request (identical shape to the Unix client).
    let request = JsonRpcRequest {
        jsonrpc: "2.0".to_string(),
        id: REQUEST_ID.fetch_add(1, Ordering::SeqCst),
        method: method.to_string(),
        params,
        session_token,
    };

    let request_json = serde_json::to_string(&request)
        .map_err(|e| RpcError::Transport(format!("Failed to serialize request: {}", e)))?;

    // Log only the method and id — never the serialized body, which carries the
    // session token on privileged calls (and may carry credentials in params).
    eprintln!(
        "[daemon_client] Sending request: method={} id={}",
        request.method, request.id
    );

    writer
        .write_all(request_json.as_bytes())
        .map_err(|e| RpcError::Transport(format!("Failed to send request: {}", e)))?;
    writer
        .write_all(b"\n")
        .map_err(|e| RpcError::Transport(format!("Failed to send newline: {}", e)))?;
    writer
        .flush()
        .map_err(|e| RpcError::Transport(format!("Failed to flush: {}", e)))?;

    eprintln!("[daemon_client] Request sent, waiting for response...");

    // Read the single-line response.
    let mut reader = BufReader::new(pipe);
    let mut response_line = String::new();
    reader.read_line(&mut response_line).map_err(|e| {
        eprintln!("[daemon_client] Failed to read response: {}", e);
        RpcError::Transport(format!("Failed to read response: {}", e))
    })?;

    // Log only the size — the authenticate response body carries the session
    // token, so the raw line must not be written to logs.
    eprintln!(
        "[daemon_client] Received response ({} bytes)",
        response_line.trim().len()
    );

    parse_rpc_response(&response_line)
}

/// Methods that the daemon serves WITHOUT requiring a session token.
///
/// Must mirror the daemon's `is_privileged` allow-list (handler.rs): the
/// handshake itself plus health/read-only discovery. Everything else is
/// privileged and gets a token attached. Sending a token on an open method is
/// harmless (the daemon ignores it), but we avoid forcing a handshake just to
/// run discovery (e.g. `get_status` before the daemon is even authenticated).
const OPEN_METHODS: &[&str] = &[
    "ping",
    "request_challenge",
    "authenticate",
    "get_status",
    "get_connection_status",
    "get_settings",
    "get_vpn_tools",
];

/// Whether a method is privileged (requires a session token).
fn method_is_privileged(method: &str) -> bool {
    !OPEN_METHODS.contains(&method)
}

/// Run the challenge-response handshake with the daemon and return a fresh
/// session token.
///
/// 1. `request_challenge` -> the daemon issues a single-use nonce.
/// 2. `authenticate` echoing that nonce -> the daemon verifies the nonce was
///    issued and binds a session token to our (transport-verified) process.
///
/// Both steps are open methods, so no token is attached here.
fn perform_handshake() -> Result<String, String> {
    eprintln!("[daemon_client] Performing daemon handshake...");

    // 1. Request a challenge nonce.
    let challenge = send_raw("request_challenge", serde_json::Value::Null, None)
        .map_err(|e| format!("Handshake (challenge) failed: {}", e.into_string()))?;

    let nonce = challenge
        .get("nonce")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Handshake failed: daemon did not return a nonce".to_string())?
        .to_string();

    // 2. Authenticate by echoing the nonce back.
    let params = serde_json::json!({
        "type": "authenticate",
        "nonce": nonce,
    });
    let authed = send_raw("authenticate", params, None)
        .map_err(|e| format!("Handshake (authenticate) failed: {}", e.into_string()))?;

    let token = authed
        .get("session_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Handshake failed: daemon did not return a session token".to_string())?
        .to_string();

    eprintln!("[daemon_client] Handshake complete, session established");
    Ok(token)
}

/// Read the cached session token, if any.
fn cached_token() -> Option<String> {
    SESSION_TOKEN.lock().ok().and_then(|g| g.clone())
}

/// Store a freshly issued session token in the cache.
fn store_token(token: &str) {
    if let Ok(mut g) = SESSION_TOKEN.lock() {
        *g = Some(token.to_string());
    }
}

/// Clear the cached token (e.g. after the daemon rejects it).
fn clear_token() {
    if let Ok(mut g) = SESSION_TOKEN.lock() {
        *g = None;
    }
}

/// Ensure we hold a session token, performing the handshake if the cache is
/// empty, and return it.
fn ensure_token() -> Result<String, String> {
    if let Some(t) = cached_token() {
        return Ok(t);
    }
    let token = perform_handshake()?;
    store_token(&token);
    Ok(token)
}

/// Send a request to the daemon, transparently performing the challenge-response
/// handshake for privileged methods and re-handshaking once on token rejection.
///
/// Open methods (ping/status/handshake) are sent without a token. Privileged
/// methods attach the cached token (establishing one first if needed); if the
/// daemon rejects it as unauthenticated/expired, the cache is cleared, a fresh
/// handshake runs, and the request is retried exactly once.
fn send_request(method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    eprintln!("[daemon_client] send_request: method={}", method);

    if !method_is_privileged(method) {
        // Open method: no token, no handshake, no retry.
        return send_raw(method, params, None).map_err(|e| e.into_string());
    }

    // Privileged method: ensure we have a token, then attempt with it.
    let token = ensure_token()?;
    match send_raw(method, params.clone(), Some(token)) {
        Ok(result) => Ok(result),
        Err(err) if err.is_auth_failure() => {
            // Token missing/expired/invalid: drop it, re-handshake, retry once.
            eprintln!(
                "[daemon_client] Session rejected ({}); re-running handshake and retrying",
                err.into_string()
            );
            clear_token();
            let fresh = perform_handshake()?;
            store_token(&fresh);
            send_raw(method, params, Some(fresh)).map_err(|e| e.into_string())
        }
        Err(err) => Err(err.into_string()),
    }
}

/// Get daemon status.
pub fn get_status() -> Result<DaemonStatus, String> {
    eprintln!("[daemon_client] Getting daemon status...");

    let result = send_request("get_status", serde_json::Value::Null)?;

    eprintln!("[daemon_client] Raw status result: {:?}", result);

    // Extract nested status from response
    if let Some(status_obj) = result.get("Status") {
        eprintln!("[daemon_client] Found Status object: {:?}", status_obj);
        serde_json::from_value(status_obj.clone()).map_err(|e| {
            eprintln!("[daemon_client] Failed to parse Status: {}", e);
            format!("Failed to parse status: {}", e)
        })
    } else {
        // Try parsing the whole result
        eprintln!("[daemon_client] No Status object, trying to parse whole result");
        serde_json::from_value(result.clone()).map_err(|e| {
            eprintln!(
                "[daemon_client] Failed to parse result as DaemonStatus: {}",
                e
            );
            format!("Failed to parse status: {}", e)
        })
    }
}

/// Enable kill switch.
pub fn enable_kill_switch(allow_lan: bool) -> Result<(), String> {
    let params = serde_json::json!({
        "type": "enable_kill_switch",
        "allow_lan": allow_lan
    });

    let result = send_request("enable_kill_switch", params)?;

    if result.get("type").and_then(|v| v.as_str()) == Some("ok") {
        Ok(())
    } else if let Some(error) = result.get("Error") {
        let msg = error
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown error");
        Err(msg.to_string())
    } else {
        Ok(())
    }
}

/// Disable kill switch.
pub fn disable_kill_switch() -> Result<(), String> {
    let result = send_request("disable_kill_switch", serde_json::Value::Null)?;

    // `send_request` already returns Err for daemon errors, so any response here
    // (Ok or otherwise) means the request was accepted.
    if let Some(error) = result.get("Error") {
        let msg = error
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Failed to disable kill-switch");
        return Err(msg.to_string());
    }
    Ok(())
}

/// Request daemon restart.
pub fn restart_daemon() -> Result<(), String> {
    send_request("restart_service", serde_json::Value::Null)?;
    Ok(())
}

/// Fetch the daemon's current settings as raw JSON (open/read-only method).
///
/// Returned as a JSON object so the GUI can read/modify individual fields (e.g.
/// split-tunnel) without the client duplicating the whole settings schema.
pub fn get_daemon_settings() -> Result<serde_json::Value, String> {
    let result = send_request("get_settings", serde_json::Value::Null)?;
    // The daemon tags the response: { "type": "settings", ...fields }.
    if result.get("type").and_then(|v| v.as_str()) == Some("settings") {
        let mut obj = result.clone();
        if let Some(map) = obj.as_object_mut() {
            map.remove("type");
        }
        return Ok(obj);
    }
    Ok(result)
}

/// Push a full settings object to the daemon (persisted to daemon.json).
pub fn update_daemon_settings(settings: serde_json::Value) -> Result<(), String> {
    let params = serde_json::json!({
        "type": "update_settings",
        "settings": settings,
    });
    let result = send_request("update_settings", params)?;
    if let Some(error) = result.get("Error") {
        let msg = error
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Failed to update settings");
        return Err(msg.to_string());
    }
    Ok(())
}

/// Drive the daemon's signed-update staging flow.
///
/// Sends `prepare_update` with the path to the new daemon binary. The daemon
/// verifies the binary's signature (codesign / Authenticode / detached minisign)
/// before staging it — this is the signature-verification path in
/// `daemon/src/ipc/handler.rs`. On success the daemon has staged the new binary
/// and a restart will swap it in. Returns an error (surfaced to the UI) if the
/// signature check or staging fails.
pub fn prepare_update(new_binary_path: &str) -> Result<(), String> {
    let params = serde_json::json!({
        "type": "prepare_update",
        "new_binary_path": new_binary_path,
    });

    let result = send_request("prepare_update", params)?;

    // The daemon tags responses with `type`; success is `update_ready`.
    if result.get("type").and_then(|v| v.as_str()) == Some("update_ready") {
        return Ok(());
    }

    if let Some(error) = result.get("Error") {
        let msg = error
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Update preparation failed");
        return Err(msg.to_string());
    }

    // Any non-error response means the daemon accepted the staging.
    Ok(())
}

/// VPN connection configuration sent to daemon.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VpnConfig {
    pub protocol: String,
    pub server_id: String,
    pub server_region: String,
    pub server_endpoint: String,
    pub server_port: u16,
    // WireGuard-specific
    pub wg_private_key: Option<String>,
    pub wg_public_key: Option<String>,
    pub wg_server_public_key: Option<String>,
    pub wg_preshared_key: Option<String>,
    pub assigned_ip: Option<String>,
    // OpenVPN-specific
    pub ovpn_config: Option<String>,
    // IKEv2-specific
    pub ikev2_identity: Option<String>,
    pub ikev2_remote_id: Option<String>,
    // Auth
    pub username: Option<String>,
    pub password: Option<String>,
    // DNS
    pub dns_servers: Vec<String>,
}

/// Connection status from daemon.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConnectionStatus {
    pub state: String,
    pub protocol: Option<String>,
    pub server_id: Option<String>,
    pub server_region: Option<String>,
    pub interface_name: Option<String>,
    pub assigned_ip: Option<String>,
    pub bytes_sent: Option<u64>,
    pub bytes_received: Option<u64>,
    /// When the tunnel was established (used to derive session duration).
    pub connected_at: Option<String>,
    /// Last WireGuard handshake time, if known.
    pub last_handshake: Option<String>,
}

/// Connect to VPN via daemon.
pub fn connect_vpn(config: VpnConfig) -> Result<ConnectionStatus, String> {
    eprintln!("[daemon_client] connect_vpn called");
    eprintln!(
        "[daemon_client] Config: protocol={}, endpoint={}:{}",
        config.protocol, config.server_endpoint, config.server_port
    );
    eprintln!(
        "[daemon_client] Config: assigned_ip={:?}, wg_private_key={}",
        config.assigned_ip,
        config
            .wg_private_key
            .as_ref()
            .map(|_| "[REDACTED]")
            .unwrap_or("None")
    );
    eprintln!(
        "[daemon_client] Config: wg_server_public_key={:?}",
        config.wg_server_public_key
    );

    ensure_daemon_running()?;

    let params = serde_json::json!({
        "type": "connect",
        "config": config
    });

    eprintln!("[daemon_client] Sending connect request to daemon...");
    let result = send_request("connect", params)?;
    eprintln!("[daemon_client] Connect response: {:?}", result);

    // Parse connection status from response
    if let Some(status) = result.get("ConnectionStatus") {
        eprintln!("[daemon_client] Got ConnectionStatus from response");
        return serde_json::from_value(status.clone())
            .map_err(|e| format!("Failed to parse connection status: {}", e));
    }

    if let Some(error) = result.get("Error") {
        let msg = error
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Connection failed");
        eprintln!("[daemon_client] Connect error: {}", msg);
        return Err(msg.to_string());
    }

    eprintln!("[daemon_client] Connect succeeded (no explicit status)");
    // Return default connected status
    Ok(ConnectionStatus {
        state: "connected".to_string(),
        protocol: Some(config.protocol),
        ..Default::default()
    })
}

/// Disconnect VPN via daemon.
pub fn disconnect_vpn() -> Result<(), String> {
    ensure_daemon_running()?;

    let result = send_request("disconnect", serde_json::Value::Null)?;

    if let Some(error) = result.get("Error") {
        let msg = error
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("Disconnect failed");
        return Err(msg.to_string());
    }

    Ok(())
}

/// Get current VPN connection status from daemon.
pub fn get_connection_status() -> Result<ConnectionStatus, String> {
    ensure_daemon_running()?;

    let result = send_request("get_connection_status", serde_json::Value::Null)?;

    // Parse connection status from response
    if let Some(status) = result.get("ConnectionStatus") {
        return serde_json::from_value(status.clone())
            .map_err(|e| format!("Failed to parse connection status: {}", e));
    }

    // Try parsing the whole result
    serde_json::from_value(result).map_err(|e| format!("Failed to parse connection status: {}", e))
}

/// Ensure daemon is running, return helpful error if not.
fn ensure_daemon_running() -> Result<(), String> {
    if !is_daemon_available() {
        return Err(
            "VPN daemon is not running. Please install the VPN service from Settings > Service, or complete the onboarding setup.".to_string()
        );
    }
    Ok(())
}

// ============ VPN Tools ============

/// VPN tool information from daemon.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VpnToolInfo {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub custom_path: Option<String>,
    pub error: Option<String>,
}

/// VPN tools status from daemon.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VpnToolsStatus {
    pub wireguard: VpnToolInfo,
    pub openvpn: VpnToolInfo,
    pub ikev2: VpnToolInfo,
}

/// Custom binary paths configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VpnBinaryPaths {
    pub wg_quick_path: Option<String>,
    pub wireguard_cli_path: Option<String>,
    pub openvpn_path: Option<String>,
    pub ikev2_path: Option<String>,
}

/// Get VPN tools status from daemon.
pub fn get_vpn_tools() -> Result<VpnToolsStatus, String> {
    eprintln!("[daemon_client] Getting VPN tools status...");

    let result = send_request("get_vpn_tools", serde_json::Value::Null)?;

    eprintln!("[daemon_client] Raw VPN tools result: {:?}", result);

    // Extract VpnTools from response
    if let Some(tools_obj) = result.get("VpnTools") {
        eprintln!("[daemon_client] Found VpnTools object: {:?}", tools_obj);
        serde_json::from_value(tools_obj.clone()).map_err(|e| {
            eprintln!("[daemon_client] Failed to parse VpnTools: {}", e);
            format!("Failed to parse VPN tools: {}", e)
        })
    } else {
        // Try parsing the whole result
        eprintln!("[daemon_client] No VpnTools object, trying to parse whole result");
        serde_json::from_value(result.clone()).map_err(|e| {
            eprintln!(
                "[daemon_client] Failed to parse result as VpnToolsStatus: {}",
                e
            );
            format!("Failed to parse VPN tools: {}", e)
        })
    }
}

/// Refresh VPN tools detection in daemon.
pub fn refresh_vpn_tools() -> Result<VpnToolsStatus, String> {
    eprintln!("[daemon_client] Refreshing VPN tools...");

    let result = send_request("refresh_vpn_tools", serde_json::Value::Null)?;

    // Extract VpnTools from response
    if let Some(tools_obj) = result.get("VpnTools") {
        serde_json::from_value(tools_obj.clone())
            .map_err(|e| format!("Failed to parse VPN tools: {}", e))
    } else {
        serde_json::from_value(result).map_err(|e| format!("Failed to parse VPN tools: {}", e))
    }
}

/// Update VPN binary paths in daemon settings.
pub fn update_binary_paths(paths: VpnBinaryPaths) -> Result<VpnToolsStatus, String> {
    eprintln!("[daemon_client] Updating VPN binary paths...");
    eprintln!("[daemon_client] Paths: {:?}", paths);

    let params = serde_json::json!({
        "type": "update_binary_paths",
        "paths": paths
    });

    let result = send_request("update_binary_paths", params)?;

    eprintln!("[daemon_client] Update binary paths result: {:?}", result);

    // Extract VpnTools from response
    if let Some(tools_obj) = result.get("VpnTools") {
        serde_json::from_value(tools_obj.clone())
            .map_err(|e| format!("Failed to parse VPN tools: {}", e))
    } else {
        serde_json::from_value(result).map_err(|e| format!("Failed to parse VPN tools: {}", e))
    }
}

//! Request handler for IPC messages.

use crate::state::DaemonState;
use anyhow::Result;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};
use vpnvpn_shared::{
    ipc::{DaemonRequest, DaemonResponse},
    ErrorCode,
};

/// Information about the connected peer, resolved from the transport.
///
/// This is populated by the transport layer (Unix socket peer credentials on
/// macOS/Linux, named-pipe client process id on Windows) so that the
/// `Authenticate` handler can bind a session token to a verified client.
#[derive(Debug, Clone, Default)]
pub struct ClientContext {
    /// Peer process id, if known (0 = unknown).
    pub pid: u32,
    /// Peer user id, if known (Unix only). On Windows the named-pipe transport
    /// always sets `None` and nothing reads it, hence the dead_code allowance.
    #[cfg_attr(windows, allow(dead_code))]
    pub uid: Option<u32>,
    /// Whether the transport layer verified the client (peer creds / code
    /// signature). `None` means verification was not attempted.
    pub verified: Option<bool>,
}

/// Whether a request mutates privileged daemon state and therefore requires a
/// valid session token bound to the verified peer.
///
/// Open (unauthenticated) requests are discovery/health/read-only: `Ping`,
/// `RequestChallenge`, `Authenticate`, and the read-only status/settings/tools
/// queries. Everything that changes VPN state, the kill-switch, the service, or
/// applies updates is privileged.
fn is_privileged(request: &DaemonRequest) -> bool {
    match request {
        // Open: handshake + health + read-only discovery.
        DaemonRequest::Ping
        | DaemonRequest::RequestChallenge
        | DaemonRequest::Authenticate { .. }
        | DaemonRequest::GetStatus
        | DaemonRequest::GetConnectionStatus
        | DaemonRequest::GetSettings
        | DaemonRequest::GetVpnTools => false,

        // Privileged: anything that mutates state or touches credentials.
        DaemonRequest::Connect { .. }
        | DaemonRequest::Disconnect
        | DaemonRequest::EnableKillSwitch { .. }
        | DaemonRequest::DisableKillSwitch
        | DaemonRequest::UpdateSettings { .. }
        | DaemonRequest::RefreshVpnTools
        | DaemonRequest::UpdateBinaryPaths { .. }
        | DaemonRequest::StoreCredential { .. }
        | DaemonRequest::GetCredential { .. }
        | DaemonRequest::DeleteCredential { .. }
        | DaemonRequest::InstallService
        | DaemonRequest::UninstallService
        | DaemonRequest::RestartService
        | DaemonRequest::PrepareUpdate { .. } => true,
    }
}

/// Handle a daemon request with resolved client context.
///
/// `client` carries the connecting peer's identity (resolved by the transport
/// layer) so that authentication can bind a session to a verified client.
/// `session_token` is the token presented on the request (from the JSON-RPC
/// envelope); privileged requests require it to match an active session bound to
/// the connecting peer.
pub async fn handle_request_with_client(
    state: Arc<RwLock<DaemonState>>,
    request: DaemonRequest,
    client: ClientContext,
    session_token: Option<String>,
) -> DaemonResponse {
    debug!("Handling request: {:?}", request);

    // Gate privileged requests behind a valid, peer-bound session token. Open
    // requests (handshake/health/read-only) fall through unauthenticated so the
    // client can still discover the daemon and run the handshake.
    if is_privileged(&request) {
        let authorized = match session_token.as_deref() {
            Some(token) => {
                let state = state.read().await;
                state.validate_session_for_peer(token, client.pid)
            }
            None => false,
        };
        if !authorized {
            warn!(
                "Rejecting privileged request {:?} from pid {}: missing/invalid session",
                std::mem::discriminant(&request),
                client.pid
            );
            return DaemonResponse::error(
                ErrorCode::AuthenticationFailed as i32,
                "Invalid or missing session token; re-authenticate",
            );
        }
    }

    match request {
        DaemonRequest::Ping => DaemonResponse::Pong,

        DaemonRequest::GetStatus => {
            let state = state.read().await;
            DaemonResponse::Status(state.status())
        }

        DaemonRequest::GetConnectionStatus => {
            // Return the stored connection, but refresh live transfer counters
            // (and handshake) from the running tunnel so the GUI can show live
            // throughput / totals. We preserve the fields the live check doesn't
            // know about (server id/region, assigned ip, connected_at).
            let stored = {
                let state = state.read().await;
                state.connection.clone()
            };

            let mut status = stored.clone();
            if stored.state == vpnvpn_shared::protocol::ConnectionState::Connected {
                if let Some(protocol) = stored.protocol {
                    let live = match protocol {
                        vpnvpn_shared::Protocol::WireGuard => {
                            crate::vpn::wireguard::check_status().await.ok()
                        }
                        // OpenVPN/IKEv2 don't expose per-tunnel byte counters here.
                        _ => None,
                    };
                    if let Some(live) = live {
                        if live.bytes_sent.is_some() {
                            status.bytes_sent = live.bytes_sent;
                        }
                        if live.bytes_received.is_some() {
                            status.bytes_received = live.bytes_received;
                        }
                        if live.last_handshake.is_some() {
                            status.last_handshake = live.last_handshake;
                        }
                    }
                }
            }

            DaemonResponse::ConnectionStatus(status)
        }

        DaemonRequest::GetSettings => {
            let state = state.read().await;
            DaemonResponse::Settings(state.settings.clone())
        }

        DaemonRequest::UpdateSettings { settings } => {
            let mut state = state.write().await;

            // Check if binary paths changed, so we need to refresh tools
            let paths_changed = state.settings.binary_paths != settings.binary_paths;

            state.settings = settings.clone();

            // Save settings to disk
            if let Some(path) = vpnvpn_shared::config::config_file("daemon.json") {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                match serde_json::to_string_pretty(&settings) {
                    Ok(json) => {
                        if let Err(e) = std::fs::write(&path, json) {
                            error!("Failed to save settings: {}", e);
                        }
                    }
                    Err(e) => error!("Failed to serialize settings: {}", e),
                }
            }

            // Refresh tools if paths changed
            if paths_changed {
                state.refresh_vpn_tools();
            }

            DaemonResponse::Ok
        }

        DaemonRequest::GetVpnTools => {
            let state = state.read().await;
            DaemonResponse::VpnTools(state.vpn_tools.clone())
        }

        DaemonRequest::RefreshVpnTools => {
            info!("Refresh VPN tools request");
            let mut state = state.write().await;
            state.refresh_vpn_tools();
            DaemonResponse::VpnTools(state.vpn_tools.clone())
        }

        DaemonRequest::UpdateBinaryPaths { paths } => {
            info!("Update binary paths request");
            debug!("  WG path: {:?}", paths.wg_quick_path);
            debug!("  OpenVPN path: {:?}", paths.openvpn_path);
            debug!("  IKEv2 path: {:?}", paths.ikev2_path);

            let mut state = state.write().await;
            state.update_binary_paths(paths);

            // Save settings to disk
            if let Some(path) = vpnvpn_shared::config::config_file("daemon.json") {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                match serde_json::to_string_pretty(&state.settings) {
                    Ok(json) => {
                        if let Err(e) = std::fs::write(&path, json) {
                            error!("Failed to save settings: {}", e);
                        }
                    }
                    Err(e) => error!("Failed to serialize settings: {}", e),
                }
            }

            DaemonResponse::VpnTools(state.vpn_tools.clone())
        }

        DaemonRequest::Connect { config } => {
            info!("Connect request received");
            info!("  Protocol: {:?}", config.protocol);
            info!(
                "  Endpoint: {}:{}",
                config.server_endpoint, config.server_port
            );
            info!("  Server ID: {}", config.server_id);
            info!("  Assigned IP: {:?}", config.assigned_ip);
            info!("  Has WG private key: {}", config.wg_private_key.is_some());
            info!(
                "  Has WG server public key: {}",
                config.wg_server_public_key.is_some()
            );
            info!("  DNS: {:?}", config.dns_servers);

            // SECURITY: validate every attacker-influenced config field before it
            // reaches a root-written config file (prevents PostUp/newline
            // injection that would run arbitrary commands as root via wg-quick /
            // openvpn / ipsec). Reject the connection if anything is unsafe.
            if let Err(e) = crate::vpn::validate::validate_config(&config) {
                error!("Rejecting connect: invalid VPN config: {}", e);
                return DaemonResponse::error(ErrorCode::InvalidConfig as i32, e.to_string());
            }

            let (binary_paths, split_tunnel) = {
                let state_read = state.read().await;
                (
                    state_read.settings.binary_paths.clone(),
                    state_read.settings.split_tunnel.clone(),
                )
            };

            let result = match config.protocol {
                vpnvpn_shared::Protocol::WireGuard => {
                    crate::vpn::wireguard::connect(&config, &binary_paths, &split_tunnel).await
                }
                vpnvpn_shared::Protocol::OpenVPN => {
                    crate::vpn::openvpn::connect(&config, &binary_paths).await
                }
                vpnvpn_shared::Protocol::IKEv2 => {
                    crate::vpn::ikev2::connect(&config, &binary_paths).await
                }
            };

            match result {
                Ok(status)
                    if status.state
                        == vpnvpn_shared::protocol::ConnectionState::PendingApproval =>
                {
                    // macOS IKEv2: the VPN profile awaits one-time user approval
                    // in System Settings. No tunnel exists, so do NOT store this
                    // as the active connection, enable the kill switch, or stamp
                    // connection metadata — just relay the structured state so
                    // the GUI can show the approval instruction.
                    info!("Connect resulted in pending user approval (IKEv2 profile)");
                    DaemonResponse::ConnectionStatus(status)
                }
                Ok(mut status) => {
                    // Stamp connection metadata that the protocol backends don't
                    // populate, so the GUI can show server + session duration.
                    if status.connected_at.is_none() {
                        status.connected_at = Some(chrono::Utc::now());
                    }
                    if status.server_id.is_none() && !config.server_id.is_empty() {
                        status.server_id = Some(config.server_id.clone());
                    }
                    if status.server_region.is_none() && !config.server_region.is_empty() {
                        status.server_region = Some(config.server_region.clone());
                    }
                    if status.assigned_ip.is_none() {
                        status.assigned_ip = config.assigned_ip.clone();
                    }

                    let mut state = state.write().await;
                    state.connection = status.clone();
                    // Remember the config for auto-reconnect, and clear the
                    // user-disconnected flag now that we're connected.
                    state.last_config = Some(config.clone());
                    state.user_disconnected = false;

                    // Enable kill-switch if configured
                    if state.settings.kill_switch_enabled {
                        if let Some(iface) = &status.interface_name {
                            let allow_lan = state.settings.allow_lan;
                            // SECURITY/CORRECTNESS: the firewall (pf/nft/iptables)
                            // needs a literal IP, but server_endpoint may be a DNS
                            // name (from the WG `Endpoint=` line). Resolve it to an
                            // IP first; otherwise the handshake-allow rule is
                            // invalid and the VPN can't connect / leaks.
                            let resolved =
                                resolve_server_ip(&config.server_endpoint, config.server_port)
                                    .await;
                            let server_ip = resolved.as_deref();
                            if server_ip.is_none() {
                                warn!(
                                    "Could not resolve server endpoint '{}' to an IP; \
                                     kill-switch will allow VPN ports to any host",
                                    config.server_endpoint
                                );
                            }
                            if let Err(e) = enable_kill_switch(iface, allow_lan, server_ip).await {
                                warn!("Failed to enable kill-switch: {}", e);
                            } else {
                                state.kill_switch_active = true;
                            }
                        }
                    }

                    DaemonResponse::ConnectionStatus(status)
                }
                Err(e) => {
                    error!("Connect failed: {}", e);
                    DaemonResponse::error(ErrorCode::ConnectionFailed as i32, e.to_string())
                }
            }
        }

        DaemonRequest::Disconnect => {
            info!("Disconnect request");

            let mut state = state.write().await;
            let binary_paths = state.settings.binary_paths.clone();

            // This is an explicit user disconnect: suppress auto-reconnect so we
            // don't fight the user's intent to stay disconnected.
            state.user_disconnected = true;

            // Disconnect VPN first, THEN disable kill switch.
            // This prevents a window where traffic flows unprotected.
            let result = if let Some(protocol) = state.connection.protocol {
                match protocol {
                    vpnvpn_shared::Protocol::WireGuard => {
                        crate::vpn::wireguard::disconnect(&binary_paths).await
                    }
                    vpnvpn_shared::Protocol::OpenVPN => crate::vpn::openvpn::disconnect().await,
                    vpnvpn_shared::Protocol::IKEv2 => crate::vpn::ikev2::disconnect().await,
                }
            } else {
                Ok(())
            };

            // Now disable kill-switch after VPN is down
            if state.kill_switch_active {
                if let Err(e) = disable_kill_switch().await {
                    warn!("Failed to disable kill-switch: {}", e);
                }
                state.kill_switch_active = false;
            }

            match result {
                Ok(()) => {
                    state.connection = vpnvpn_shared::ConnectionStatus::default();
                    DaemonResponse::Ok
                }
                Err(e) => {
                    error!("Disconnect failed: {}", e);
                    DaemonResponse::error(ErrorCode::ConnectionFailed as i32, e.to_string())
                }
            }
        }

        DaemonRequest::EnableKillSwitch { allow_lan } => {
            info!("Enable kill-switch request (allow_lan={})", allow_lan);

            let state_read = state.read().await;
            let interface = state_read.connection.interface_name.clone();
            drop(state_read);

            if let Some(iface) = interface {
                match enable_kill_switch(&iface, allow_lan, None).await {
                    Ok(()) => {
                        let mut state = state.write().await;
                        state.kill_switch_active = true;
                        DaemonResponse::Ok
                    }
                    Err(e) => {
                        error!("Enable kill-switch failed: {}", e);
                        DaemonResponse::error(
                            ErrorCode::KillSwitchEnableFailed as i32,
                            e.to_string(),
                        )
                    }
                }
            } else {
                DaemonResponse::error(
                    ErrorCode::NotConnected as i32,
                    "VPN not connected, cannot enable kill-switch",
                )
            }
        }

        DaemonRequest::DisableKillSwitch => {
            info!("Disable kill-switch request");

            match disable_kill_switch().await {
                Ok(()) => {
                    let mut state = state.write().await;
                    state.kill_switch_active = false;
                    DaemonResponse::Ok
                }
                Err(e) => {
                    error!("Disable kill-switch failed: {}", e);
                    DaemonResponse::error(ErrorCode::KillSwitchDisableFailed as i32, e.to_string())
                }
            }
        }

        DaemonRequest::StoreCredential { key, value } => {
            debug!("Store credential request for key: {}", key);

            match crate::credentials::store(&key, &value) {
                Ok(()) => DaemonResponse::Ok,
                Err(e) => {
                    error!("Store credential failed: {}", e);
                    DaemonResponse::error(ErrorCode::CredentialStoreFailed as i32, e.to_string())
                }
            }
        }

        DaemonRequest::GetCredential { key } => {
            debug!("Get credential request for key: {}", key);

            match crate::credentials::get(&key) {
                Ok(value) => DaemonResponse::Credential { value },
                Err(e) => {
                    error!("Get credential failed: {}", e);
                    DaemonResponse::error(ErrorCode::CredentialNotFound as i32, e.to_string())
                }
            }
        }

        DaemonRequest::DeleteCredential { key } => {
            debug!("Delete credential request for key: {}", key);

            match crate::credentials::delete(&key) {
                Ok(()) => DaemonResponse::Ok,
                Err(e) => {
                    error!("Delete credential failed: {}", e);
                    DaemonResponse::error(ErrorCode::CredentialDeleteFailed as i32, e.to_string())
                }
            }
        }

        DaemonRequest::InstallService => {
            info!("Install service request");
            // This is typically called from the GUI with elevated privileges
            // The daemon itself doesn't install - it's already running
            DaemonResponse::error(
                ErrorCode::NotImplemented as i32,
                "Service installation is handled by the GUI",
            )
        }

        DaemonRequest::UninstallService => {
            info!("Uninstall service request");
            DaemonResponse::error(
                ErrorCode::NotImplemented as i32,
                "Service uninstallation is handled by the GUI",
            )
        }

        DaemonRequest::RestartService => {
            info!("Restart service request");
            // Schedule a restart
            #[cfg(target_os = "macos")]
            {
                tokio::spawn(async {
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    let _ = std::process::Command::new("launchctl")
                        .args(["kickstart", "-k", "system/com.vpnvpn.daemon"])
                        .spawn();
                });
            }

            #[cfg(target_os = "linux")]
            {
                tokio::spawn(async {
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    let _ = std::process::Command::new("systemctl")
                        .args(["restart", "vpnvpn-daemon"])
                        .spawn();
                });
            }

            #[cfg(target_os = "windows")]
            {
                tokio::spawn(async {
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    let _ = std::process::Command::new("sc")
                        .args(["stop", "vpnvpn-daemon"])
                        .spawn();
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                    let _ = std::process::Command::new("sc")
                        .args(["start", "vpnvpn-daemon"])
                        .spawn();
                });
            }

            DaemonResponse::Ok
        }

        DaemonRequest::PrepareUpdate { new_binary_path } => {
            info!("Prepare update request: {}", new_binary_path);

            // Validate the new binary exists
            if !std::path::Path::new(&new_binary_path).exists() {
                return DaemonResponse::error(
                    ErrorCode::InvalidConfig as i32,
                    "New binary not found",
                );
            }

            // Verify the new binary is properly code-signed before we stage it.
            // Applying an unsigned/foreign binary to a privileged location would
            // be a privilege-escalation vector, so reject anything unverified.
            match verify_update_binary(&new_binary_path) {
                Ok(true) => info!("Update binary signature verified"),
                Ok(false) => {
                    error!("Update binary failed signature verification");
                    return DaemonResponse::error(
                        ErrorCode::InvalidSignature as i32,
                        "Update binary failed code-signature verification",
                    );
                }
                Err(e) => {
                    error!("Update binary signature verification error: {}", e);
                    return DaemonResponse::error(
                        ErrorCode::InvalidSignature as i32,
                        format!("Could not verify update binary signature: {}", e),
                    );
                }
            }

            // Copy to staging location
            #[cfg(target_os = "macos")]
            let staging_path = "/Library/PrivilegedHelperTools/com.vpnvpn.daemon.new";
            #[cfg(target_os = "linux")]
            let staging_path = "/usr/local/bin/vpnvpn-daemon.new";
            #[cfg(target_os = "windows")]
            let staging_path = r"C:\Program Files\vpnVPN\vpnvpn-daemon.new.exe";
            #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
            let staging_path = "/tmp/vpnvpn-daemon.new";

            match std::fs::copy(&new_binary_path, staging_path) {
                Ok(_) => {
                    info!("Update staged at {}", staging_path);
                    DaemonResponse::UpdateReady
                }
                Err(e) => {
                    error!("Failed to stage update: {}", e);
                    DaemonResponse::error(ErrorCode::InternalError as i32, e.to_string())
                }
            }
        }

        DaemonRequest::RequestChallenge => {
            debug!("Challenge request from pid {}", client.pid);

            let mut state = state.write().await;
            let nonce = state.auth_nonces.generate();
            let expires_at = chrono::Utc::now()
                + chrono::Duration::from_std(state.auth_nonces.max_age())
                    .unwrap_or_else(|_| chrono::Duration::seconds(30));

            vpnvpn_shared::ipc::DaemonResponse::Challenge { nonce, expires_at }
        }

        DaemonRequest::Authenticate { nonce, .. } => {
            debug!("Authenticate request from pid {} with nonce", client.pid);

            // 1. The nonce must be one this daemon actually issued (and not yet
            //    consumed or expired). `validate` removes it so it cannot be
            //    replayed.
            let nonce_ok = {
                let mut state = state.write().await;
                state.auth_nonces.validate(&nonce)
            };
            if !nonce_ok {
                warn!(
                    "Rejecting authentication from pid {}: unknown/expired nonce",
                    client.pid
                );
                return DaemonResponse::error(
                    ErrorCode::InvalidNonce as i32,
                    "Invalid or expired challenge nonce",
                );
            }

            // 2. The connecting client must pass transport-level verification
            //    (peer credentials on Unix, code-signature on Windows). If the
            //    transport explicitly reported the client as unverified, reject.
            if client.verified == Some(false) {
                warn!(
                    "Rejecting authentication from pid {}: client failed verification",
                    client.pid
                );
                return DaemonResponse::error(
                    ErrorCode::UnauthorizedClient as i32,
                    "Client failed verification",
                );
            }

            // 3. Issue a session token bound to the verified client's pid.
            let token = super::server::generate_session_token();
            {
                let mut state = state.write().await;
                state.add_session(token.clone(), client.pid);
            }

            info!("Authenticated client pid {}", client.pid);
            DaemonResponse::Authenticated {
                session_token: token,
            }
        }
    }
}

/// Verify that an update binary is properly code-signed for the current
/// platform before it is staged into a privileged location.
///
/// - macOS: `codesign --verify --strict --deep` confirms a valid signature.
/// - Windows: Authenticode verification via `WinVerifyTrust` (shared helper).
/// - Linux: there is no OS-level binary signing, so we require a detached
///   signature (`<binary>.sig` / `<binary>.minisig`) verified by an available
///   tool. If no signature is present we refuse the update.
///
/// Returns `Ok(true)` only when the binary is trusted.
fn verify_update_binary(path: &str) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("codesign")
            .args(["--verify", "--strict", "--deep", "--verbose=2", path])
            .output()?;
        if output.status.success() {
            Ok(true)
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!("codesign verification failed: {}", stderr.trim());
            Ok(false)
        }
    }

    #[cfg(target_os = "windows")]
    {
        // NOTE: unverified on host (Windows-only)
        crate::ipc::auth::verify_file_authenticode(std::path::Path::new(path))
    }

    #[cfg(target_os = "linux")]
    {
        verify_update_binary_linux(path)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        let _ = path;
        Ok(false)
    }
}

/// Verify a Linux update binary via a detached signature.
///
/// Looks for `<binary>.minisig` (verified with `minisign`/`rsign`) or
/// `<binary>.sig` (verified with `gpg`). A trusted public key must be available
/// to the verifying tool (minisign `-p` key or the gpg keyring). Without a
/// usable signature the update is rejected.
#[cfg(target_os = "linux")]
fn verify_update_binary_linux(path: &str) -> Result<bool> {
    use std::path::Path;

    let bin = Path::new(path);

    // Optional pinned minisign public key (base64) provided via env/config.
    let minisign_pubkey = std::env::var("VPNVPN_UPDATE_MINISIGN_PUBKEY").ok();

    let minisig = format!("{path}.minisig");
    if Path::new(&minisig).exists() {
        if which("minisign") {
            let mut cmd = std::process::Command::new("minisign");
            cmd.args(["-V", "-m", path, "-x", &minisig]);
            if let Some(key) = &minisign_pubkey {
                cmd.args(["-P", key]);
            }
            let output = cmd.output()?;
            if output.status.success() {
                return Ok(true);
            }
            warn!(
                "minisign verification failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
            return Ok(false);
        }
        warn!("Found {} but minisign is not installed", minisig);
    }

    let sig = format!("{path}.sig");
    if Path::new(&sig).exists() {
        if which("gpg") {
            let output = std::process::Command::new("gpg")
                .args(["--verify", &sig, path])
                .output()?;
            // gpg exits 0 only when the signature is good and from a trusted key.
            if output.status.success() {
                return Ok(true);
            }
            warn!(
                "gpg verification failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
            return Ok(false);
        }
        warn!("Found {} but gpg is not installed", sig);
    }

    warn!(
        "No usable detached signature found for {} (expected {} or {})",
        bin.display(),
        minisig,
        sig
    );
    Ok(false)
}

/// Lightweight check whether a command is available on PATH.
#[cfg(target_os = "linux")]
fn which(cmd: &str) -> bool {
    std::process::Command::new("sh")
        .args(["-c", &format!("command -v {cmd}")])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Normalize a server endpoint to a literal IP address for firewall rules.
///
/// The endpoint may already be an IP (possibly with a `:port` or `[v6]:port`
/// suffix) or a DNS hostname. If it is a literal IP we return it as-is; otherwise
/// we perform a DNS lookup (preferring the first resolved address). Returns
/// `None` if resolution fails so the caller can decide how to degrade.
async fn resolve_server_ip(endpoint: &str, port: u16) -> Option<String> {
    let host = strip_port_from_host(endpoint);

    // Already a literal IP? Use it directly.
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Some(host.to_string());
    }

    // DNS lookup. `lookup_host` takes an owned (String, u16) target.
    match tokio::net::lookup_host((host.clone(), port)).await {
        Ok(addrs) => addrs.map(|a| a.ip().to_string()).next(),
        Err(e) => {
            debug!("DNS lookup for '{}' failed: {}", host, e);
            None
        }
    }
}

/// Strip a trailing `:port` (or bracketed IPv6 `[..]:port`) from a host string,
/// returning just the host portion. A bare IPv6 literal (with multiple colons
/// and no brackets) is returned unchanged.
fn strip_port_from_host(endpoint: &str) -> String {
    let e = endpoint.trim();
    // Bracketed IPv6: [::1]:51820 -> ::1
    if let Some(rest) = e.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            return rest[..end].to_string();
        }
    }
    // host:port where host has no other colon (IPv4 or DNS name).
    if e.matches(':').count() == 1 {
        if let Some((host, _port)) = e.rsplit_once(':') {
            return host.to_string();
        }
    }
    // Bare IPv6 literal or plain host with no port.
    e.to_string()
}

// `server_ip` is only consumed by the macOS/Linux firewall backends; the
// Windows netsh implementation does not take it (yet).
#[cfg_attr(windows, allow(unused_variables))]
async fn enable_kill_switch(
    interface: &str,
    allow_lan: bool,
    server_ip: Option<&str>,
) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        crate::firewall::macos::enable_kill_switch(interface, allow_lan, server_ip)
    }

    #[cfg(target_os = "windows")]
    {
        crate::firewall::windows::enable_kill_switch(interface, allow_lan)
    }

    #[cfg(target_os = "linux")]
    {
        crate::firewall::linux::enable_kill_switch(interface, allow_lan, server_ip)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err(anyhow::anyhow!("Platform not supported"))
    }
}

async fn disable_kill_switch() -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        crate::firewall::macos::disable_kill_switch()
    }

    #[cfg(target_os = "windows")]
    {
        crate::firewall::windows::disable_kill_switch()
    }

    #[cfg(target_os = "linux")]
    {
        crate::firewall::linux::disable_kill_switch()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err(anyhow::anyhow!("Platform not supported"))
    }
}

/// Auto-disconnect VPN when internet connection is lost.
/// This is called by the connectivity monitoring task.
pub async fn auto_disconnect_vpn(state: Arc<RwLock<DaemonState>>) -> Result<()> {
    let mut state_guard = state.write().await;

    // Check if VPN is actually connected
    if state_guard.connection.state != vpnvpn_shared::protocol::ConnectionState::Connected {
        debug!("VPN not connected, skipping auto-disconnect");
        return Ok(());
    }

    info!("Auto-disconnecting VPN due to lost internet connection");

    // Disable kill-switch first if active
    if state_guard.kill_switch_active {
        if let Err(e) = disable_kill_switch().await {
            warn!(
                "Failed to disable kill-switch during auto-disconnect: {}",
                e
            );
        }
        state_guard.kill_switch_active = false;
    }

    // Disconnect based on current protocol
    let protocol = state_guard.connection.protocol;
    let binary_paths = state_guard.settings.binary_paths.clone();
    drop(state_guard); // Release lock before async disconnect

    let result = if let Some(protocol) = protocol {
        match protocol {
            vpnvpn_shared::Protocol::WireGuard => {
                crate::vpn::wireguard::disconnect(&binary_paths).await
            }
            vpnvpn_shared::Protocol::OpenVPN => crate::vpn::openvpn::disconnect().await,
            vpnvpn_shared::Protocol::IKEv2 => crate::vpn::ikev2::disconnect().await,
        }
    } else {
        Ok(())
    };

    // Update state after disconnect
    let mut state_guard = state.write().await;
    match result {
        Ok(()) => {
            state_guard.connection = vpnvpn_shared::ConnectionStatus::default();
            info!("VPN auto-disconnected successfully");
            Ok(())
        }
        Err(e) => {
            error!("Auto-disconnect failed: {}", e);
            // Still update state to disconnected to prevent retry loops
            state_guard.connection = vpnvpn_shared::ConnectionStatus::default();
            Err(e)
        }
    }
}

/// Attempt to re-establish the last connection after an unexpected tunnel drop.
///
/// Called by the reconnect monitor when the daemon believes it is connected but
/// the underlying interface is gone. Honours `auto_reconnect`, skips when the
/// user explicitly disconnected, and applies a capped exponential backoff across
/// attempts. Returns `Ok(true)` if a reconnection succeeded.
pub async fn try_auto_reconnect(state: Arc<RwLock<DaemonState>>) -> Result<bool> {
    // Snapshot what we need without holding the lock across the connect.
    let (enabled, user_disconnected, last_config, binary_paths, split_tunnel, max_attempts, delay) = {
        let s = state.read().await;
        (
            s.settings.auto_reconnect,
            s.user_disconnected,
            s.last_config.clone(),
            s.settings.binary_paths.clone(),
            s.settings.split_tunnel.clone(),
            s.settings.max_reconnect_attempts,
            s.settings.reconnect_delay_secs.max(1),
        )
    };

    if !enabled || user_disconnected {
        return Ok(false);
    }
    let Some(config) = last_config else {
        return Ok(false);
    };

    // 0 = unlimited; cap the loop to a sane number to avoid spinning forever.
    let attempts = if max_attempts == 0 { 10 } else { max_attempts };

    info!("Auto-reconnect: attempting to re-establish the tunnel");
    for attempt in 1..=attempts {
        // Exponential backoff capped at 60s: delay * 2^(attempt-1).
        let backoff = (delay as u64)
            .saturating_mul(1u64 << (attempt - 1).min(6))
            .min(60);
        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;

        // Bail out if the user disconnected while we were waiting.
        if state.read().await.user_disconnected {
            info!("Auto-reconnect cancelled (user disconnected)");
            return Ok(false);
        }

        let result = match config.protocol {
            vpnvpn_shared::Protocol::WireGuard => {
                crate::vpn::wireguard::connect(&config, &binary_paths, &split_tunnel).await
            }
            vpnvpn_shared::Protocol::OpenVPN => {
                crate::vpn::openvpn::connect(&config, &binary_paths).await
            }
            vpnvpn_shared::Protocol::IKEv2 => {
                crate::vpn::ikev2::connect(&config, &binary_paths).await
            }
        };

        match result {
            Ok(mut status) => {
                if status.connected_at.is_none() {
                    status.connected_at = Some(chrono::Utc::now());
                }
                let mut s = state.write().await;
                s.connection = status;
                info!("Auto-reconnect succeeded on attempt {}", attempt);
                return Ok(true);
            }
            Err(e) => {
                warn!(
                    "Auto-reconnect attempt {}/{} failed: {}",
                    attempt, attempts, e
                );
            }
        }
    }

    warn!("Auto-reconnect gave up after {} attempts", attempts);
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use vpnvpn_shared::config::DaemonSettings;

    fn test_state() -> Arc<RwLock<DaemonState>> {
        Arc::new(RwLock::new(DaemonState::new(DaemonSettings::default())))
    }

    fn verified_client(pid: u32) -> ClientContext {
        ClientContext {
            pid,
            uid: Some(501),
            verified: Some(true),
        }
    }

    /// A full challenge -> authenticate round-trip should issue a session token
    /// bound to the verified client's pid.
    #[tokio::test]
    async fn challenge_then_authenticate_succeeds() {
        let state = test_state();
        let client = verified_client(4242);

        // 1. Request a challenge.
        let challenge = handle_request_with_client(
            state.clone(),
            DaemonRequest::RequestChallenge,
            client.clone(),
            None,
        )
        .await;
        let nonce = match challenge {
            DaemonResponse::Challenge { nonce, .. } => nonce,
            other => panic!("expected Challenge, got {:?}", other),
        };
        assert!(!nonce.is_empty());

        // 2. Authenticate with the issued nonce.
        let auth = handle_request_with_client(
            state.clone(),
            DaemonRequest::Authenticate {
                nonce: nonce.clone(),
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                signature: None,
            },
            client.clone(),
            None,
        )
        .await;

        let token = match auth {
            DaemonResponse::Authenticated { session_token } => session_token,
            other => panic!("expected Authenticated, got {:?}", other),
        };

        // The session should be recorded and bound to the client's pid.
        let guard = state.read().await;
        assert!(guard.validate_session(&token));
        assert!(guard.sessions.iter().any(|s| s.client_pid == 4242));
    }

    /// A nonce can only be used once; replaying it must fail.
    #[tokio::test]
    async fn nonce_cannot_be_replayed() {
        let state = test_state();
        let client = verified_client(1);

        let nonce = match handle_request_with_client(
            state.clone(),
            DaemonRequest::RequestChallenge,
            client.clone(),
            None,
        )
        .await
        {
            DaemonResponse::Challenge { nonce, .. } => nonce,
            other => panic!("expected Challenge, got {:?}", other),
        };

        let mk_auth = || DaemonRequest::Authenticate {
            nonce: nonce.clone(),
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            signature: None,
        };

        // First use succeeds.
        assert!(matches!(
            handle_request_with_client(state.clone(), mk_auth(), client.clone(), None).await,
            DaemonResponse::Authenticated { .. }
        ));

        // Second use of the same nonce is rejected.
        assert!(matches!(
            handle_request_with_client(state.clone(), mk_auth(), client.clone(), None).await,
            DaemonResponse::Error(_)
        ));
    }

    /// Authenticating with a nonce the daemon never issued must be rejected.
    #[tokio::test]
    async fn unknown_nonce_is_rejected() {
        let state = test_state();
        let client = verified_client(7);

        let resp = handle_request_with_client(
            state,
            DaemonRequest::Authenticate {
                nonce: "this-was-never-issued".to_string(),
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                signature: None,
            },
            client,
            None,
        )
        .await;

        match resp {
            DaemonResponse::Error(e) => {
                assert_eq!(e.code, ErrorCode::InvalidNonce as i32);
            }
            other => panic!("expected Error, got {:?}", other),
        }
    }

    /// A client the transport flagged as failing verification must be rejected
    /// even if it presents a valid nonce.
    #[tokio::test]
    async fn unverified_client_is_rejected() {
        let state = test_state();
        let issue_client = verified_client(10);

        let nonce = match handle_request_with_client(
            state.clone(),
            DaemonRequest::RequestChallenge,
            issue_client,
            None,
        )
        .await
        {
            DaemonResponse::Challenge { nonce, .. } => nonce,
            other => panic!("expected Challenge, got {:?}", other),
        };

        let bad_client = ClientContext {
            pid: 99,
            uid: None,
            verified: Some(false),
        };

        let resp = handle_request_with_client(
            state,
            DaemonRequest::Authenticate {
                nonce,
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                signature: None,
            },
            bad_client,
            None,
        )
        .await;

        match resp {
            DaemonResponse::Error(e) => {
                assert_eq!(e.code, ErrorCode::UnauthorizedClient as i32);
            }
            other => panic!("expected Error, got {:?}", other),
        }
    }

    /// Auto-reconnect must NOT fire after an explicit user disconnect.
    #[tokio::test]
    async fn auto_reconnect_skips_after_user_disconnect() {
        let state = test_state();
        {
            let mut s = state.write().await;
            s.settings.auto_reconnect = true;
            s.user_disconnected = true;
            s.last_config = Some(vpnvpn_shared::protocol::VpnConfig::default());
        }
        assert!(!try_auto_reconnect(state).await.unwrap());
    }

    /// Auto-reconnect is a no-op when there is no remembered config.
    #[tokio::test]
    async fn auto_reconnect_noop_without_last_config() {
        let state = test_state();
        {
            let mut s = state.write().await;
            s.settings.auto_reconnect = true;
            s.user_disconnected = false;
            s.last_config = None;
        }
        assert!(!try_auto_reconnect(state).await.unwrap());
    }

    /// Auto-reconnect is a no-op when disabled in settings.
    #[tokio::test]
    async fn auto_reconnect_noop_when_disabled() {
        let state = test_state();
        {
            let mut s = state.write().await;
            s.settings.auto_reconnect = false;
            s.last_config = Some(vpnvpn_shared::protocol::VpnConfig::default());
        }
        assert!(!try_auto_reconnect(state).await.unwrap());
    }

    #[test]
    fn strip_port_handles_ipv4_host_and_ipv6() {
        // IPv4 with port.
        assert_eq!(strip_port_from_host("203.0.113.7:51820"), "203.0.113.7");
        // DNS host with port.
        assert_eq!(
            strip_port_from_host("vpn.example.com:1194"),
            "vpn.example.com"
        );
        // Bare DNS host, no port.
        assert_eq!(strip_port_from_host("vpn.example.com"), "vpn.example.com");
        // Bracketed IPv6 with port.
        assert_eq!(strip_port_from_host("[2001:db8::1]:500"), "2001:db8::1");
        // Bare IPv6 literal (multiple colons, no brackets) -> unchanged.
        assert_eq!(strip_port_from_host("2001:db8::1"), "2001:db8::1");
    }

    #[tokio::test]
    async fn resolve_server_ip_passes_through_literal_ip() {
        // A literal IP must be returned unchanged (no DNS lookup needed).
        assert_eq!(
            resolve_server_ip("198.51.100.10", 51820).await.as_deref(),
            Some("198.51.100.10")
        );
        // Literal IP with port suffix is stripped to the IP.
        assert_eq!(
            resolve_server_ip("198.51.100.10:51820", 51820)
                .await
                .as_deref(),
            Some("198.51.100.10")
        );
    }

    #[tokio::test]
    async fn ping_returns_pong() {
        let state = test_state();
        assert!(matches!(
            handle_request_with_client(state, DaemonRequest::Ping, ClientContext::default(), None)
                .await,
            DaemonResponse::Pong
        ));
    }

    /// Read-only discovery requests are open: they succeed without a token.
    #[tokio::test]
    async fn read_only_requests_are_open() {
        let state = test_state();
        let client = verified_client(123);

        assert!(matches!(
            handle_request_with_client(
                state.clone(),
                DaemonRequest::GetStatus,
                client.clone(),
                None
            )
            .await,
            DaemonResponse::Status(_)
        ));
        assert!(matches!(
            handle_request_with_client(state, DaemonRequest::GetConnectionStatus, client, None)
                .await,
            DaemonResponse::ConnectionStatus(_)
        ));
    }

    /// A privileged request with no session token is rejected with
    /// AuthenticationFailed so the client knows to (re-)handshake.
    #[tokio::test]
    async fn privileged_request_without_token_is_rejected() {
        let state = test_state();
        let client = verified_client(321);

        let resp = handle_request_with_client(state, DaemonRequest::Disconnect, client, None).await;

        match resp {
            DaemonResponse::Error(e) => {
                assert_eq!(e.code, ErrorCode::AuthenticationFailed as i32);
            }
            other => panic!("expected auth Error, got {:?}", other),
        }
    }

    /// A privileged request bearing a valid, peer-bound session token passes the
    /// gate and is dispatched (Disconnect with no active VPN returns Ok).
    #[tokio::test]
    async fn privileged_request_with_valid_token_is_allowed() {
        let state = test_state();
        let client = verified_client(555);

        // Run the handshake to obtain a real session token.
        let nonce = match handle_request_with_client(
            state.clone(),
            DaemonRequest::RequestChallenge,
            client.clone(),
            None,
        )
        .await
        {
            DaemonResponse::Challenge { nonce, .. } => nonce,
            other => panic!("expected Challenge, got {:?}", other),
        };
        let token = match handle_request_with_client(
            state.clone(),
            DaemonRequest::Authenticate {
                nonce,
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                signature: None,
            },
            client.clone(),
            None,
        )
        .await
        {
            DaemonResponse::Authenticated { session_token } => session_token,
            other => panic!("expected Authenticated, got {:?}", other),
        };

        // Disconnect with no active connection short-circuits to Ok.
        let resp =
            handle_request_with_client(state, DaemonRequest::Disconnect, client, Some(token)).await;
        assert!(
            matches!(resp, DaemonResponse::Ok),
            "expected Ok, got {:?}",
            resp
        );
    }

    /// A valid token presented by a different pid than it was issued to is
    /// rejected (peer binding).
    #[tokio::test]
    async fn token_bound_to_other_pid_is_rejected() {
        let state = test_state();
        let issuer = verified_client(1000);

        let nonce = match handle_request_with_client(
            state.clone(),
            DaemonRequest::RequestChallenge,
            issuer.clone(),
            None,
        )
        .await
        {
            DaemonResponse::Challenge { nonce, .. } => nonce,
            other => panic!("expected Challenge, got {:?}", other),
        };
        let token = match handle_request_with_client(
            state.clone(),
            DaemonRequest::Authenticate {
                nonce,
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                signature: None,
            },
            issuer,
            None,
        )
        .await
        {
            DaemonResponse::Authenticated { session_token } => session_token,
            other => panic!("expected Authenticated, got {:?}", other),
        };

        // A different (non-zero) pid presenting the same token must be rejected.
        let attacker = verified_client(2000);
        let resp =
            handle_request_with_client(state, DaemonRequest::Disconnect, attacker, Some(token))
                .await;
        match resp {
            DaemonResponse::Error(e) => {
                assert_eq!(e.code, ErrorCode::AuthenticationFailed as i32);
            }
            other => panic!("expected auth Error, got {:?}", other),
        }
    }
}

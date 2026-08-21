#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// In the `test` profile `main` is `#[cfg(not(test))]`, so every Tauri command
// (only referenced from `generate_handler!` inside `main`) appears unused. Allow
// dead code under test so `cargo clippy --all-targets` stays green.
#![cfg_attr(test, allow(dead_code))]

mod daemon_client;
mod tray;

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::io::Read;
use std::path::PathBuf;

#[cfg(any(windows, target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

#[derive(Serialize)]
struct Health {
    ok: bool,
}

#[tauri::command]
fn health_check() -> Health {
    Health { ok: true }
}

/// Get a unique machine identifier for this device.
/// This is used to identify devices across reconnections to avoid creating
/// duplicate device entries.
#[tauri::command]
fn get_machine_id() -> String {
    // Try to get machine ID from the machine-uid crate
    // Falls back to hostname if that fails
    match machine_uid::get() {
        Ok(id) => id,
        Err(_) => {
            // Fallback: use hostname + username hash
            let hostname = std::env::var("HOSTNAME")
                .or_else(|_| std::env::var("COMPUTERNAME"))
                .unwrap_or_else(|_| "unknown-host".to_string());
            let username = std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .unwrap_or_else(|_| "unknown-user".to_string());
            format!("{}@{}", username, hostname)
        }
    }
}

// ============ Channel & daemon artifact resolution ============

/// Resolve the active application channel.
/// Priority: APP_CHANNEL env -> debug builds default to devel -> prod otherwise.
fn app_channel() -> String {
    let raw = std::env::var("APP_CHANNEL").ok().map(|v| v.to_lowercase());

    match raw.as_deref() {
        Some("prod") | Some("production") => "prod".into(),
        Some("staging") | Some("stage") => "staging".into(),
        Some("devel") | Some("dev") | Some("development") => "devel".into(),
        _ if cfg!(debug_assertions) => "devel".into(),
        _ => "prod".into(),
    }
}

/// Generate a WireGuard keypair using wg genkey.
/// Returns both private and public keys. The private key should be stored
/// securely on the client and never sent to the server.
#[tauri::command]
fn generate_wireguard_keys() -> Result<(String, String), String> {
    use std::process::Command;

    // Generate private key using wg genkey
    let private_key_output = Command::new("wg").arg("genkey").output().map_err(|e| {
        format!(
            "Failed to run wg genkey: {}. Make sure WireGuard is installed.",
            e
        )
    })?;

    if !private_key_output.status.success() {
        let stderr = String::from_utf8_lossy(&private_key_output.stderr);
        return Err(format!("wg genkey failed: {}", stderr));
    }

    let private_key = String::from_utf8_lossy(&private_key_output.stdout)
        .trim()
        .to_string();

    // Derive public key from private key
    let mut public_key_process = Command::new("wg")
        .arg("pubkey")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to run wg pubkey: {}", e))?;

    use std::io::Write;
    if let Some(mut stdin) = public_key_process.stdin.take() {
        stdin
            .write_all(private_key.as_bytes())
            .map_err(|e| format!("Failed to write to wg pubkey stdin: {}", e))?;
    }

    let public_key_output = public_key_process
        .wait_with_output()
        .map_err(|e| format!("Failed to get wg pubkey output: {}", e))?;

    if !public_key_output.status.success() {
        let stderr = String::from_utf8_lossy(&public_key_output.stderr);
        return Err(format!("wg pubkey failed: {}", stderr));
    }

    let public_key = String::from_utf8_lossy(&public_key_output.stdout)
        .trim()
        .to_string();

    Ok((private_key, public_key))
}

/// Status of VPN tool availability on the system (legacy format for frontend compatibility).
#[derive(Serialize, Clone)]
struct VpnToolsStatus {
    wireguard_available: bool,
    wireguard_path: Option<String>,
    openvpn_available: bool,
    openvpn_path: Option<String>,
    ikev2_available: bool,
    ikev2_path: Option<String>,
}

/// Daemon status returned to the frontend with additional metadata.
#[derive(Serialize, Clone, Default)]
struct DaemonStatusWithMeta {
    running: bool,
    version: String,
    uptime_secs: u64,
    has_network_permission: bool,
    has_firewall_permission: bool,
    kill_switch_active: bool,
    /// App channel (prod/staging/devel).
    channel: String,
    /// Where the binary was resolved from (downloaded/bundled/system/dev-socket).
    source: String,
    /// Resolved daemon binary path, if any.
    binary_path: Option<String>,
    /// Whether using the dev socket (/tmp/...).
    using_dev_socket: bool,
}

/// Detect VPN tools - delegates to daemon if available, otherwise uses fallback detection.
#[tauri::command]
fn detect_vpn_tools() -> VpnToolsStatus {
    eprintln!("[tauri] detect_vpn_tools called");

    // Try to get tools from daemon first
    if daemon_client::is_daemon_available() {
        eprintln!("[tauri] Daemon available, getting tools from daemon");

        match daemon_client::get_vpn_tools() {
            Ok(tools) => {
                eprintln!("[tauri] Got tools from daemon: {:?}", tools);
                return VpnToolsStatus {
                    wireguard_available: tools.wireguard.available,
                    wireguard_path: tools.wireguard.path,
                    openvpn_available: tools.openvpn.available,
                    openvpn_path: tools.openvpn.path,
                    ikev2_available: tools.ikev2.available,
                    ikev2_path: tools.ikev2.path,
                };
            }
            Err(e) => {
                eprintln!(
                    "[tauri] Failed to get tools from daemon: {}, using fallback",
                    e
                );
            }
        }
    } else {
        eprintln!("[tauri] Daemon not available, using fallback detection");
    }

    // Fallback: basic detection when daemon is not available
    detect_vpn_tools_fallback()
}

/// Fallback VPN tool detection when daemon is not running.
/// This is a simplified version that doesn't support custom paths.
fn detect_vpn_tools_fallback() -> VpnToolsStatus {
    VpnToolsStatus {
        wireguard_available: find_command_basic("wg-quick").is_some(),
        wireguard_path: find_command_basic("wg-quick"),
        openvpn_available: find_command_basic("openvpn").is_some(),
        openvpn_path: find_command_basic("openvpn"),
        ikev2_available: find_command_basic_ikev2(),
        ikev2_path: get_ikev2_path_basic(),
    }
}

/// Basic command detection for fallback mode.
fn find_command_basic(cmd: &str) -> Option<String> {
    // Check common paths
    let common_paths = [
        format!("/opt/homebrew/bin/{}", cmd),
        format!("/opt/homebrew/sbin/{}", cmd),
        format!("/usr/local/bin/{}", cmd),
        format!("/usr/local/sbin/{}", cmd),
        format!("/usr/bin/{}", cmd),
        format!("/usr/sbin/{}", cmd),
        format!("/bin/{}", cmd),
        format!("/sbin/{}", cmd),
    ];

    for path in common_paths {
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }

    // Try which command
    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(output) = std::process::Command::new("which").arg(cmd).output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(path);
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("where").arg(cmd).output() {
            if output.status.success() {
                if let Some(path) = String::from_utf8_lossy(&output.stdout).lines().next() {
                    let path = path.trim().to_string();
                    if !path.is_empty() {
                        return Some(path);
                    }
                }
            }
        }
    }

    None
}

/// Check IKEv2 tool availability (platform-specific).
fn find_command_basic_ikev2() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::path::Path::new("/usr/sbin/networksetup").exists()
    }
    #[cfg(target_os = "linux")]
    {
        find_command_basic("ipsec").is_some() || find_command_basic("nmcli").is_some()
    }
    #[cfg(target_os = "windows")]
    {
        std::path::Path::new(r"C:\Windows\System32\rasdial.exe").exists()
    }
}

/// Get IKEv2 tool path (platform-specific).
fn get_ikev2_path_basic() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        Some("/usr/sbin/networksetup".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        find_command_basic("ipsec").or_else(|| find_command_basic("nmcli"))
    }
    #[cfg(target_os = "windows")]
    {
        Some(r"C:\Windows\System32\rasdial.exe".to_string())
    }
}

/// Refresh VPN tools detection (triggers daemon to re-detect).
#[tauri::command]
fn refresh_vpn_tools() -> Result<VpnToolsStatus, String> {
    eprintln!("[tauri] refresh_vpn_tools called");

    if !daemon_client::is_daemon_available() {
        return Err("Daemon not available. Start the daemon to refresh tools.".to_string());
    }

    let tools = daemon_client::refresh_vpn_tools()?;

    Ok(VpnToolsStatus {
        wireguard_available: tools.wireguard.available,
        wireguard_path: tools.wireguard.path,
        openvpn_available: tools.openvpn.available,
        openvpn_path: tools.openvpn.path,
        ikev2_available: tools.ikev2.available,
        ikev2_path: tools.ikev2.path,
    })
}

/// Update VPN binary paths in daemon settings.
#[tauri::command]
fn update_vpn_binary_paths(
    wg_quick_path: Option<String>,
    wireguard_cli_path: Option<String>,
    openvpn_path: Option<String>,
    ikev2_path: Option<String>,
) -> Result<VpnToolsStatus, String> {
    eprintln!("[tauri] update_vpn_binary_paths called");
    eprintln!("[tauri] wg_quick_path: {:?}", wg_quick_path);
    eprintln!("[tauri] openvpn_path: {:?}", openvpn_path);

    if !daemon_client::is_daemon_available() {
        return Err("Daemon not available. Start the daemon to update binary paths.".to_string());
    }

    let paths = daemon_client::VpnBinaryPaths {
        wg_quick_path,
        wireguard_cli_path,
        openvpn_path,
        ikev2_path,
    };

    let tools = daemon_client::update_binary_paths(paths)?;

    Ok(VpnToolsStatus {
        wireguard_available: tools.wireguard.available,
        wireguard_path: tools.wireguard.path,
        openvpn_available: tools.openvpn.available,
        openvpn_path: tools.openvpn.path,
        ikev2_available: tools.ikev2.available,
        ikev2_path: tools.ikev2.path,
    })
}

/// Get detailed VPN tools info from daemon (includes version, custom paths, errors).
#[tauri::command]
fn get_vpn_tools_detailed() -> Result<daemon_client::VpnToolsStatus, String> {
    eprintln!("[tauri] get_vpn_tools_detailed called");

    if !daemon_client::is_daemon_available() {
        return Err("Daemon not available".to_string());
    }

    daemon_client::get_vpn_tools()
}

#[derive(Serialize, Deserialize, Clone)]
struct DesktopSettings {
    preferred_protocol: String,
    auto_connect: bool,
    wg_quick_path: Option<String>,
    openvpn_path: Option<String>,
    wireguard_cli_path: Option<String>,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            preferred_protocol: "wireguard".into(),
            auto_connect: false,
            wg_quick_path: None,
            openvpn_path: None,
            wireguard_cli_path: None,
        }
    }
}

fn config_path() -> Result<PathBuf, String> {
    use std::fs;

    let base = if cfg!(target_os = "windows") {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .map_err(|e| format!("APPDATA not set: {e}"))?
    } else if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {e}"))?;
        PathBuf::from(home).join("Library/Application Support")
    } else {
        let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {e}"))?;
        PathBuf::from(home).join(".config")
    };

    let dir = base.join("vpnvpn-desktop");
    fs::create_dir_all(&dir).map_err(|e| format!("failed to create config dir {dir:?}: {e}"))?;
    Ok(dir.join("settings.json"))
}

fn load_settings() -> Result<DesktopSettings, String> {
    use std::fs;

    let path = config_path()?;
    if !path.exists() {
        return Ok(DesktopSettings::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| format!("failed to read settings: {e}"))?;
    let parsed: DesktopSettings =
        serde_json::from_str(&data).map_err(|e| format!("failed to parse settings: {e}"))?;
    Ok(parsed)
}

fn save_settings(settings: &DesktopSettings) -> Result<(), String> {
    use std::fs;

    let path = config_path()?;
    let data = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("failed to serialise settings: {e}"))?;
    fs::write(&path, data).map_err(|e| format!("failed to write settings: {e}"))?;
    Ok(())
}

#[tauri::command]
fn get_desktop_settings() -> Result<DesktopSettings, String> {
    load_settings()
}

#[derive(Deserialize)]
struct DesktopSettingsUpdate {
    preferred_protocol: Option<String>,
    auto_connect: Option<bool>,
    wg_quick_path: Option<String>,
    openvpn_path: Option<String>,
    wireguard_cli_path: Option<String>,
}

/// Convert empty string to None for path settings
fn normalize_path(path: Option<String>) -> Option<String> {
    path.filter(|p| !p.trim().is_empty())
}

#[tauri::command]
fn update_desktop_settings(update: DesktopSettingsUpdate) -> Result<DesktopSettings, String> {
    let mut current = load_settings()?;

    if let Some(p) = update.preferred_protocol {
        current.preferred_protocol = p;
    }
    if let Some(ac) = update.auto_connect {
        current.auto_connect = ac;
    }
    if update.wg_quick_path.is_some() {
        current.wg_quick_path = normalize_path(update.wg_quick_path);
    }
    if update.openvpn_path.is_some() {
        current.openvpn_path = normalize_path(update.openvpn_path);
    }
    if update.wireguard_cli_path.is_some() {
        current.wireguard_cli_path = normalize_path(update.wireguard_cli_path);
    }

    save_settings(&current)?;
    Ok(current)
}

// Direct-disconnect fallbacks used when no daemon-managed session is active
// (connect now always goes through the daemon for kill-switch support).

fn disconnect_wireguard_internal() -> Result<(), String> {
    let settings = load_settings().unwrap_or_default();
    let bin = settings.wg_quick_path.unwrap_or_else(|| "wg-quick".into());

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mut path: PathBuf = std::env::temp_dir();
        path.push("vpnvpn-wg.conf");
        let _ = run_command(&bin, &["down", path.to_string_lossy().as_ref()]);
    }

    #[cfg(target_os = "windows")]
    {
        let wireguard_cli = settings
            .wireguard_cli_path
            .unwrap_or_else(|| "wireguard.exe".into());
        let _ = run_command(
            &wireguard_cli,
            &["/uninstalltunnelservice", "vpnvpn-desktop"],
        );
    }

    Ok(())
}

fn disconnect_openvpn() -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let _ = run_command("pkill", &["openvpn"]);
    }

    #[cfg(target_os = "windows")]
    {
        let _ = run_command("taskkill", &["/IM", "openvpn.exe", "/F"]);
    }

    Ok(())
}

fn disconnect_ikev2() -> Result<(), String> {
    Ok(())
}

/// Credentials for VPN authentication.
#[derive(Deserialize)]
struct VpnCredentials {
    username: String,
    password: String,
}

/// Result of `apply_vpn_config`, surfaced to the frontend.
///
/// `pending_approval` is the macOS IKEv2 first-run state: the daemon wrote the
/// .mobileconfig and opened it, but the user has not yet approved the VPN
/// profile in System Settings. Not an error — the UI shows an instruction and
/// a retry affordance.
#[derive(Serialize)]
struct ApplyVpnConfigResult {
    pending_approval: bool,
    state: String,
}

/// Apply VPN configuration - requires daemon to be running.
/// The daemon handles all VPN operations for security and kill-switch support.
#[tauri::command]
fn apply_vpn_config(
    protocol: String,
    config: String,
    credentials: Option<VpnCredentials>,
) -> Result<ApplyVpnConfigResult, String> {
    eprintln!("[apply_vpn_config] Called with protocol: {}", protocol);
    eprintln!("[apply_vpn_config] Config:\n{}", config);

    // Parse the config string to extract VPN parameters
    let vpn_config = parse_vpn_config(&protocol, &config, credentials)?;

    eprintln!(
        "[apply_vpn_config] Parsed config: endpoint={}:{}",
        vpn_config.server_endpoint, vpn_config.server_port
    );

    // Connect via daemon
    match daemon_client::connect_vpn(vpn_config) {
        Ok(status) => {
            eprintln!(
                "[apply_vpn_config] Connection request completed (state={})",
                status.state
            );
            Ok(ApplyVpnConfigResult {
                pending_approval: status.state == "pending_approval",
                state: status.state,
            })
        }
        Err(err) => {
            let logs = collect_daemon_log_tail(40);
            let payload = json!({
                "code": "connect_failed",
                "message": err,
                "logs": logs,
            });
            let msg = serde_json::to_string(&payload).unwrap_or_else(|_| {
                "Failed to connect to VPN (and failed to serialize error payload)".to_string()
            });
            Err(msg)
        }
    }
}

/// Is the vpnVPN IKEv2 profile installed (i.e. approved by the user) on macOS?
///
/// Uses read-only `scutil --nc list` and matches the exact quoted service name
/// installed by the daemon's .mobileconfig (UserDefinedName "vpnVPN IKEv2").
/// Always false on non-macOS platforms. The frontend uses this to gate IKEv2
/// auto-connect: once the profile exists, connecting is fully scriptable.
#[tauri::command]
fn ikev2_profile_installed() -> bool {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("scutil")
            .args(["--nc", "list"])
            .output();
        match output {
            Ok(o) => String::from_utf8_lossy(&o.stdout).contains("\"vpnVPN IKEv2\""),
            Err(_) => false,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

fn collect_daemon_log_tail(limit: usize) -> Option<Vec<String>> {
    match tail_daemon_logs(None) {
        Ok(chunk) => {
            let len = chunk.lines.len();
            let start = len.saturating_sub(limit);
            Some(chunk.lines[start..].to_vec())
        }
        Err(_) => None,
    }
}

/// Parse VPN config string into daemon VpnConfig struct.
fn parse_vpn_config(
    protocol: &str,
    config: &str,
    credentials: Option<VpnCredentials>,
) -> Result<daemon_client::VpnConfig, String> {
    match protocol {
        "wireguard" => parse_wireguard_config(config, credentials),
        "openvpn" => Ok(daemon_client::VpnConfig {
            protocol: "openvpn".to_string(),
            server_id: String::new(),
            server_region: String::new(),
            server_endpoint: String::new(),
            server_port: 1194,
            wg_private_key: None,
            wg_public_key: None,
            wg_server_public_key: None,
            wg_preshared_key: None,
            assigned_ip: None,
            ovpn_config: Some(config.to_string()),
            ikev2_identity: None,
            ikev2_remote_id: None,
            username: credentials.as_ref().map(|c| c.username.clone()),
            password: credentials.as_ref().map(|c| c.password.clone()),
            dns_servers: vec!["1.1.1.1".to_string()],
        }),
        "ikev2" => parse_ikev2_config(config, credentials),
        other => Err(format!("unsupported protocol: {other}")),
    }
}

/// Parse WireGuard config into VpnConfig.
fn parse_wireguard_config(
    config: &str,
    credentials: Option<VpnCredentials>,
) -> Result<daemon_client::VpnConfig, String> {
    let mut private_key = None;
    let mut address = None;
    let mut dns = vec![];
    let mut public_key = None;
    let mut endpoint = None;
    let mut preshared_key = None;

    for line in config.lines() {
        let line = line.trim();
        if line.starts_with("PrivateKey") {
            private_key = line
                .split_once('=')
                .map(|x| x.1)
                .map(|s| s.trim().to_string());
        } else if line.starts_with("Address") {
            address = line
                .split_once('=')
                .map(|x| x.1)
                .map(|s| s.trim().split('/').next().unwrap_or("").to_string());
        } else if line.starts_with("DNS") {
            dns = line
                .split_once('=')
                .map(|x| x.1)
                .map(|s| s.split(',').map(|d| d.trim().to_string()).collect())
                .unwrap_or_default();
        } else if line.starts_with("PublicKey") {
            public_key = line
                .split_once('=')
                .map(|x| x.1)
                .map(|s| s.trim().to_string());
        } else if line.starts_with("PresharedKey") {
            preshared_key = line
                .split_once('=')
                .map(|x| x.1)
                .map(|s| s.trim().to_string());
        } else if line.starts_with("Endpoint") {
            endpoint = line
                .split_once('=')
                .map(|x| x.1)
                .map(|s| s.trim().to_string());
        }
    }

    let (server_endpoint, server_port) = endpoint
        .as_ref()
        .and_then(|e| {
            let e = e.trim();
            if e.is_empty() {
                return None;
            }
            let parts: Vec<&str> = e.rsplitn(2, ':').collect();
            if parts.len() == 2 {
                let port = parts[0].parse().unwrap_or(51820);
                let host = parts[1].trim();
                if !host.is_empty() {
                    Some((host.to_string(), port))
                } else {
                    None
                }
            } else {
                // No port specified, use default
                Some((e.to_string(), 51820))
            }
        })
        .unwrap_or_else(|| ("localhost".to_string(), 51820)); // Default to localhost for dev

    Ok(daemon_client::VpnConfig {
        protocol: "wireguard".to_string(),
        server_id: String::new(),
        server_region: String::new(),
        server_endpoint,
        server_port,
        wg_private_key: private_key,
        wg_public_key: None,
        wg_server_public_key: public_key,
        wg_preshared_key: preshared_key,
        assigned_ip: address,
        ovpn_config: None,
        ikev2_identity: None,
        ikev2_remote_id: None,
        username: credentials.as_ref().map(|c| c.username.clone()),
        password: credentials.as_ref().map(|c| c.password.clone()),
        dns_servers: if dns.is_empty() {
            vec!["1.1.1.1".to_string()]
        } else {
            dns
        },
    })
}

/// Parse IKEv2 config into VpnConfig.
fn parse_ikev2_config(
    config: &str,
    credentials: Option<VpnCredentials>,
) -> Result<daemon_client::VpnConfig, String> {
    // IKEv2 config is typically just server info
    // Format: server=endpoint;identity=...;remote_id=...
    let mut server_endpoint = String::new();
    let mut identity = None;
    let mut remote_id = None;

    for part in config.split(';') {
        let kv: Vec<&str> = part.splitn(2, '=').collect();
        if kv.len() == 2 {
            match kv[0].trim() {
                "server" | "endpoint" => server_endpoint = kv[1].trim().to_string(),
                "identity" => identity = Some(kv[1].trim().to_string()),
                "remote_id" => remote_id = Some(kv[1].trim().to_string()),
                _ => {}
            }
        }
    }

    Ok(daemon_client::VpnConfig {
        protocol: "ikev2".to_string(),
        server_id: String::new(),
        server_region: String::new(),
        server_endpoint,
        server_port: 500,
        wg_private_key: None,
        wg_public_key: None,
        wg_server_public_key: None,
        wg_preshared_key: None,
        assigned_ip: None,
        ovpn_config: None,
        ikev2_identity: identity,
        ikev2_remote_id: remote_id,
        username: credentials.as_ref().map(|c| c.username.clone()),
        password: credentials.as_ref().map(|c| c.password.clone()),
        dns_servers: vec!["1.1.1.1".to_string()],
    })
}

/// Status of VPN connection
#[derive(Serialize, Clone, Default)]
struct VpnConnectionStatus {
    is_connected: bool,
    protocol: Option<String>,
    interface_name: Option<String>,
    /// Total bytes sent/received over the tunnel (live, from the daemon).
    bytes_sent: Option<u64>,
    bytes_received: Option<u64>,
    /// When the tunnel was established (RFC3339), to derive session duration.
    connected_at: Option<String>,
    /// Assigned tunnel IP / server identifiers for display.
    assigned_ip: Option<String>,
    server_id: Option<String>,
    server_region: Option<String>,
}

/// Check if WireGuard interface is active
fn check_wireguard_status() -> Option<String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        // Check if the wg interface exists by running `wg show`
        let output = std::process::Command::new("wg")
            .arg("show")
            .arg("interfaces")
            .output()
            .ok()?;

        if output.status.success() {
            let interfaces = String::from_utf8_lossy(&output.stdout);
            // Filter for vpnVPN's specific interface instead of returning any WG interface
            for iface in interfaces.split_whitespace() {
                if iface.starts_with("vpnvpn-wg") {
                    return Some(iface.to_string());
                }
            }
        }
        None
    }

    #[cfg(target_os = "windows")]
    {
        // On Windows, check via wireguard.exe /dumplog or service status
        let output = std::process::Command::new("sc")
            .args(["query", "WireGuardTunnel$vpnvpn-wg"])
            .output()
            .ok()?;

        if output.status.success() {
            let out = String::from_utf8_lossy(&output.stdout);
            if out.contains("RUNNING") {
                return Some("vpnvpn-wg".to_string());
            }
        }
        None
    }
}

/// Check if OpenVPN process is running
fn check_openvpn_status() -> bool {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let output = std::process::Command::new("pgrep")
            .arg("openvpn")
            .output()
            .ok();

        matches!(output, Some(o) if o.status.success())
    }

    #[cfg(target_os = "windows")]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq openvpn.exe"])
            .output()
            .ok();

        if let Some(o) = output {
            let out = String::from_utf8_lossy(&o.stdout);
            return out.contains("openvpn.exe");
        }
        false
    }
}

/// Check VPN connection status via daemon.
#[tauri::command]
fn check_vpn_status() -> VpnConnectionStatus {
    // Try to get status from daemon
    match daemon_client::get_connection_status() {
        Ok(status) => VpnConnectionStatus {
            is_connected: status.state == "connected",
            protocol: status.protocol,
            interface_name: status.interface_name,
            bytes_sent: status.bytes_sent,
            bytes_received: status.bytes_received,
            connected_at: status.connected_at,
            assigned_ip: status.assigned_ip,
            server_id: status.server_id,
            server_region: status.server_region,
        },
        Err(_) => {
            // Daemon not available, check legacy way as fallback
            check_vpn_status_legacy()
        }
    }
}

/// Legacy VPN status check (fallback when daemon not running).
fn check_vpn_status_legacy() -> VpnConnectionStatus {
    // Check WireGuard first
    if let Some(iface) = check_wireguard_status() {
        return VpnConnectionStatus {
            is_connected: true,
            protocol: Some("wireguard".to_string()),
            interface_name: Some(iface),
            ..Default::default()
        };
    }

    // Check OpenVPN
    if check_openvpn_status() {
        return VpnConnectionStatus {
            is_connected: true,
            protocol: Some("openvpn".to_string()),
            interface_name: None,
            ..Default::default()
        };
    }

    // Not connected
    VpnConnectionStatus::default()
}

/// Disconnect VPN — try daemon first, fall back to legacy if daemon is unavailable.
#[tauri::command]
fn disconnect_vpn(protocol: Option<String>) -> Result<(), String> {
    if daemon_client::disconnect_vpn().is_ok() {
        return Ok(());
    }
    // Daemon unavailable — fall back to direct disconnect
    match protocol.as_deref() {
        Some("wireguard") => disconnect_wireguard_internal(),
        Some("openvpn") => disconnect_openvpn(),
        Some("ikev2") => disconnect_ikev2(),
        _ => {
            let _ = disconnect_wireguard_internal();
            disconnect_openvpn()
        }
    }
}

// Backwards-compatible wrappers used by older frontends.
#[tauri::command]
fn apply_wireguard_config(config: String) -> Result<(), String> {
    apply_vpn_config("wireguard".into(), config, None).map(|_| ())
}

#[tauri::command]
fn disconnect_wireguard() -> Result<(), String> {
    disconnect_vpn(Some("wireguard".into()))
}

#[allow(dead_code)]
fn run_command(program: &str, args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new(program)
        .args(args)
        .status()
        .map_err(|e| format!("failed to run {program}: {e}"))?;

    if !status.success() {
        return Err(format!("{program} exited with status {status}"));
    }

    Ok(())
}

// ============ Daemon-related commands ============

/// Check if daemon is available.
#[tauri::command]
fn is_daemon_available() -> bool {
    daemon_client::is_daemon_available()
}

/// Get daemon status.
#[tauri::command]
fn get_daemon_status() -> Result<DaemonStatusWithMeta, String> {
    eprintln!("[get_daemon_status] Called");

    let channel = app_channel();
    let using_dev_socket = is_using_dev_socket(&channel);

    let (binary_path, source) = match find_daemon_binary(&channel) {
        Ok((path, src)) => (Some(path.display().to_string()), src),
        Err(e) => {
            eprintln!("[get_daemon_status] Daemon binary not found: {}", e);
            (None, "missing".to_string())
        }
    };
    let source = if using_dev_socket {
        "dev-socket".to_string()
    } else {
        source
    };

    if !daemon_client::is_daemon_available() {
        eprintln!("[get_daemon_status] Daemon not available, returning default status");
        return Ok(DaemonStatusWithMeta {
            channel,
            source,
            binary_path,
            using_dev_socket,
            ..Default::default()
        });
    }

    eprintln!("[get_daemon_status] Daemon available, getting status");
    let result = daemon_client::get_status();
    eprintln!("[get_daemon_status] Result: {:?}", result);

    result.map(|status| DaemonStatusWithMeta {
        channel,
        source,
        binary_path,
        using_dev_socket,
        running: status.running,
        version: status.version,
        uptime_secs: status.uptime_secs,
        has_network_permission: status.has_network_permission,
        has_firewall_permission: status.has_firewall_permission,
        kill_switch_active: status.kill_switch_active,
    })
}

/// Get daemon logs (macOS only).
#[tauri::command]
fn get_daemon_logs() -> Result<String, String> {
    eprintln!("[get_daemon_logs] Called");

    #[cfg(target_os = "macos")]
    {
        let mut logs = String::new();

        // Read stdout log
        if let Ok(stdout) = std::fs::read_to_string("/var/log/vpnvpn-daemon.log") {
            logs.push_str("=== STDOUT LOG ===\n");
            // Get last 100 lines
            let lines: Vec<&str> = stdout.lines().collect();
            let start = if lines.len() > 100 {
                lines.len() - 100
            } else {
                0
            };
            for line in &lines[start..] {
                logs.push_str(line);
                logs.push('\n');
            }
        } else {
            logs.push_str("=== STDOUT LOG ===\n(not found)\n");
        }

        // Read stderr log
        if let Ok(stderr) = std::fs::read_to_string("/var/log/vpnvpn-daemon.error.log") {
            logs.push_str("\n=== STDERR LOG ===\n");
            let lines: Vec<&str> = stderr.lines().collect();
            let start = if lines.len() > 100 {
                lines.len() - 100
            } else {
                0
            };
            for line in &lines[start..] {
                logs.push_str(line);
                logs.push('\n');
            }
        } else {
            logs.push_str("\n=== STDERR LOG ===\n(not found)\n");
        }

        // Get launchctl info
        if let Ok(output) = std::process::Command::new("launchctl")
            .args(["list", "com.vpnvpn.daemon"])
            .output()
        {
            logs.push_str("\n=== LAUNCHCTL STATUS ===\n");
            logs.push_str(&String::from_utf8_lossy(&output.stdout));
            if !output.stderr.is_empty() {
                logs.push_str(&String::from_utf8_lossy(&output.stderr));
            }
        }

        Ok(logs)
    }

    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("journalctl")
            .args(["-u", "vpnvpn-daemon", "-n", "100", "--no-pager"])
            .output()
            .map_err(|e| format!("Failed to get logs: {}", e))?;

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    #[cfg(target_os = "windows")]
    {
        // NOTE: unverified on host (Windows-only)
        let path = windows_daemon_log_path();
        let mut logs = String::new();

        match std::fs::read_to_string(&path) {
            Ok(content) => {
                logs.push_str("=== DAEMON LOG ===\n");
                let lines: Vec<&str> = content.lines().collect();
                let start = lines.len().saturating_sub(100);
                for line in &lines[start..] {
                    logs.push_str(line);
                    logs.push('\n');
                }
            }
            Err(e) => {
                logs.push_str(&format!(
                    "=== DAEMON LOG ===\n(could not read {}: {})\n",
                    path, e
                ));
            }
        }

        // Append service status from the Windows Service Control Manager.
        if let Ok(output) = std::process::Command::new("sc")
            .args(["query", "vpnvpn-daemon"])
            .output()
        {
            logs.push_str("\n=== SERVICE STATUS ===\n");
            logs.push_str(&String::from_utf8_lossy(&output.stdout));
        }

        Ok(logs)
    }
}

/// Path to the daemon's log file on Windows.
///
/// The daemon writes to `%ProgramData%\vpnvpn\daemon.log`.
///
/// NOTE: unverified on host (Windows-only)
#[cfg(target_os = "windows")]
fn windows_daemon_log_path() -> String {
    let program_data =
        std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
    format!(r"{}\vpnvpn\daemon.log", program_data)
}

#[derive(Serialize)]
struct LogChunk {
    cursor: u64,
    lines: Vec<String>,
    truncated: bool,
}

#[tauri::command]
fn tail_daemon_logs(cursor: Option<u64>) -> Result<LogChunk, String> {
    const MAX_BYTES: u64 = 32 * 1024; // cap per read

    #[cfg(target_os = "macos")]
    {
        let path = "/var/log/vpnvpn-daemon.log";
        tail_file(path, cursor, MAX_BYTES)
    }

    #[cfg(target_os = "linux")]
    {
        // Fallback: use journalctl last 200 lines
        let output = std::process::Command::new("journalctl")
            .args(["-u", "vpnvpn-daemon", "-n", "200", "--no-pager"])
            .output()
            .map_err(|e| format!("Failed to get logs: {}", e))?;

        let text = String::from_utf8_lossy(&output.stdout).to_string();
        let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
        return Ok(LogChunk {
            cursor: lines.len() as u64,
            lines,
            truncated: false,
        });
    }

    #[cfg(target_os = "windows")]
    {
        // NOTE: unverified on host (Windows-only)
        let path = windows_daemon_log_path();
        // If the log file does not exist yet, return an empty (non-error) chunk
        // so the UI can poll without surfacing a spurious error.
        if !std::path::Path::new(&path).exists() {
            return Ok(LogChunk {
                cursor: 0,
                lines: vec![],
                truncated: false,
            });
        }
        return tail_file(&path, cursor, MAX_BYTES);
    }
}

fn tail_file(path: &str, cursor: Option<u64>, max_bytes: u64) -> Result<LogChunk, String> {
    let meta = fs::metadata(path).map_err(|e| format!("metadata {path}: {e}"))?;
    let file_size = meta.len();
    let start = cursor.unwrap_or_else(|| file_size.saturating_sub(max_bytes));

    let mut file = fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let mut buf = Vec::new();

    if start < file_size {
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(start))
            .map_err(|e| format!("seek {path}: {e}"))?;
    } else {
        // nothing new
        return Ok(LogChunk {
            cursor: file_size,
            lines: vec![],
            truncated: false,
        });
    }

    file.take(max_bytes)
        .read_to_end(&mut buf)
        .map_err(|e| format!("read {path}: {e}"))?;

    let text = String::from_utf8_lossy(&buf);
    let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();

    Ok(LogChunk {
        cursor: file_size,
        lines,
        truncated: start > 0,
    })
}

/// Enable kill switch via daemon.
#[tauri::command]
fn enable_kill_switch(allow_lan: bool) -> Result<(), String> {
    daemon_client::enable_kill_switch(allow_lan)
}

/// Disable kill switch via daemon.
#[tauri::command]
fn disable_kill_switch() -> Result<(), String> {
    daemon_client::disable_kill_switch()
}

/// Check if we're using the development socket.
fn is_using_dev_socket(channel: &str) -> bool {
    if !(channel == "devel" || cfg!(debug_assertions)) {
        return false;
    }
    std::path::Path::new("/tmp/vpnvpn-daemon.sock").exists()
}

/// Restart daemon service.
#[tauri::command]
fn restart_daemon() -> Result<(), String> {
    eprintln!("[restart_daemon] Starting daemon restart...");

    // Check if we're in dev mode (using /tmp socket)
    let channel = app_channel();
    if is_using_dev_socket(&channel) {
        eprintln!("[restart_daemon] Dev mode detected - sending restart signal to daemon");
        // In dev mode, we can still send the restart request
        // The daemon will try to restart itself, but if it's running via cargo watch,
        // the user may need to manually restart
        match daemon_client::restart_daemon() {
            Ok(_) => {
                eprintln!("[restart_daemon] Restart request sent successfully");
                // Give a hint to the user
                Err("Restart signal sent. If running via 'cargo watch', you may need to restart manually with: sudo bun run dev:daemon:watch".to_string())
            }
            Err(e) => {
                eprintln!("[restart_daemon] Failed to send restart request: {}", e);
                Err(format!(
                    "Failed to restart daemon: {}. Try running: sudo bun run dev:daemon:watch",
                    e
                ))
            }
        }
    } else {
        // Production mode - use system service restart
        eprintln!("[restart_daemon] Production mode - using system service restart");
        daemon_client::restart_daemon()
    }
}

/// Stop daemon service (dev mode).
#[tauri::command]
fn stop_daemon() -> Result<(), String> {
    eprintln!("[stop_daemon] Stopping daemon...");

    let channel = app_channel();
    if is_using_dev_socket(&channel) {
        eprintln!("[stop_daemon] Dev mode - daemon must be stopped manually (Ctrl+C in terminal)");
        return Err("In development mode, stop the daemon manually by pressing Ctrl+C in the terminal where it's running.".to_string());
    }

    // Production mode
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("launchctl")
            .args(["unload", "/Library/LaunchDaemons/com.vpnvpn.daemon.plist"])
            .status()
            .map_err(|e| format!("Failed to stop daemon: {}", e))?;

        if !status.success() {
            return Err("Failed to stop daemon service".to_string());
        }
    }

    #[cfg(target_os = "linux")]
    {
        let status = std::process::Command::new("systemctl")
            .args(["stop", "vpnvpn-daemon"])
            .status()
            .map_err(|e| format!("Failed to stop daemon: {}", e))?;

        if !status.success() {
            return Err("Failed to stop daemon service".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        let status = std::process::Command::new("net")
            .args(["stop", "vpnvpn-daemon"])
            .status()
            .map_err(|e| format!("Failed to stop daemon: {}", e))?;

        if !status.success() {
            return Err("Failed to stop daemon service".to_string());
        }
    }

    Ok(())
}

/// Get the sidecar binary name with target triple suffix.
fn sidecar_binary_name() -> String {
    let target = std::env::consts::ARCH;
    let os = std::env::consts::OS;

    let triple = match (os, target) {
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("windows", "aarch64") => "aarch64-pc-windows-msvc",
        _ => "unknown",
    };

    let ext = if os == "windows" { ".exe" } else { "" };
    format!("vpnvpn-daemon-{}{}", triple, ext)
}

/// Find the daemon binary from controlled locations.
/// Priority:
/// 1. Bundled sidecar within the installed app
/// 2. (devel only) workspace build outputs for developer builds
fn find_daemon_binary(channel: &str) -> Result<(PathBuf, String), String> {
    let app_path = std::env::current_exe().map_err(|e| format!("Failed to get exe path: {e}"))?;

    // List of possible daemon binary locations (in order of priority)
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Get sidecar name for current platform
    let sidecar_name = sidecar_binary_name();

    #[cfg(target_os = "macos")]
    {
        // Production: Tauri sidecar in Contents/MacOS/
        if let Some(exe_dir) = app_path.parent() {
            candidates.push(exe_dir.join(&sidecar_name));
            candidates.push(exe_dir.join("vpnvpn-daemon"));
        }
        // Production: bundled in app Contents/Library/LaunchServices/
        if let Some(bundle_path) = app_path
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            candidates.push(bundle_path.join("Contents/Library/LaunchServices/com.vpnvpn.daemon"));
            candidates.push(bundle_path.join("Contents/Resources/vpnvpn-daemon"));
            candidates.push(bundle_path.join(format!("Contents/MacOS/{}", sidecar_name)));
        }
        // Development: cargo build output (only for devel/debug)
        if channel == "devel" || cfg!(debug_assertions) {
            if let Some(workspace_root) = find_workspace_root(&app_path) {
                candidates
                    .push(workspace_root.join("apps/desktop/daemon/target/release/vpnvpn-daemon"));
                candidates
                    .push(workspace_root.join("apps/desktop/daemon/target/debug/vpnvpn-daemon"));
                candidates.push(workspace_root.join("target/release/vpnvpn-daemon"));
                candidates.push(workspace_root.join("target/debug/vpnvpn-daemon"));
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Production: Tauri sidecar adjacent to executable
        if let Some(exe_dir) = app_path.parent() {
            candidates.push(exe_dir.join(&sidecar_name));
            candidates.push(exe_dir.join("vpnvpn-daemon"));
        }
        // Development: cargo build output (only for devel/debug)
        if channel == "devel" || cfg!(debug_assertions) {
            if let Some(workspace_root) = find_workspace_root(&app_path) {
                candidates
                    .push(workspace_root.join("apps/desktop/daemon/target/release/vpnvpn-daemon"));
                candidates
                    .push(workspace_root.join("apps/desktop/daemon/target/debug/vpnvpn-daemon"));
                candidates.push(workspace_root.join("target/release/vpnvpn-daemon"));
                candidates.push(workspace_root.join("target/debug/vpnvpn-daemon"));
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Production: Tauri sidecar adjacent to executable
        if let Some(exe_dir) = app_path.parent() {
            candidates.push(exe_dir.join(&sidecar_name));
            candidates.push(exe_dir.join("vpnvpn-daemon.exe"));
        }
        // Development: cargo build output (only for devel/debug)
        if channel == "devel" || cfg!(debug_assertions) {
            if let Some(workspace_root) = find_workspace_root(&app_path) {
                candidates.push(
                    workspace_root.join(r"apps\desktop\daemon\target\release\vpnvpn-daemon.exe"),
                );
                candidates.push(
                    workspace_root.join(r"apps\desktop\daemon\target\debug\vpnvpn-daemon.exe"),
                );
                candidates.push(workspace_root.join(r"target\release\vpnvpn-daemon.exe"));
                candidates.push(workspace_root.join(r"target\debug\vpnvpn-daemon.exe"));
            }
        }
    }

    // Find the first existing candidate
    for candidate in &candidates {
        if candidate.exists() {
            let source = if channel == "devel" || cfg!(debug_assertions) {
                if candidate.to_string_lossy().contains("target/debug") {
                    "dev-debug".to_string()
                } else if candidate.to_string_lossy().contains("target/release") {
                    "dev-release".to_string()
                } else {
                    "bundled".to_string()
                }
            } else {
                "bundled".to_string()
            };
            return Ok((candidate.clone(), source));
        }
    }

    // Return helpful error with searched paths
    let searched = candidates
        .iter()
        .map(|p| format!("  - {}", p.display()))
        .collect::<Vec<_>>()
        .join("\n");

    Err(format!(
        "Daemon binary not found. Searched locations:\n{}\n\nHint: In development, build the daemon first with:\n  cd apps/desktop/daemon && cargo build --release",
        searched
    ))
}

/// Try to find the workspace root by looking for Cargo.toml or package.json
fn find_workspace_root(start_path: &std::path::Path) -> Option<PathBuf> {
    let mut current = start_path.to_path_buf();

    // Go up the directory tree looking for workspace markers
    for _ in 0..10 {
        if let Some(parent) = current.parent() {
            // Check for monorepo markers
            if parent.join("turbo.json").exists()
                || parent.join("package.json").exists() && parent.join("apps").exists()
                || parent.join("Cargo.toml").exists() && parent.join("apps").exists()
            {
                return Some(parent.to_path_buf());
            }
            current = parent.to_path_buf();
        } else {
            break;
        }
    }
    None
}

/// Validate a path is safe for shell interpolation — reject shell-injection characters.
fn validate_path_for_shell(path: &std::path::Path) -> Result<(), String> {
    let s = path.to_string_lossy();
    for ch in ['\'', '"', '`', '$', '\n', '\r'] {
        if s.contains(ch) {
            return Err(format!(
                "Daemon binary path contains unsafe character {:?} — refusing to interpolate into shell script",
                ch
            ));
        }
    }
    Ok(())
}

/// Install the daemon service.
#[tauri::command]
fn install_daemon() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        install_daemon_macos()
    }

    #[cfg(target_os = "linux")]
    {
        install_daemon_linux()
    }

    #[cfg(target_os = "windows")]
    {
        install_daemon_windows()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        Err("Platform not supported".to_string())
    }
}

#[cfg(target_os = "macos")]
fn install_daemon_macos() -> Result<(), String> {
    eprintln!("[install_daemon_macos] Starting daemon installation...");

    let channel = app_channel();
    let (daemon_src, source) = find_daemon_binary(&channel)?;
    validate_path_for_shell(&daemon_src)?;
    eprintln!(
        "[install_daemon_macos] Found daemon binary at: {} (source: {})",
        daemon_src.display(),
        source
    );

    // Check if we're in dev mode
    let is_dev = cfg!(debug_assertions);
    eprintln!("[install_daemon_macos] Dev mode: {}", is_dev);

    // In dev mode, don't install as LaunchDaemon - user should run dev script
    if is_dev {
        eprintln!(
            "[install_daemon_macos] Development mode detected - skipping LaunchDaemon installation"
        );
        eprintln!("[install_daemon_macos] In dev mode, run the daemon manually with:");

        // Try to find the dev script path
        let dev_script_path = if let Some(workspace_root) = find_workspace_root(&daemon_src) {
            workspace_root.join("apps/desktop/scripts/dev-daemon.sh")
        } else if let Some(daemon_dir) = daemon_src.parent().and_then(|p| p.parent()) {
            daemon_dir.join("scripts/dev-daemon.sh")
        } else {
            std::path::PathBuf::from("./scripts/dev-daemon.sh")
        };

        eprintln!(
            "[install_daemon_macos]   sudo {}",
            dev_script_path.display()
        );
        eprintln!("[install_daemon_macos] Or from the daemon directory:");
        eprintln!("[install_daemon_macos]   sudo cd apps/desktop/daemon && cargo run -- --dev");
        eprintln!(
            "[install_daemon_macos] The daemon will create a socket at /tmp/vpnvpn-daemon.sock"
        );

        // Check if dev socket already exists
        if std::path::Path::new("/tmp/vpnvpn-daemon.sock").exists() {
            eprintln!(
                "[install_daemon_macos] Dev socket already exists - daemon may already be running"
            );
        } else {
            eprintln!("[install_daemon_macos] Dev socket not found - start the daemon manually");
        }

        return Ok(());
    }

    // Production mode: Install as LaunchDaemon
    // Use osascript for privilege elevation
    let script = format!(
        r#"do shell script "
            echo '[install] Creating directories...' >&2 &&
            mkdir -p /Library/PrivilegedHelperTools &&
            echo '[install] Copying daemon binary...' >&2 &&
            cp '{}' /Library/PrivilegedHelperTools/com.vpnvpn.daemon &&
            chmod 755 /Library/PrivilegedHelperTools/com.vpnvpn.daemon &&
            chown root:wheel /Library/PrivilegedHelperTools/com.vpnvpn.daemon &&
            echo '[install] Creating LaunchDaemon plist...' >&2 &&
            cat > /Library/LaunchDaemons/com.vpnvpn.daemon.plist << 'PLIST'
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
    <key>Label</key>
    <string>com.vpnvpn.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Library/PrivilegedHelperTools/com.vpnvpn.daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/var/log/vpnvpn-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/vpnvpn-daemon.error.log</string>
</dict>
</plist>
PLIST
            chmod 644 /Library/LaunchDaemons/com.vpnvpn.daemon.plist &&
            echo '[install] Stopping any existing daemon...' >&2 &&
            launchctl bootout system/com.vpnvpn.daemon 2>/dev/null || launchctl unload /Library/LaunchDaemons/com.vpnvpn.daemon.plist 2>/dev/null || true &&
            launchctl stop system/com.vpnvpn.daemon 2>/dev/null || launchctl stop com.vpnvpn.daemon 2>/dev/null || true &&
            sleep 2 &&
            echo '[install] Loading daemon...' >&2 &&
            launchctl bootstrap system /Library/LaunchDaemons/com.vpnvpn.daemon.plist 2>/dev/null || launchctl load /Library/LaunchDaemons/com.vpnvpn.daemon.plist &&
            sleep 1 &&
            launchctl kickstart system/com.vpnvpn.daemon 2>/dev/null || launchctl start com.vpnvpn.daemon 2>/dev/null || true &&
            echo '[install] Checking daemon status...' >&2 &&
            sleep 1 &&
            launchctl list | grep com.vpnvpn.daemon &&
            echo '[install] Installation complete!' >&2
        " with administrator privileges"#,
        daemon_src.display()
    );

    eprintln!("[install_daemon_macos] Running osascript for privilege elevation...");

    let output = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("Failed to run osascript: {e}"))?;

    eprintln!(
        "[install_daemon_macos] osascript exit code: {:?}",
        output.status.code()
    );
    if !output.stdout.is_empty() {
        eprintln!(
            "[install_daemon_macos] stdout: {}",
            String::from_utf8_lossy(&output.stdout)
        );
    }
    if !output.stderr.is_empty() {
        eprintln!(
            "[install_daemon_macos] stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    if !output.status.success() {
        return Err(format!(
            "Installation cancelled or failed. Exit code: {:?}\nstderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Verify the daemon is running
    eprintln!("[install_daemon_macos] Verifying daemon is running...");
    std::thread::sleep(std::time::Duration::from_secs(2));

    let check = std::process::Command::new("launchctl")
        .args(["list", "com.vpnvpn.daemon"])
        .output();

    match check {
        Ok(out) => {
            eprintln!(
                "[install_daemon_macos] launchctl list output: {}",
                String::from_utf8_lossy(&out.stdout)
            );
            if out.status.success() {
                eprintln!("[install_daemon_macos] Daemon appears to be loaded");
            } else {
                eprintln!(
                    "[install_daemon_macos] WARNING: Daemon may not be loaded: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
            }
        }
        Err(e) => {
            eprintln!("[install_daemon_macos] WARNING: Could not check daemon status: {e}");
        }
    }

    // Check if socket exists (production mode only)
    let socket_path = "/var/run/vpnvpn-daemon.sock";
    eprintln!(
        "[install_daemon_macos] Checking for socket at: {}",
        socket_path
    );

    for i in 0..10 {
        if std::path::Path::new(socket_path).exists() {
            eprintln!(
                "[install_daemon_macos] Socket file found at {}",
                socket_path
            );
            // Try to connect to verify it's working
            if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
                eprintln!("[install_daemon_macos] Successfully connected to socket - daemon is running correctly");
                break;
            } else {
                eprintln!("[install_daemon_macos] Socket exists but connection failed, waiting...");
            }
        }
        eprintln!(
            "[install_daemon_macos] Waiting for socket file... attempt {}/10",
            i + 1
        );
        std::thread::sleep(std::time::Duration::from_secs(1));
    }

    if !std::path::Path::new(socket_path).exists() {
        eprintln!("[install_daemon_macos] WARNING: Socket file not found at {}. Check /var/log/vpnvpn-daemon.error.log for errors.", socket_path);
    }

    eprintln!("[install_daemon_macos] Installation completed successfully");
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_daemon_linux() -> Result<(), String> {
    let channel = app_channel();
    let (daemon_src, source) = find_daemon_binary(&channel)?;
    let _ = source; // suppress unused warning
    validate_path_for_shell(&daemon_src)?;

    let script = format!(
        r#"pkexec sh -c '
            cp "{}" /usr/local/bin/vpnvpn-daemon &&
            chmod 755 /usr/local/bin/vpnvpn-daemon &&
            chown root:root /usr/local/bin/vpnvpn-daemon &&
            cat > /etc/systemd/system/vpnvpn-daemon.service << EOF
[Unit]
Description=vpnVPN Daemon
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/vpnvpn-daemon
Restart=always
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_RAW

[Install]
WantedBy=multi-user.target
EOF
            systemctl daemon-reload &&
            systemctl enable vpnvpn-daemon &&
            systemctl start vpnvpn-daemon
        '"#,
        daemon_src.display()
    );

    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(&script)
        .status()
        .map_err(|e| format!("Failed to run install script: {e}"))?;

    if !status.success() {
        return Err("Installation failed".to_string());
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn install_daemon_windows() -> Result<(), String> {
    let channel = app_channel();
    let (daemon_src, _source) = find_daemon_binary(&channel)?;

    let install_dir = r"C:\Program Files\vpnVPN";
    let daemon_dst = format!(r"{}\vpnvpn-daemon.exe", install_dir);

    // PowerShell script for elevated installation
    let ps_script = format!(
        r#"
        $ErrorActionPreference = "Stop"
        New-Item -ItemType Directory -Force -Path "{install_dir}" | Out-Null
        Copy-Item -Path "{src}" -Destination "{dst}" -Force
        if (Get-Service -Name "vpnvpn-daemon" -ErrorAction SilentlyContinue) {{
            Stop-Service -Name "vpnvpn-daemon" -Force -ErrorAction SilentlyContinue
            sc.exe delete vpnvpn-daemon
            Start-Sleep -Seconds 2
        }}
        New-Service -Name "vpnvpn-daemon" -BinaryPathName "{dst}" -DisplayName "vpnVPN Daemon" -StartupType Automatic
        Start-Service -Name "vpnvpn-daemon"
        "#,
        install_dir = install_dir,
        src = daemon_src.display(),
        dst = daemon_dst
    );

    // Run PowerShell elevated
    let status = std::process::Command::new("powershell")
        .args([
            "-Command",
            "Start-Process",
            "powershell",
            "-Verb",
            "RunAs",
            "-ArgumentList",
            &format!("'-Command {}'", ps_script.replace("'", "''")),
        ])
        .status()
        .map_err(|e| format!("Failed to run PowerShell: {e}"))?;

    if !status.success() {
        return Err("Installation failed".to_string());
    }

    Ok(())
}

/// Uninstall the daemon service.
#[tauri::command]
fn uninstall_daemon() -> Result<(), String> {
    eprintln!("[uninstall_daemon] Starting daemon uninstallation...");

    // Check if we're in dev mode
    let channel = app_channel();
    if is_using_dev_socket(&channel) {
        eprintln!("[uninstall_daemon] Dev mode detected - cleaning up dev socket");
        // In dev mode, just clean up the socket
        let _ = std::fs::remove_file("/tmp/vpnvpn-daemon.sock");
        return Err("In development mode, there's no service to uninstall. The dev socket has been cleaned up. Stop the daemon with Ctrl+C.".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        eprintln!("[uninstall_daemon] macOS - uninstalling production daemon");
        let script = r#"do shell script "
            echo '[uninstall] Stopping daemon...' >&2 &&
            launchctl unload /Library/LaunchDaemons/com.vpnvpn.daemon.plist 2>/dev/null || true &&
            echo '[uninstall] Removing plist...' >&2 &&
            rm -f /Library/LaunchDaemons/com.vpnvpn.daemon.plist &&
            echo '[uninstall] Removing daemon binary...' >&2 &&
            rm -f /Library/PrivilegedHelperTools/com.vpnvpn.daemon &&
            echo '[uninstall] Removing socket...' >&2 &&
            rm -f /var/run/vpnvpn-daemon.sock &&
            echo '[uninstall] Done!' >&2
        " with administrator privileges"#;

        let status = std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .status()
            .map_err(|e| format!("Failed to run osascript: {e}"))?;

        if !status.success() {
            return Err("Uninstallation cancelled or failed".to_string());
        }
    }

    #[cfg(target_os = "linux")]
    {
        eprintln!("[uninstall_daemon] Linux - uninstalling production daemon");
        let script = r#"pkexec sh -c '
            echo "[uninstall] Stopping daemon..." &&
            systemctl stop vpnvpn-daemon 2>/dev/null || true &&
            systemctl disable vpnvpn-daemon 2>/dev/null || true &&
            echo "[uninstall] Removing service file..." &&
            rm -f /etc/systemd/system/vpnvpn-daemon.service &&
            systemctl daemon-reload &&
            echo "[uninstall] Removing daemon binary..." &&
            rm -f /usr/local/bin/vpnvpn-daemon &&
            echo "[uninstall] Removing socket..." &&
            rm -f /var/run/vpnvpn-daemon.sock &&
            echo "[uninstall] Done!"
        '"#;

        let status = std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .status()
            .map_err(|e| format!("Failed to run uninstall script: {e}"))?;

        if !status.success() {
            return Err("Uninstallation failed".to_string());
        }
    }

    #[cfg(target_os = "windows")]
    {
        eprintln!("[uninstall_daemon] Windows - uninstalling production daemon");
        let ps_script = r#"
            Write-Host "[uninstall] Stopping service..."
            Stop-Service -Name "vpnvpn-daemon" -Force -ErrorAction SilentlyContinue
            Write-Host "[uninstall] Deleting service..."
            sc.exe delete vpnvpn-daemon
            Write-Host "[uninstall] Removing files..."
            Remove-Item -Path "C:\Program Files\vpnVPN" -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "[uninstall] Done!"
        "#;

        let status = std::process::Command::new("powershell")
            .args([
                "-Command",
                "Start-Process",
                "powershell",
                "-Verb",
                "RunAs",
                "-ArgumentList",
                &format!("'-Command {}'", ps_script.replace("'", "''")),
            ])
            .status()
            .map_err(|e| format!("Failed to run PowerShell: {e}"))?;

        if !status.success() {
            return Err("Uninstallation failed".to_string());
        }
    }

    Ok(())
}

/// Update daemon in development mode - builds and reinstalls.
#[tauri::command]
async fn update_daemon_dev() -> Result<(), String> {
    // Find the daemon source directory
    let daemon_dir = find_daemon_source_dir()?;

    // Build the daemon
    let build_output = std::process::Command::new("cargo")
        .arg("build")
        .arg("--release")
        .current_dir(&daemon_dir)
        .output()
        .map_err(|e| format!("Failed to run cargo build: {e}"))?;

    if !build_output.status.success() {
        let stderr = String::from_utf8_lossy(&build_output.stderr);
        return Err(format!("Daemon build failed:\n{stderr}"));
    }

    // Reinstall the daemon
    install_daemon()
}

/// Split-tunnel configuration exposed to the GUI.
#[derive(Serialize, Deserialize, Clone, Default)]
struct SplitTunnelSettings {
    /// "full" | "include" | "exclude".
    mode: String,
    include_subnets: Vec<String>,
    exclude_subnets: Vec<String>,
}

/// Read the daemon's current split-tunnel configuration.
#[tauri::command]
fn get_split_tunnel() -> Result<SplitTunnelSettings, String> {
    let settings = daemon_client::get_daemon_settings()?;
    let st = settings.get("split_tunnel").cloned().unwrap_or_default();
    Ok(SplitTunnelSettings {
        mode: st
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("full")
            .to_string(),
        include_subnets: st
            .get("include_subnets")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        exclude_subnets: st
            .get("exclude_subnets")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Update the daemon's split-tunnel configuration.
///
/// Reads the current settings, replaces the `split_tunnel` block, and pushes the
/// whole settings object back so we never clobber unrelated fields. The change
/// applies to the next connection.
#[tauri::command]
fn set_split_tunnel(config: SplitTunnelSettings) -> Result<(), String> {
    let mode = config.mode.to_lowercase();
    if !matches!(mode.as_str(), "full" | "include" | "exclude") {
        return Err(format!("invalid split-tunnel mode: {mode}"));
    }

    let mut settings = daemon_client::get_daemon_settings()?;
    let obj = settings
        .as_object_mut()
        .ok_or_else(|| "daemon settings are not an object".to_string())?;
    obj.insert(
        "split_tunnel".to_string(),
        serde_json::json!({
            "mode": mode,
            "include_subnets": config.include_subnets,
            "exclude_subnets": config.exclude_subnets,
        }),
    );

    daemon_client::update_daemon_settings(settings)
}

/// Read whether auto-reconnect is enabled in the daemon settings.
#[tauri::command]
fn get_auto_reconnect() -> Result<bool, String> {
    let settings = daemon_client::get_daemon_settings()?;
    Ok(settings
        .get("auto_reconnect")
        .and_then(|v| v.as_bool())
        .unwrap_or(true))
}

/// Enable/disable auto-reconnect in the daemon settings.
#[tauri::command]
fn set_auto_reconnect(enabled: bool) -> Result<(), String> {
    let mut settings = daemon_client::get_daemon_settings()?;
    let obj = settings
        .as_object_mut()
        .ok_or_else(|| "daemon settings are not an object".to_string())?;
    obj.insert("auto_reconnect".to_string(), serde_json::json!(enabled));
    daemon_client::update_daemon_settings(settings)
}

/// Update the daemon to the latest signed build.
///
/// Channel-aware:
/// - `devel` (or debug builds): delegate to [`update_daemon_dev`], which rebuilds
///   the daemon from source and reinstalls it (developer workflow).
/// - non-dev channels (`staging`/`prod`): resolve the new, signed daemon binary
///   that shipped with the (already-updated, signed) app bundle and drive the
///   daemon's signed-update flow: `PrepareUpdate` (which verifies the binary's
///   signature inside the privileged daemon) followed by a restart to swap it in.
///
/// This is the path wired to the GUI's "Update daemon" action for real releases;
/// the signature is verified by the daemon in `handler::verify_update_binary`.
#[tauri::command]
async fn update_daemon() -> Result<(), String> {
    let channel = app_channel();

    // Developer channel: rebuild + reinstall from source.
    if channel == "devel" || cfg!(debug_assertions) {
        return update_daemon_dev().await;
    }

    if !daemon_client::is_daemon_available() {
        return Err(
            "VPN daemon is not running; cannot update. Install it from Settings > Service."
                .to_string(),
        );
    }

    // Resolve the new (signed) daemon binary bundled with the current app. After
    // the app itself is updated via the signed Tauri updater, this points at the
    // freshly shipped daemon sidecar.
    let (binary_path, source) = find_daemon_binary(&channel)?;
    eprintln!(
        "[update_daemon] Staging daemon update from {} (source: {})",
        binary_path.display(),
        source
    );

    let path_str = binary_path
        .to_str()
        .ok_or_else(|| "Daemon binary path is not valid UTF-8".to_string())?;

    // Drive the daemon's signed-update staging (verifies signature, then stages).
    daemon_client::prepare_update(path_str)
        .map_err(|e| format!("Failed to stage daemon update: {e}"))?;

    // Restart so the daemon swaps in the staged binary on next launch.
    daemon_client::restart_daemon()
        .map_err(|e| format!("Daemon update staged but restart failed: {e}"))?;

    Ok(())
}

/// Find the daemon source directory for development builds.
fn find_daemon_source_dir() -> Result<PathBuf, String> {
    // Try to find daemon dir relative to the src-tauri directory
    let possible_paths = [
        // From src-tauri directory
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../daemon"),
    ];

    for path in &possible_paths {
        if path.exists() && path.join("Cargo.toml").exists() {
            return Ok(path.canonicalize().unwrap_or_else(|_| path.clone()));
        }
    }

    Err(
        "Daemon source directory not found. This feature is only available in development."
            .to_string(),
    )
}

/// Check if running in development mode.
#[tauri::command]
fn is_development() -> bool {
    cfg!(debug_assertions)
}

/// Load onboarding state from config.
#[tauri::command]
fn get_onboarding_state() -> Result<OnboardingState, String> {
    load_onboarding_state()
}

/// Save onboarding state to config.
#[tauri::command]
fn save_onboarding_state(state: OnboardingState) -> Result<(), String> {
    save_onboarding_state_internal(&state)
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct OnboardingState {
    completed: bool,
    current_step: String,
    selected_protocol: Option<String>,
    kill_switch_enabled: bool,
    allow_lan: bool,
    daemon_installed: bool,
}

fn onboarding_config_path() -> Result<PathBuf, String> {
    config_path().map(|p| p.with_file_name("onboarding.json"))
}

fn load_onboarding_state() -> Result<OnboardingState, String> {
    let path = onboarding_config_path()?;
    if !path.exists() {
        return Ok(OnboardingState::default());
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read onboarding state: {e}"))?;
    serde_json::from_str(&data).map_err(|e| format!("Failed to parse onboarding state: {e}"))
}

fn save_onboarding_state_internal(state: &OnboardingState) -> Result<(), String> {
    let path = onboarding_config_path()?;
    let data = serde_json::to_string_pretty(state)
        .map_err(|e| format!("Failed to serialize onboarding state: {e}"))?;
    std::fs::write(&path, data).map_err(|e| format!("Failed to write onboarding state: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    fn init_temp_home() {
        let base = env::temp_dir().join("vpnvpn-desktop-test");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        #[cfg(target_os = "windows")]
        env::set_var("APPDATA", &base);

        #[cfg(not(target_os = "windows"))]
        env::set_var("HOME", &base);
    }

    #[test]
    fn settings_round_trip() {
        init_temp_home();

        let settings = DesktopSettings {
            preferred_protocol: "openvpn".into(),
            auto_connect: true,
            wg_quick_path: Some("wg-custom".into()),
            ..Default::default()
        };

        save_settings(&settings).expect("save_settings should succeed");
        let loaded = load_settings().expect("load_settings should succeed");

        assert_eq!(loaded.preferred_protocol, "openvpn");
        assert!(loaded.auto_connect);
        assert_eq!(loaded.wg_quick_path.as_deref(), Some("wg-custom"));
    }

    #[test]
    fn get_desktop_settings_uses_default_when_missing_file() {
        init_temp_home();
        let settings = get_desktop_settings().expect("get_desktop_settings should succeed");
        assert_eq!(settings.preferred_protocol, "wireguard");
    }
}

/// Update tray state from frontend
#[tauri::command]
fn update_tray_state(
    app: tauri::AppHandle,
    connected: bool,
    kill_switch_enabled: bool,
    auto_start_enabled: bool,
    server_name: Option<String>,
) -> Result<(), String> {
    let state = tray::TrayState {
        connected,
        kill_switch_enabled,
        auto_start_enabled,
        server_name,
    };
    tray::update_tray_state(&app, &state)
}

/// Log message from frontend to backend console
#[tauri::command]
fn log_from_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => eprintln!("[frontend] [error] {}", message),
        "warn" => eprintln!("[frontend] [warn] {}", message),
        "info" => println!("[frontend] [info] {}", message),
        "log" => println!("[frontend] [log] {}", message),
        "debug" => println!("[frontend] [debug] {}", message),
        _ => println!("[frontend] [{}] {}", level, message),
    }
}

#[cfg(not(test))]
fn main() {
    // Fix PATH environment variable for GUI app
    // This ensures we can find VPN tools installed via package managers (Homebrew, etc)
    // and fixes Windows PATH inheritance issues
    let _ = fix_path_env::fix();

    tauri::Builder::default()
        // Deep link plugin registers the `vpnvpn://` scheme on all desktop OSes.
        .plugin(tauri_plugin_deep_link::init())
        // Shell plugin for opening URLs in browser
        .plugin(tauri_plugin_shell::init())
        // Auto-update: signed app updater (latest.json from GitHub Releases) and
        // process plugin for relaunching after an update is installed.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Create system tray
            match tray::create_tray(app.handle()) {
                Ok(_tray) => {
                    println!("System tray created successfully");
                }
                Err(e) => {
                    eprintln!("Failed to create system tray: {}", e);
                }
            }

            // On Linux and Windows, ensure the statically configured schemes are
            // registered for the current executable (handy in dev and portable builds).
            #[cfg(any(windows, target_os = "linux"))]
            {
                app.deep_link().register_all()?;
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            health_check,
            get_machine_id,
            generate_wireguard_keys,
            detect_vpn_tools,
            refresh_vpn_tools,
            update_vpn_binary_paths,
            get_vpn_tools_detailed,
            check_vpn_status,
            get_desktop_settings,
            update_desktop_settings,
            apply_vpn_config,
            ikev2_profile_installed,
            disconnect_vpn,
            apply_wireguard_config,
            disconnect_wireguard,
            // Daemon commands
            is_daemon_available,
            get_daemon_status,
            get_daemon_logs,
            tail_daemon_logs,
            enable_kill_switch,
            disable_kill_switch,
            restart_daemon,
            stop_daemon,
            install_daemon,
            uninstall_daemon,
            update_daemon_dev,
            update_daemon,
            get_split_tunnel,
            set_split_tunnel,
            get_auto_reconnect,
            set_auto_reconnect,
            is_development,
            get_onboarding_state,
            save_onboarding_state,
            // Tray commands
            update_tray_state,
            // Logging
            log_from_frontend
        ])
        .run(tauri::generate_context!())
        .expect("error while running vpnVPN desktop application");
}

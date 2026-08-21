//! Daemon state management.

use anyhow::Result;
use std::time::{Duration, Instant};
use vpnvpn_shared::{
    config::{DaemonSettings, DaemonStatus, PlatformInfo, VpnToolsStatus},
    protocol::{ConnectionState, ConnectionStatus, VpnConfig},
};

use crate::ipc::auth::NonceStore;

/// Maximum age for an issued authentication challenge.
const AUTH_NONCE_MAX_AGE: Duration = Duration::from_secs(30);

/// Maximum number of concurrently outstanding authentication challenges.
const AUTH_NONCE_MAX: usize = 64;

/// Lifetime of an authenticated client session before it must be re-established
/// via a fresh challenge-response handshake.
const SESSION_MAX_AGE: Duration = Duration::from_secs(60 * 60);

/// Daemon state.
pub struct DaemonState {
    /// When the daemon started.
    pub started_at: Instant,

    /// Current daemon settings.
    pub settings: DaemonSettings,

    /// Current connection status.
    pub connection: ConnectionStatus,

    /// Whether kill-switch is active.
    pub kill_switch_active: bool,

    /// Authenticated client sessions.
    pub sessions: Vec<ClientSession>,

    /// Cached VPN tools status.
    pub vpn_tools: VpnToolsStatus,

    /// Outstanding authentication challenges (nonces issued to clients).
    pub auth_nonces: NonceStore,

    /// The last config that was successfully connected, used by auto-reconnect
    /// to re-establish the tunnel after an unexpected drop. Cleared on an
    /// explicit user disconnect so we don't reconnect a tunnel the user closed.
    pub last_config: Option<VpnConfig>,

    /// Whether the most recent disconnect was user-initiated (suppresses
    /// auto-reconnect).
    pub user_disconnected: bool,
}

/// An authenticated client session.
pub struct ClientSession {
    pub token: String,
    pub created_at: Instant,
    pub client_pid: u32,
}

impl DaemonState {
    pub fn new(settings: DaemonSettings) -> Self {
        // Detect VPN tools on startup
        let vpn_tools = crate::tools::detect_vpn_tools(&settings.binary_paths);

        Self {
            started_at: Instant::now(),
            settings,
            connection: ConnectionStatus::default(),
            kill_switch_active: false,
            sessions: Vec::new(),
            vpn_tools,
            auth_nonces: NonceStore::new(AUTH_NONCE_MAX_AGE, AUTH_NONCE_MAX),
            last_config: None,
            user_disconnected: false,
        }
    }

    /// Get daemon status.
    pub fn status(&self) -> DaemonStatus {
        DaemonStatus {
            running: true,
            version: crate::VERSION.to_string(),
            uptime_secs: self.started_at.elapsed().as_secs(),
            has_network_permission: has_network_permission(),
            has_firewall_permission: has_firewall_permission(),
            connection: self.connection.clone(),
            kill_switch_active: self.kill_switch_active,
            platform_info: self.platform_info(),
            vpn_tools: self.vpn_tools.clone(),
        }
    }

    /// Refresh VPN tools detection.
    pub fn refresh_vpn_tools(&mut self) {
        self.vpn_tools = crate::tools::refresh_vpn_tools(&self.settings.binary_paths);
    }

    /// Update binary paths and refresh detection.
    pub fn update_binary_paths(&mut self, paths: vpnvpn_shared::config::VpnBinaryPaths) {
        self.settings.binary_paths = paths;
        self.refresh_vpn_tools();
    }

    /// Get platform-specific info.
    fn platform_info(&self) -> PlatformInfo {
        PlatformInfo {
            os: std::env::consts::OS.to_string(),
            os_version: os_version(),
            service_type: service_type(),
            daemon_path: daemon_path(),
            service_config_path: service_config_path(),
        }
    }

    /// Cleanup on shutdown.
    pub async fn cleanup(&mut self) -> Result<()> {
        // Disconnect VPN if connected
        if self.connection.state == ConnectionState::Connected {
            tracing::info!("Disconnecting VPN before shutdown...");
            // VPN disconnect will be handled by vpn module
        }

        // Disable kill-switch if active
        if self.kill_switch_active {
            tracing::info!("Disabling kill-switch before shutdown...");
            #[cfg(target_os = "macos")]
            crate::firewall::macos::disable_kill_switch()?;

            #[cfg(target_os = "windows")]
            crate::firewall::windows::disable_kill_switch()?;

            #[cfg(target_os = "linux")]
            crate::firewall::linux::disable_kill_switch()?;

            self.kill_switch_active = false;
        }

        Ok(())
    }

    /// Add a new authenticated session.
    pub fn add_session(&mut self, token: String, client_pid: u32) {
        // Drop any expired sessions and any prior session for the same PID so a
        // re-handshake from the same client replaces (not duplicates) its token.
        self.purge_expired_sessions();
        self.sessions.retain(|s| s.client_pid != client_pid);

        self.sessions.push(ClientSession {
            token,
            created_at: Instant::now(),
            client_pid,
        });
    }

    /// Validate a session token (ignores peer binding; used by tests and callers
    /// that only need to confirm the token exists and is unexpired).
    #[allow(dead_code)]
    pub fn validate_session(&self, token: &str) -> bool {
        self.sessions
            .iter()
            .any(|s| s.token == token && s.created_at.elapsed() <= SESSION_MAX_AGE)
    }

    /// Validate a session token against the connecting peer.
    ///
    /// A session is accepted only when the token exists, has not expired, and was
    /// issued to the same peer pid that is now presenting it.
    ///
    /// SECURITY: we no longer accept a session when the peer pid (or the issuing
    /// pid) is 0. A pid of 0 means the transport could not resolve the peer, and
    /// accepting a token in that case would let any caller that can read a leaked
    /// token replay it. If the peer cannot be identified, the privileged request
    /// is denied and the client must re-handshake on a connection where the peer
    /// is resolvable.
    pub fn validate_session_for_peer(&self, token: &str, peer_pid: u32) -> bool {
        if peer_pid == 0 {
            return false;
        }
        self.sessions.iter().any(|s| {
            s.token == token
                && s.created_at.elapsed() <= SESSION_MAX_AGE
                && s.client_pid != 0
                && s.client_pid == peer_pid
        })
    }

    /// Remove sessions older than [`SESSION_MAX_AGE`].
    fn purge_expired_sessions(&mut self) {
        self.sessions
            .retain(|s| s.created_at.elapsed() <= SESSION_MAX_AGE);
    }
}

/// Whether the daemon can configure networking (interfaces, routes, tunnels).
///
/// On macOS and Linux this requires running as root (Linux can also operate via
/// the CAP_NET_ADMIN ambient capability, which is granted to root). We verify
/// effective privileges rather than assuming success.
fn has_network_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::platform::macos::is_root()
    }

    #[cfg(target_os = "linux")]
    {
        // CAP_NET_ADMIN is what actually matters; the platform helper treats
        // root as having it (the systemd unit grants it via AmbientCapabilities).
        crate::platform::linux::has_net_admin_cap()
    }

    #[cfg(target_os = "windows")]
    {
        // NOTE: unverified on host (Windows-only)
        // The daemon runs as a LocalSystem Windows service, which has the
        // privileges required to manage networking. Treat an elevated/service
        // context as having the permission.
        crate::platform::windows::is_admin()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

/// Whether the daemon can program the platform firewall (kill-switch).
///
/// In addition to elevated privileges this checks that the underlying firewall
/// tooling is present and reachable: `pfctl` on macOS, `nft`/`iptables` on Linux.
fn has_firewall_permission() -> bool {
    #[cfg(target_os = "macos")]
    {
        if !crate::platform::macos::is_root() {
            return false;
        }
        // pfctl is part of the base system; confirm it exists and is runnable.
        std::process::Command::new("pfctl")
            .arg("-s")
            .arg("info")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    #[cfg(target_os = "linux")]
    {
        if !crate::platform::linux::is_root() {
            return false;
        }
        // Either nftables or iptables must be available to build a kill-switch.
        let nft = std::process::Command::new("nft")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let iptables = std::process::Command::new("iptables")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        nft || iptables
    }

    #[cfg(target_os = "windows")]
    {
        // NOTE: unverified on host (Windows-only)
        // Kill-switch uses the Windows Filtering Platform via the firewall
        // module; the LocalSystem service context can program it.
        crate::platform::windows::is_admin()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}

fn os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string())
    }

    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|s| {
                s.lines().find(|l| l.starts_with("VERSION_ID=")).map(|l| {
                    l.trim_start_matches("VERSION_ID=")
                        .trim_matches('"')
                        .to_string()
                })
            })
            .unwrap_or_else(|| "unknown".to_string())
    }

    #[cfg(target_os = "windows")]
    {
        // NOTE: unverified on host (Windows-only)
        windows_os_version()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "unknown".to_string()
    }
}

/// Read the Windows product name and build number from the registry.
///
/// Uses `reg query` against
/// `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion`, which exposes
/// `ProductName`, `DisplayVersion`, and `CurrentBuild`. This avoids depending
/// on a specific `windows` crate feature and works from a service context.
///
/// NOTE: unverified on host (Windows-only)
#[cfg(target_os = "windows")]
fn windows_os_version() -> String {
    fn reg_value(name: &str) -> Option<String> {
        let output = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion",
                "/v",
                name,
            ])
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        // Lines look like: "    ProductName    REG_SZ    Windows 11 Pro"
        for line in stdout.lines() {
            if let Some(idx) = line.find(name) {
                let rest = &line[idx + name.len()..];
                // Skip the type token (e.g. REG_SZ / REG_DWORD) then take value.
                let mut parts = rest.split_whitespace();
                let _ty = parts.next();
                let value: String = parts.collect::<Vec<_>>().join(" ");
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
        None
    }

    let product = reg_value("ProductName").unwrap_or_else(|| "Windows".to_string());
    let display = reg_value("DisplayVersion");
    let build = reg_value("CurrentBuild");

    match (display, build) {
        (Some(d), Some(b)) => format!("{product} {d} (build {b})"),
        (Some(d), None) => format!("{product} {d}"),
        (None, Some(b)) => format!("{product} (build {b})"),
        (None, None) => product,
    }
}

fn service_type() -> String {
    #[cfg(target_os = "macos")]
    {
        "launchd".to_string()
    }

    #[cfg(target_os = "linux")]
    {
        "systemd".to_string()
    }

    #[cfg(target_os = "windows")]
    {
        "windows_service".to_string()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        "unknown".to_string()
    }
}

fn daemon_path() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        Some("/Library/PrivilegedHelperTools/com.vpnvpn.daemon".to_string())
    }

    #[cfg(target_os = "linux")]
    {
        Some("/usr/local/bin/vpnvpn-daemon".to_string())
    }

    #[cfg(target_os = "windows")]
    {
        Some(r"C:\Program Files\vpnVPN\vpnvpn-daemon.exe".to_string())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

fn service_config_path() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        Some("/Library/LaunchDaemons/com.vpnvpn.daemon.plist".to_string())
    }

    #[cfg(target_os = "linux")]
    {
        Some("/etc/systemd/system/vpnvpn-daemon.service".to_string())
    }

    #[cfg(target_os = "windows")]
    {
        None // Windows services don't have a config file path
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        None
    }
}

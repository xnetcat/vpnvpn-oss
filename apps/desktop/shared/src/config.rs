//! Configuration schemas for vpnVPN.
//!
//! All configuration persists to the home directory:
//! - macOS: ~/Library/Application Support/vpnvpn/
//! - Windows: %APPDATA%\vpnvpn\
//! - Linux: ~/.config/vpnvpn/

use crate::Protocol;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Get the configuration directory path for the current platform.
pub fn config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|h| h.join("Library/Application Support/vpnvpn"))
    }

    #[cfg(target_os = "windows")]
    {
        std::env::var("APPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join("vpnvpn"))
    }

    #[cfg(target_os = "linux")]
    {
        dirs::home_dir().map(|h| h.join(".config/vpnvpn"))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        None
    }
}

/// Get the path to a specific config file.
pub fn config_file(name: &str) -> Option<PathBuf> {
    config_dir().map(|d| d.join(name))
}

/// Get the profiles directory path.
pub fn profiles_dir() -> Option<PathBuf> {
    config_dir().map(|d| d.join("profiles"))
}

/// Combined application configuration.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
    pub settings: GuiSettings,
    pub daemon: DaemonSettings,
    pub onboarding: OnboardingState,
}

/// GUI preferences stored in settings.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuiSettings {
    /// Preferred VPN protocol.
    pub preferred_protocol: Protocol,

    /// Auto-connect on app launch.
    pub auto_connect: bool,

    /// Custom path to wg-quick binary (macOS/Linux).
    pub wg_quick_path: Option<String>,

    /// Custom path to OpenVPN binary.
    pub openvpn_path: Option<String>,

    /// Custom path to WireGuard CLI (Windows).
    pub wireguard_cli_path: Option<String>,

    /// Last connected server ID.
    pub last_server_id: Option<String>,

    /// Last connected server region.
    pub last_server_region: Option<String>,

    /// Window position and size.
    pub window_state: Option<WindowState>,

    /// Theme preference.
    pub theme: Theme,

    /// Show system tray icon.
    pub show_tray_icon: bool,

    /// Minimize to tray on close.
    pub minimize_to_tray: bool,

    /// Start minimized.
    pub start_minimized: bool,

    /// Check for updates automatically.
    pub auto_update_check: bool,
}

impl Default for GuiSettings {
    fn default() -> Self {
        Self {
            preferred_protocol: Protocol::WireGuard,
            auto_connect: false,
            wg_quick_path: None,
            openvpn_path: None,
            wireguard_cli_path: None,
            last_server_id: None,
            last_server_region: None,
            window_state: None,
            theme: Theme::System,
            show_tray_icon: true,
            minimize_to_tray: true,
            start_minimized: false,
            auto_update_check: true,
        }
    }
}

/// Window state for restoring position/size.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// Theme preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// Daemon settings stored in daemon.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonSettings {
    /// Enable kill-switch (block traffic if VPN disconnects).
    pub kill_switch_enabled: bool,

    /// Allow local network access when kill-switch is enabled.
    pub allow_lan: bool,

    /// Custom DNS servers (empty = use VPN server's DNS).
    pub dns_servers: Vec<String>,

    /// Auto-reconnect on connection drop.
    pub auto_reconnect: bool,

    /// Max reconnection attempts (0 = unlimited).
    pub max_reconnect_attempts: u32,

    /// Reconnect delay in seconds.
    pub reconnect_delay_secs: u32,

    /// Enable IPv6 leak protection.
    pub ipv6_leak_protection: bool,

    /// Log level for daemon.
    pub log_level: LogLevel,

    /// Firewall persistence mode.
    pub firewall_persistence: FirewallPersistence,

    /// Custom binary paths for VPN tools.
    #[serde(default)]
    pub binary_paths: VpnBinaryPaths,

    /// Linux UIDs explicitly authorized to drive the daemon over the IPC socket.
    ///
    /// SECURITY: populated at install time with the installing user's uid. Root
    /// (uid 0) is always authorized regardless of this list. When empty the
    /// daemon falls back to the socket-owner-derived default (never allow-all).
    #[serde(default)]
    pub allowed_uids: Vec<u32>,

    /// Split-tunnel configuration (subnet include/exclude). Defaults to routing
    /// all traffic through the tunnel.
    #[serde(default)]
    pub split_tunnel: SplitTunnelConfig,
}

/// Split-tunnel routing configuration.
///
/// Controls which destination subnets are routed through the VPN tunnel by
/// shaping the WireGuard `AllowedIPs`. Per-app split tunneling is OS-specific and
/// not implemented here; this provides subnet-based include/exclude which works
/// across platforms via the routing table.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct SplitTunnelConfig {
    /// Routing mode.
    pub mode: SplitTunnelMode,

    /// Subnets (CIDR) to route through the tunnel when `mode = Include`.
    #[serde(default)]
    pub include_subnets: Vec<String>,

    /// Subnets (CIDR) to keep OFF the tunnel (route directly) when
    /// `mode = Exclude`.
    #[serde(default)]
    pub exclude_subnets: Vec<String>,
}

impl Default for SplitTunnelConfig {
    fn default() -> Self {
        Self {
            mode: SplitTunnelMode::Full,
            include_subnets: Vec::new(),
            exclude_subnets: Vec::new(),
        }
    }
}

/// Split-tunnel mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SplitTunnelMode {
    /// Route everything through the tunnel (default; `AllowedIPs = 0.0.0.0/0, ::/0`).
    #[default]
    Full,
    /// Route only `include_subnets` through the tunnel.
    Include,
    /// Route everything EXCEPT `exclude_subnets` through the tunnel.
    Exclude,
}

impl Default for DaemonSettings {
    fn default() -> Self {
        Self {
            kill_switch_enabled: false,
            allow_lan: true,
            dns_servers: vec![],
            auto_reconnect: true,
            max_reconnect_attempts: 5,
            reconnect_delay_secs: 5,
            ipv6_leak_protection: true,
            log_level: LogLevel::Info,
            firewall_persistence: FirewallPersistence::SessionOnly,
            binary_paths: VpnBinaryPaths::default(),
            allowed_uids: Vec::new(),
            split_tunnel: SplitTunnelConfig::default(),
        }
    }
}

/// Log level for daemon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Trace,
    Debug,
    #[default]
    Info,
    Warn,
    Error,
}

/// Firewall persistence mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FirewallPersistence {
    /// Firewall rules are removed when daemon stops.
    #[default]
    SessionOnly,
    /// Firewall rules persist until explicitly disabled.
    Persistent,
    /// Firewall rules persist across reboots (boot-time protection).
    BootPersistent,
}

/// Onboarding state stored in onboarding.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnboardingState {
    /// Whether onboarding has been completed.
    pub completed: bool,

    /// When onboarding was completed.
    pub completed_at: Option<DateTime<Utc>>,

    /// Whether the daemon is installed.
    pub daemon_installed: bool,

    /// Installed daemon version.
    pub daemon_version: Option<String>,

    /// Whether permissions have been granted.
    pub permissions_granted: bool,

    /// Current onboarding step (for resuming).
    pub current_step: OnboardingStep,

    /// Selected protocol during onboarding.
    pub selected_protocol: Option<Protocol>,

    /// Kill-switch preference from onboarding.
    pub kill_switch_preference: Option<bool>,

    /// Allow LAN preference from onboarding.
    pub allow_lan_preference: Option<bool>,
}

impl Default for OnboardingState {
    fn default() -> Self {
        Self {
            completed: false,
            completed_at: None,
            daemon_installed: false,
            daemon_version: None,
            permissions_granted: false,
            current_step: OnboardingStep::Welcome,
            selected_protocol: None,
            kill_switch_preference: None,
            allow_lan_preference: None,
        }
    }
}

/// Onboarding wizard steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingStep {
    #[default]
    Welcome,
    ProtocolSelection,
    KillSwitchSettings,
    ServiceInstall,
    Completed,
}

impl OnboardingStep {
    pub fn next(&self) -> Option<OnboardingStep> {
        match self {
            OnboardingStep::Welcome => Some(OnboardingStep::ProtocolSelection),
            OnboardingStep::ProtocolSelection => Some(OnboardingStep::KillSwitchSettings),
            OnboardingStep::KillSwitchSettings => Some(OnboardingStep::ServiceInstall),
            OnboardingStep::ServiceInstall => Some(OnboardingStep::Completed),
            OnboardingStep::Completed => None,
        }
    }

    pub fn prev(&self) -> Option<OnboardingStep> {
        match self {
            OnboardingStep::Welcome => None,
            OnboardingStep::ProtocolSelection => Some(OnboardingStep::Welcome),
            OnboardingStep::KillSwitchSettings => Some(OnboardingStep::ProtocolSelection),
            OnboardingStep::ServiceInstall => Some(OnboardingStep::KillSwitchSettings),
            OnboardingStep::Completed => Some(OnboardingStep::ServiceInstall),
        }
    }

    pub fn index(&self) -> usize {
        match self {
            OnboardingStep::Welcome => 0,
            OnboardingStep::ProtocolSelection => 1,
            OnboardingStep::KillSwitchSettings => 2,
            OnboardingStep::ServiceInstall => 3,
            OnboardingStep::Completed => 4,
        }
    }

    pub fn total_steps() -> usize {
        4 // Not counting Completed
    }
}

/// Daemon service status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonStatus {
    /// Whether the daemon is running.
    pub running: bool,

    /// Daemon version.
    pub version: String,

    /// Daemon uptime in seconds.
    pub uptime_secs: u64,

    /// Whether the daemon has network permissions.
    pub has_network_permission: bool,

    /// Whether the daemon has firewall permissions.
    pub has_firewall_permission: bool,

    /// Current connection status.
    pub connection: crate::ConnectionStatus,

    /// Whether kill-switch is currently active.
    pub kill_switch_active: bool,

    /// Platform-specific status info.
    pub platform_info: PlatformInfo,

    /// VPN tools availability status.
    pub vpn_tools: VpnToolsStatus,
}

impl Default for DaemonStatus {
    fn default() -> Self {
        Self {
            running: false,
            version: env!("CARGO_PKG_VERSION").to_string(),
            uptime_secs: 0,
            has_network_permission: false,
            has_firewall_permission: false,
            connection: crate::ConnectionStatus::default(),
            kill_switch_active: false,
            platform_info: PlatformInfo::default(),
            vpn_tools: VpnToolsStatus::default(),
        }
    }
}

/// Platform-specific status information.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PlatformInfo {
    /// Operating system name.
    pub os: String,

    /// OS version.
    pub os_version: String,

    /// Service registration method (launchd, systemd, windows_service).
    pub service_type: String,

    /// Path to daemon binary.
    pub daemon_path: Option<String>,

    /// Path to service configuration (plist, unit file, etc.).
    pub service_config_path: Option<String>,
}

/// Status of VPN tools/binaries available on the system.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VpnToolsStatus {
    /// WireGuard tool availability.
    pub wireguard: VpnToolInfo,

    /// OpenVPN tool availability.
    pub openvpn: VpnToolInfo,

    /// IKEv2/IPsec tool availability.
    pub ikev2: VpnToolInfo,
}

/// Information about a single VPN tool.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct VpnToolInfo {
    /// Whether the tool is available.
    pub available: bool,

    /// Detected binary path.
    pub path: Option<String>,

    /// Tool version (if detectable).
    pub version: Option<String>,

    /// Custom path override (from settings).
    pub custom_path: Option<String>,

    /// Error message if detection failed.
    pub error: Option<String>,
}

/// Custom binary paths configuration for VPN tools.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct VpnBinaryPaths {
    /// Custom path to wg-quick binary (macOS/Linux).
    pub wg_quick_path: Option<String>,

    /// Custom path to wireguard.exe binary (Windows).
    pub wireguard_cli_path: Option<String>,

    /// Custom path to openvpn binary.
    pub openvpn_path: Option<String>,

    /// Custom path to IKEv2 tool (ipsec, networksetup, etc.).
    pub ikev2_path: Option<String>,
}

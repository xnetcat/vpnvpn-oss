//! IKEv2/IPsec VPN backend.

use anyhow::Result;
use tracing::{debug, info, warn};
use vpnvpn_shared::config::VpnBinaryPaths;
use vpnvpn_shared::protocol::{ConnectionState, ConnectionStatus, Protocol, VpnConfig};

/// Pure helpers for driving the macOS built-in IKEv2 client via `scutil --nc`.
///
/// Compiled on every platform (only the thin command wrappers in the macOS
/// section below actually invoke `scutil`) so the parsing and flow logic is
/// unit-testable on any host, mirroring how the WireGuard/OpenVPN backends keep
/// their output parsers pure.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) mod scutil {
    use vpnvpn_shared::protocol::ConnectionState;

    /// The VPN service name our .mobileconfig installs (`UserDefinedName`).
    /// `scutil --nc list/start/stop/status` all address the service by this
    /// name, so it must stay in sync with `build_macos_mobileconfig`.
    pub const MACOS_SERVICE_NAME: &str = "vpnVPN IKEv2";

    /// Which path a macOS IKEv2 connect should take.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum MacosRoute {
        /// strongSwan is installed — use it (fully automatic, legacy path).
        StrongSwan,
        /// Our profile is approved/installed — drive the built-in client
        /// with `scutil --nc start`.
        BuiltInService,
        /// No strongSwan and no installed profile — write the .mobileconfig,
        /// open it for user approval, and report pending-approval.
        InstallProfile,
    }

    /// Decide the macOS connect route. strongSwan keeps priority so existing
    /// strongSwan users see no behavior change.
    pub fn choose_route(strongswan_available: bool, service_installed: bool) -> MacosRoute {
        if strongswan_available {
            MacosRoute::StrongSwan
        } else if service_installed {
            MacosRoute::BuiltInService
        } else {
            MacosRoute::InstallProfile
        }
    }

    /// Does `scutil --nc list` output contain a service with this
    /// UserDefinedName? Service entries look like:
    ///
    /// `* (Disconnected)   <UUID> VPN (bundle.id) "Name"   [VPN:IKEv2]`
    ///
    /// The name is the only double-quoted token on the line, so we match the
    /// exact quoted form rather than a bare substring (a server region or
    /// bundle id containing the words could otherwise false-positive).
    pub fn nc_list_contains_service(list_output: &str, name: &str) -> bool {
        let quoted = format!("\"{}\"", name);
        list_output.lines().any(|line| line.contains(&quoted))
    }

    /// Parse `scutil --nc status <name>` output into a [`ConnectionState`].
    ///
    /// The first line is the state ("Connected", "Connecting", "Disconnected",
    /// "Disconnecting") or "No service" when the profile is not installed.
    /// Only the first line is inspected — the Extended Status dictionary that
    /// follows can contain arbitrary words.
    pub fn nc_status_state(status_output: &str) -> ConnectionState {
        let first = status_output
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("");
        match first {
            "Connected" => ConnectionState::Connected,
            "Connecting" => ConnectionState::Connecting,
            "Disconnecting" => ConnectionState::Disconnecting,
            _ => ConnectionState::Disconnected, // "Disconnected", "No service", unknown
        }
    }

    /// Merge two independently-observed states (e.g. strongSwan and the
    /// built-in client) into the most-connected one, so whichever backend
    /// actually carries the tunnel wins.
    pub fn merge_states(a: ConnectionState, b: ConnectionState) -> ConnectionState {
        fn rank(s: ConnectionState) -> u8 {
            match s {
                ConnectionState::Connected => 4,
                ConnectionState::Connecting | ConnectionState::Reconnecting => 3,
                ConnectionState::Disconnecting => 2,
                ConnectionState::PendingApproval => 1,
                ConnectionState::Disconnected | ConnectionState::Error => 0,
            }
        }
        if rank(a) >= rank(b) {
            a
        } else {
            b
        }
    }

    /// The [`ConnectionStatus`](vpnvpn_shared::protocol::ConnectionStatus)
    /// returned when the profile awaits user approval in System Settings.
    pub fn pending_approval_status() -> vpnvpn_shared::protocol::ConnectionStatus {
        vpnvpn_shared::protocol::ConnectionStatus {
            state: ConnectionState::PendingApproval,
            protocol: Some(vpnvpn_shared::protocol::Protocol::IKEv2),
            ..Default::default()
        }
    }
}

/// Get IKEv2 tool path based on platform.
///
/// Retained for explicit tool resolution; the connect path currently locates
/// strongSwan via `find_strongswan` / platform-specific helpers. (Plain code
/// span, not an intra-doc link: `find_strongswan` is cfg(unix) and would be a
/// broken link in Windows rustdoc.)
#[allow(dead_code)]
fn get_ikev2_tool_path(paths: &VpnBinaryPaths) -> Result<String> {
    if let Some(path) = crate::tools::get_ikev2_path(paths) {
        return Ok(path.to_string_lossy().to_string());
    }

    #[cfg(target_os = "macos")]
    {
        // networksetup is built-in on macOS
        if std::path::Path::new("/usr/sbin/networksetup").exists() {
            return Ok("/usr/sbin/networksetup".to_string());
        }
    }

    #[cfg(target_os = "linux")]
    {
        // Try ipsec (strongSwan)
        for path in &["/usr/sbin/ipsec", "/usr/local/sbin/ipsec"] {
            if std::path::Path::new(path).exists() {
                return Ok(path.to_string());
            }
        }
    }

    // rasdial is built-in on Windows, so that arm returns unconditionally and
    // the fall-through error below must be cfg'd out there (it would otherwise
    // be unreachable code). Same shape as `check_status` below.
    #[cfg(target_os = "windows")]
    return Ok("rasdial".to_string());

    #[cfg(not(target_os = "windows"))]
    Err(anyhow::anyhow!(
        "IKEv2 tool not found. Install strongSwan (Linux) or use the built-in IKEv2 support."
    ))
}

/// Connect using IKEv2/IPsec.
///
/// After issuing the platform-specific connect, this polls the connection state
/// until the tunnel is established (rather than assuming success after a fixed
/// sleep). If the tunnel never establishes within the timeout, an error is
/// returned so the caller does not report a phantom connection.
// `paths` is only consumed by the macOS/Linux connect paths; the Windows
// implementation uses built-in rasdial/PowerShell without it.
#[cfg_attr(windows, allow(unused_variables))]
pub async fn connect(config: &VpnConfig, paths: &VpnBinaryPaths) -> Result<ConnectionStatus> {
    info!("Connecting via IKEv2 to {}", config.server_endpoint);

    // IKEv2 implementation varies significantly by platform.
    //
    // macOS: three routes (see `scutil::choose_route`):
    //   1. strongSwan installed -> use it (legacy, fully automatic).
    //   2. Our profile already approved -> `scutil --nc start` the built-in
    //      client, then fall through to the shared verification poll below.
    //   3. Neither -> write the .mobileconfig, `open` it (System Settings shows
    //      the approval screen), briefly poll for approval, and if the user
    //      hasn't approved yet return a structured PendingApproval status (NOT
    //      an error) so the GUI can render an instruction + retry affordance.
    #[cfg(target_os = "macos")]
    {
        match connect_macos(config, paths).await? {
            MacosConnectOutcome::Started => {}
            MacosConnectOutcome::PendingApproval => {
                info!(
                    "IKEv2 profile '{}' awaiting user approval in System Settings",
                    scutil::MACOS_SERVICE_NAME
                );
                return Ok(scutil::pending_approval_status());
            }
        }
    }

    #[cfg(target_os = "linux")]
    connect_linux(config, paths).await?;

    #[cfg(target_os = "windows")]
    connect_windows(config).await?;

    // Poll for the tunnel to actually come up instead of assuming success.
    const MAX_ATTEMPTS: u32 = 15;
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

    let mut last_state = ConnectionState::Connecting;
    for attempt in 1..=MAX_ATTEMPTS {
        tokio::time::sleep(POLL_INTERVAL).await;

        let status = check_status().await?;
        last_state = status.state;

        match status.state {
            ConnectionState::Connected => {
                info!("IKEv2 connection established after {} attempt(s)", attempt);
                return Ok(status);
            }
            ConnectionState::Disconnected if attempt >= 3 => {
                // After a few attempts a persistent Disconnected state means the
                // handshake failed (bad credentials, unreachable server, etc.).
                debug!(
                    "IKEv2 still disconnected after {} attempt(s); giving up",
                    attempt
                );
                break;
            }
            _ => {
                debug!(
                    "IKEv2 connection attempt {}/{}: state={:?}",
                    attempt, MAX_ATTEMPTS, status.state
                );
            }
        }
    }

    Err(anyhow::anyhow!(
        "IKEv2 tunnel did not establish (last state: {:?}). Check credentials, \
         server reachability, and that the IKEv2 backend is available.",
        last_state
    ))
}

/// Disconnect IKEv2/IPsec.
pub async fn disconnect() -> Result<()> {
    info!("Disconnecting IKEv2");

    #[cfg(target_os = "macos")]
    disconnect_macos().await?;

    #[cfg(target_os = "linux")]
    disconnect_linux().await?;

    #[cfg(target_os = "windows")]
    disconnect_windows().await?;

    Ok(())
}

/// Check IKEv2 connection status.
pub async fn check_status() -> Result<ConnectionStatus> {
    #[cfg(target_os = "macos")]
    return check_status_macos().await;

    #[cfg(target_os = "linux")]
    return check_status_linux().await;

    #[cfg(target_os = "windows")]
    return check_status_windows().await;

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    Ok(ConnectionStatus {
        state: ConnectionState::Disconnected,
        protocol: Some(Protocol::IKEv2),
        ..Default::default()
    })
}

// ============ Shared strongSwan logic (macOS/Linux only) ============
// Windows uses built-in rasdial/PowerShell, so none of this is compiled there.

/// Check if strongSwan ipsec binary is available.
#[cfg(unix)]
fn find_strongswan() -> Option<String> {
    let paths = [
        "/opt/homebrew/sbin/ipsec", // macOS ARM Homebrew
        "/usr/local/sbin/ipsec",    // macOS Intel Homebrew / Linux
        "/usr/sbin/ipsec",          // Linux system
    ];
    for path in paths {
        if std::path::Path::new(path).exists() {
            return Some(path.to_string());
        }
    }
    None
}

/// Connect via strongSwan (works on both Linux and macOS).
#[cfg(unix)]
async fn connect_strongswan(config: &VpnConfig, ipsec_path: &str) -> Result<()> {
    let config_content = build_strongswan_config(config);

    // Write ipsec.conf
    let config_path = get_strongswan_config_path()?;
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&config_path, &config_content)?;

    // Write secrets file for EAP-MSCHAPv2
    if let (Some(u), Some(p)) = (&config.username, &config.password) {
        let secrets_path = config_path.parent().unwrap().join("vpnvpn-ipsec.secrets");
        let secrets = format!("{} : EAP \"{}\"\n", u, p);
        std::fs::write(&secrets_path, secrets)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&secrets_path)?.permissions();
            perms.set_mode(0o600);
            std::fs::set_permissions(&secrets_path, perms)?;
        }
    }

    // Reload and connect
    let _ = tokio::process::Command::new(ipsec_path)
        .args(["reload"])
        .output()
        .await;

    let output = tokio::process::Command::new(ipsec_path)
        .args(["up", "vpnvpn"])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!("ipsec up warning: {}", stderr);
    }

    Ok(())
}

#[cfg(unix)]
fn get_strongswan_config_path() -> Result<std::path::PathBuf> {
    let profiles_dir = vpnvpn_shared::config::profiles_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not determine config directory"))?;
    Ok(profiles_dir.join("ikev2").join("vpnvpn-ipsec.conf"))
}

#[cfg(unix)]
fn build_strongswan_config(config: &VpnConfig) -> String {
    let identity = config.ikev2_identity.as_deref().unwrap_or("vpnvpn");

    format!(
        r#"# vpnVPN IKEv2 configuration
conn vpnvpn
    keyexchange=ikev2
    type=tunnel
    left=%any
    leftid={identity}
    leftauth=eap-mschapv2
    leftsourceip=%config
    right={server}
    rightid={server}
    rightauth=pubkey
    rightca="CN=vpnvpn-ca"
    rightsubnet=0.0.0.0/0
    ike=aes256-sha256-modp2048!
    esp=aes256gcm128!
    auto=add
"#,
        identity = identity,
        server = config.server_endpoint
    )
}

// ============ macOS Implementation ============

/// Outcome of the macOS connect dispatch: either a connection attempt was
/// actually started (verify with the shared status poll), or the profile is
/// still awaiting user approval in System Settings.
#[cfg(target_os = "macos")]
enum MacosConnectOutcome {
    Started,
    PendingApproval,
}

/// Run `scutil --nc list` and return its stdout (None on spawn failure).
#[cfg(target_os = "macos")]
async fn scutil_nc_list() -> Option<String> {
    let output = tokio::process::Command::new("scutil")
        .args(["--nc", "list"])
        .output()
        .await
        .ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Is our IKEv2 service (from the approved .mobileconfig) installed?
#[cfg(target_os = "macos")]
async fn macos_service_installed() -> bool {
    match scutil_nc_list().await {
        Some(out) => scutil::nc_list_contains_service(&out, scutil::MACOS_SERVICE_NAME),
        None => false,
    }
}

/// `scutil --nc start` our service (built-in IKEv2 client).
#[cfg(target_os = "macos")]
async fn scutil_nc_start() -> Result<()> {
    let output = tokio::process::Command::new("scutil")
        .args(["--nc", "start", scutil::MACOS_SERVICE_NAME])
        .output()
        .await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // scutil --nc start is asynchronous and usually exits 0; a hard failure
        // here means the service is unusable (e.g. profile removed mid-flight).
        anyhow::bail!(
            "scutil --nc start '{}' failed: {}",
            scutil::MACOS_SERVICE_NAME,
            stderr.trim()
        );
    }
    Ok(())
}

#[cfg(target_os = "macos")]
async fn connect_macos(config: &VpnConfig, _paths: &VpnBinaryPaths) -> Result<MacosConnectOutcome> {
    let strongswan = find_strongswan();
    let service_installed = macos_service_installed().await;

    match scutil::choose_route(strongswan.is_some(), service_installed) {
        scutil::MacosRoute::StrongSwan => {
            let ipsec_path = strongswan.expect("route requires strongSwan");
            info!("strongSwan found at {}, using it for IKEv2", ipsec_path);
            connect_strongswan(config, &ipsec_path).await?;
            Ok(MacosConnectOutcome::Started)
        }
        scutil::MacosRoute::BuiltInService => {
            info!(
                "IKEv2 profile '{}' present; starting built-in client via scutil",
                scutil::MACOS_SERVICE_NAME
            );
            scutil_nc_start().await?;
            Ok(MacosConnectOutcome::Started)
        }
        scutil::MacosRoute::InstallProfile => {
            // First run: write the profile and open it. macOS has no supported
            // way to install a VPN profile silently without MDM/NetworkExtension
            // entitlements, so the user must approve it once in System Settings;
            // `open` lands them directly on the approval screen.
            let config_content = build_macos_mobileconfig(config);
            let config_path = get_config_path()?;
            if let Some(parent) = config_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&config_path, &config_content)?;
            info!(
                "IKEv2 profile written to {:?}; opening for one-time user approval",
                config_path
            );
            let _ = tokio::process::Command::new("open")
                .arg(config_path.to_str().unwrap())
                .output()
                .await;

            // Poll briefly for the user to approve the profile so a quick
            // approval completes this very connect instead of needing a retry.
            const APPROVAL_ATTEMPTS: u32 = 15;
            const APPROVAL_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
            for _ in 0..APPROVAL_ATTEMPTS {
                tokio::time::sleep(APPROVAL_INTERVAL).await;
                if macos_service_installed().await {
                    info!("IKEv2 profile approved; starting built-in client");
                    scutil_nc_start().await?;
                    return Ok(MacosConnectOutcome::Started);
                }
            }
            Ok(MacosConnectOutcome::PendingApproval)
        }
    }
}

#[cfg(target_os = "macos")]
async fn disconnect_macos() -> Result<()> {
    // strongSwan tunnel (if that path was used)
    if let Some(ipsec_path) = find_strongswan() {
        let _ = tokio::process::Command::new(&ipsec_path)
            .args(["down", "vpnvpn"])
            .output()
            .await;
    }

    // Built-in client (if the profile is installed). Harmless when already
    // disconnected — `scutil --nc stop` on an idle service is a no-op.
    if macos_service_installed().await {
        let _ = tokio::process::Command::new("scutil")
            .args(["--nc", "stop", scutil::MACOS_SERVICE_NAME])
            .output()
            .await;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
async fn check_status_macos() -> Result<ConnectionStatus> {
    // Query BOTH backends and report the most-connected state: a user may have
    // connected via the built-in client even though strongSwan is installed
    // (or vice versa), and the stale backend always reports Disconnected.
    let mut state = ConnectionState::Disconnected;

    if let Some(ipsec_path) = find_strongswan() {
        let output = tokio::process::Command::new(&ipsec_path)
            .args(["status", "vpnvpn"])
            .output()
            .await;
        let ss_state = match output {
            Ok(o) if o.status.success() => {
                let stdout = String::from_utf8_lossy(&o.stdout);
                if stdout.contains("ESTABLISHED") {
                    ConnectionState::Connected
                } else if stdout.contains("CONNECTING") {
                    ConnectionState::Connecting
                } else {
                    ConnectionState::Disconnected
                }
            }
            _ => ConnectionState::Disconnected,
        };
        state = scutil::merge_states(state, ss_state);
    }

    // Built-in client via scutil. `--nc status` prints "No service" when the
    // profile is absent, which parses to Disconnected — no pre-check needed.
    let output = tokio::process::Command::new("scutil")
        .args(["--nc", "status", scutil::MACOS_SERVICE_NAME])
        .output()
        .await;
    if let Ok(o) = output {
        let stdout = String::from_utf8_lossy(&o.stdout);
        state = scutil::merge_states(state, scutil::nc_status_state(&stdout));
    }

    Ok(ConnectionStatus {
        state,
        protocol: Some(Protocol::IKEv2),
        ..Default::default()
    })
}

#[cfg(target_os = "macos")]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn build_macos_mobileconfig(config: &VpnConfig) -> String {
    // The vpnVPN node authenticates IKEv2 clients with EAP-MSCHAPv2
    // (username/password) and presents a server certificate signed by the
    // node's "vpnvpn-ca" CA — see `build_strongswan_config` (leftauth =
    // eap-mschapv2, rightauth = pubkey, rightca = "CN=vpnvpn-ca"). The previous
    // template advertised `SharedSecret` with no secret, which could never
    // connect. This builds a matching EAP profile so the exported
    // .mobileconfig is actually importable and usable. macOS validates the
    // server certificate chain against the expected issuer CN; on a node using
    // the self-signed CA the user is prompted to trust it on first connect.
    let identity = config.ikev2_identity.as_deref().unwrap_or("vpnvpn-client");
    let remote_id = config
        .ikev2_remote_id
        .as_deref()
        .unwrap_or(&config.server_endpoint);
    let username = config.username.as_deref().unwrap_or("");
    let local_id = if username.is_empty() {
        identity
    } else {
        username
    };

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <array>
        <dict>
            <key>IKEv2</key>
            <dict>
                <key>AuthenticationMethod</key>
                <string>None</string>
                <key>ExtendedAuthEnabled</key>
                <integer>1</integer>
                <key>AuthName</key>
                <string>{user}</string>
                <key>AuthPassword</key>
                <string>{pass}</string>
                <key>LocalIdentifier</key>
                <string>{local}</string>
                <key>RemoteAddress</key>
                <string>{remote_addr}</string>
                <key>RemoteIdentifier</key>
                <string>{remote_id}</string>
                <key>ServerCertificateIssuerCommonName</key>
                <string>vpnvpn-ca</string>
                <key>IKESecurityAssociationParameters</key>
                <dict>
                    <key>EncryptionAlgorithm</key>
                    <string>AES-256</string>
                    <key>IntegrityAlgorithm</key>
                    <string>SHA2-256</string>
                    <key>DiffieHellmanGroup</key>
                    <integer>14</integer>
                </dict>
                <key>ChildSecurityAssociationParameters</key>
                <dict>
                    <key>EncryptionAlgorithm</key>
                    <string>AES-256-GCM</string>
                    <key>DiffieHellmanGroup</key>
                    <integer>14</integer>
                </dict>
                <key>UseConfigurationAttributeInternalIPSubnet</key>
                <integer>0</integer>
            </dict>
            <key>PayloadDisplayName</key>
            <string>vpnVPN IKEv2</string>
            <key>PayloadIdentifier</key>
            <string>com.vpnvpn.ikev2.vpn</string>
            <key>PayloadType</key>
            <string>com.apple.vpn.managed</string>
            <key>PayloadUUID</key>
            <string>A1B2C3D4-E5F6-7890-ABCD-EF1234567890</string>
            <key>PayloadVersion</key>
            <integer>1</integer>
            <key>VPNType</key>
            <string>IKEv2</string>
            <key>UserDefinedName</key>
            <string>{service_name}</string>
        </dict>
    </array>
    <key>PayloadDisplayName</key>
    <string>vpnVPN IKEv2 Configuration</string>
    <key>PayloadIdentifier</key>
    <string>com.vpnvpn.ikev2</string>
    <key>PayloadType</key>
    <string>Configuration</string>
    <key>PayloadUUID</key>
    <string>B2C3D4E5-F6A7-8901-BCDE-F12345678901</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
</dict>
</plist>
"#,
        user = xml_escape(username),
        pass = xml_escape(config.password.as_deref().unwrap_or("")),
        local = xml_escape(local_id),
        remote_addr = xml_escape(&config.server_endpoint),
        remote_id = xml_escape(remote_id),
        // Must match scutil::MACOS_SERVICE_NAME — `scutil --nc` addresses the
        // installed service by this UserDefinedName.
        service_name = scutil::MACOS_SERVICE_NAME,
    )
}

// ============ Linux Implementation ============

#[cfg(target_os = "linux")]
async fn connect_linux(config: &VpnConfig, _paths: &VpnBinaryPaths) -> Result<()> {
    let ipsec_path = find_strongswan().ok_or_else(|| {
        anyhow::anyhow!("strongSwan (ipsec) not found. Install with: sudo apt install strongswan")
    })?;
    connect_strongswan(config, &ipsec_path).await
}

#[cfg(target_os = "linux")]
async fn disconnect_linux() -> Result<()> {
    let _ = tokio::process::Command::new("ipsec")
        .args(["down", "vpnvpn"])
        .output()
        .await;

    Ok(())
}

#[cfg(target_os = "linux")]
async fn check_status_linux() -> Result<ConnectionStatus> {
    let output = tokio::process::Command::new("ipsec")
        .args(["status", "vpnvpn"])
        .output()
        .await;

    let state = match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            if stdout.contains("ESTABLISHED") {
                ConnectionState::Connected
            } else if stdout.contains("CONNECTING") {
                ConnectionState::Connecting
            } else {
                ConnectionState::Disconnected
            }
        }
        Err(_) => ConnectionState::Disconnected,
    };

    Ok(ConnectionStatus {
        state,
        protocol: Some(Protocol::IKEv2),
        ..Default::default()
    })
}

// ============ Windows Implementation ============

#[cfg(target_os = "windows")]
async fn connect_windows(config: &VpnConfig) -> Result<()> {
    let vpn_name = "vpnVPN-IKEv2";

    // Check if VPN connection exists
    let check = tokio::process::Command::new("rasdial").output().await?;

    let connections = String::from_utf8_lossy(&check.stdout);

    if !connections.contains(vpn_name) {
        // Create VPN connection using PowerShell
        let ps_script = format!(
            r#"
            Add-VpnConnection -Name "{}" -ServerAddress "{}" -TunnelType IKEv2 -AuthenticationMethod EAP -EncryptionLevel Required -Force
            "#,
            vpn_name, config.server_endpoint
        );

        let _ = tokio::process::Command::new("powershell")
            .args(["-Command", &ps_script])
            .output()
            .await;
    }

    // Connect
    let output = tokio::process::Command::new("rasdial")
        .args([vpn_name])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!("rasdial warning: {}", stderr);
    }

    Ok(())
}

#[cfg(target_os = "windows")]
async fn disconnect_windows() -> Result<()> {
    let vpn_name = "vpnVPN-IKEv2";

    let _ = tokio::process::Command::new("rasdial")
        .args([vpn_name, "/disconnect"])
        .output()
        .await;

    Ok(())
}

#[cfg(target_os = "windows")]
async fn check_status_windows() -> Result<ConnectionStatus> {
    let output = tokio::process::Command::new("rasdial").output().await;

    let state = match output {
        Ok(o) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            if stdout.contains("vpnVPN-IKEv2") {
                ConnectionState::Connected
            } else {
                ConnectionState::Disconnected
            }
        }
        Err(_) => ConnectionState::Disconnected,
    };

    Ok(ConnectionStatus {
        state,
        protocol: Some(Protocol::IKEv2),
        ..Default::default()
    })
}

#[allow(dead_code)] // Used by the macOS mobileconfig export path only.
fn get_config_path() -> Result<std::path::PathBuf> {
    let profiles_dir = vpnvpn_shared::config::profiles_dir()
        .ok_or_else(|| anyhow::anyhow!("Could not determine config directory"))?;

    #[cfg(target_os = "macos")]
    return Ok(profiles_dir.join("ikev2").join("vpnvpn-ikev2.mobileconfig"));

    #[cfg(target_os = "linux")]
    return Ok(profiles_dir.join("ikev2").join("vpnvpn-ipsec.conf"));

    #[cfg(target_os = "windows")]
    return Ok(profiles_dir.join("ikev2").join("vpnvpn-ikev2.pbk"));

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    Ok(profiles_dir.join("ikev2").join("vpnvpn-ikev2.conf"))
}

#[cfg(test)]
mod tests {
    use super::scutil::*;
    use vpnvpn_shared::protocol::ConnectionState;

    // Captured from a real `scutil --nc list` (macOS 15): third-party VPNs plus
    // a profile-installed built-in IKEv2 service.
    const NC_LIST_WITH_SERVICE: &str = r#"Available network connection services in the current set (*=enabled):
* (Disconnected)   131E6348-E199-444E-987F-6F4DB7B9F9DA VPN (ch.protonvpn.mac) "ProtonVPN"                      [VPN:ch.protonvpn.mac]
* (Disconnected)   F887F849-E66B-4C41-9431-5A180CCF921C VPN (io.tailscale.ipn.macsys) "Tailscale"                      [VPN:io.tailscale.ipn.macsys]
* (Disconnected)   0A1B2C3D-4E5F-6789-ABCD-EF0123456789 VPN "vpnVPN IKEv2"                      [VPN:IKEv2]
"#;

    const NC_LIST_WITHOUT_SERVICE: &str = r#"Available network connection services in the current set (*=enabled):
* (Disconnected)   131E6348-E199-444E-987F-6F4DB7B9F9DA VPN (ch.protonvpn.mac) "ProtonVPN"                      [VPN:ch.protonvpn.mac]
"#;

    #[test]
    fn nc_list_detects_installed_service() {
        assert!(nc_list_contains_service(
            NC_LIST_WITH_SERVICE,
            MACOS_SERVICE_NAME
        ));
    }

    #[test]
    fn nc_list_absent_service_not_detected() {
        assert!(!nc_list_contains_service(
            NC_LIST_WITHOUT_SERVICE,
            MACOS_SERVICE_NAME
        ));
        assert!(!nc_list_contains_service("", MACOS_SERVICE_NAME));
    }

    #[test]
    fn nc_list_requires_exact_quoted_name() {
        // A service whose name merely CONTAINS ours must not match ("vpnVPN
        // IKEv2 (old)" is a different service), and vice versa an unquoted
        // occurrence elsewhere on the line must not match.
        let near_miss = r#"* (Disconnected)   0A1B2C3D-4E5F-6789-ABCD-EF0123456789 VPN "vpnVPN IKEv2 (old)" [VPN:IKEv2]"#;
        assert!(!nc_list_contains_service(near_miss, MACOS_SERVICE_NAME));
    }

    #[test]
    fn nc_status_parses_first_line_states() {
        // Real `scutil --nc status` output: first line is the state, followed
        // by an Extended Status dictionary that can contain arbitrary words.
        let connected = "Connected\nExtended Status <dictionary> {\n  Status : 0\n}\n";
        let disconnected = "Disconnected\nExtended Status <dictionary> {\n  Status : 0\n}\n";
        assert_eq!(nc_status_state(connected), ConnectionState::Connected);
        assert_eq!(nc_status_state(disconnected), ConnectionState::Disconnected);
        assert_eq!(nc_status_state("Connecting\n"), ConnectionState::Connecting);
        assert_eq!(
            nc_status_state("Disconnecting\n"),
            ConnectionState::Disconnecting
        );
    }

    #[test]
    fn nc_status_no_service_and_garbage_are_disconnected() {
        assert_eq!(
            nc_status_state("No service\n"),
            ConnectionState::Disconnected
        );
        assert_eq!(nc_status_state(""), ConnectionState::Disconnected);
        assert_eq!(nc_status_state("???\n"), ConnectionState::Disconnected);
        // Words like "Connected" inside the extended dict must NOT flip state.
        let tricky = "Disconnected\nExtended Status <dictionary> {\n  LastCause : Connected\n}\n";
        assert_eq!(nc_status_state(tricky), ConnectionState::Disconnected);
    }

    #[test]
    fn route_prefers_strongswan_then_service_then_install() {
        assert_eq!(choose_route(true, true), MacosRoute::StrongSwan);
        assert_eq!(choose_route(true, false), MacosRoute::StrongSwan);
        assert_eq!(choose_route(false, true), MacosRoute::BuiltInService);
        assert_eq!(choose_route(false, false), MacosRoute::InstallProfile);
    }

    #[test]
    fn merge_states_picks_most_connected() {
        use ConnectionState::*;
        assert_eq!(merge_states(Disconnected, Connected), Connected);
        assert_eq!(merge_states(Connected, Disconnected), Connected);
        assert_eq!(merge_states(Connecting, Disconnected), Connecting);
        assert_eq!(merge_states(Disconnected, Disconnected), Disconnected);
        assert_eq!(merge_states(PendingApproval, Connected), Connected);
        assert_eq!(merge_states(PendingApproval, Disconnected), PendingApproval);
    }

    #[test]
    fn pending_approval_status_is_structured_ikev2_state() {
        let status = pending_approval_status();
        assert_eq!(status.state, ConnectionState::PendingApproval);
        assert_eq!(
            status.protocol,
            Some(vpnvpn_shared::protocol::Protocol::IKEv2)
        );
        // Serialized form the GUI sees over IPC.
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json["state"], "pending_approval");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mobileconfig_user_defined_name_matches_scutil_service_name() {
        let config = vpnvpn_shared::protocol::VpnConfig {
            protocol: vpnvpn_shared::protocol::Protocol::IKEv2,
            server_endpoint: "203.0.113.7".to_string(),
            username: Some("alice".to_string()),
            password: Some("pw".to_string()),
            ..Default::default()
        };
        let profile = super::build_macos_mobileconfig(&config);
        assert!(profile.contains(&format!(
            "<key>UserDefinedName</key>\n            <string>{}</string>",
            MACOS_SERVICE_NAME
        )));
    }
}

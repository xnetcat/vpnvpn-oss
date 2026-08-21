use super::{BackendStatus, PeerSpec, PeerUsage, VpnBackend, VpnProtocol};
use crate::net::os::get_network_manager;
use anyhow::{anyhow, Context, Result};
use std::fs;
use std::path::Path;
use std::process::Command;
use tracing::{debug, error, info, warn};
use zeroize::Zeroizing;

const WG_IFACE: &str = "wg0";
const WG_CONF: &str = "wg0.conf"; // Relative or absolute depends on OS config
const WG_KEY_PATH: &str = "server.key";

pub struct WireGuardBackend {
    listen_port: u16,
    config_dir: String,
}

/// A WireGuard public key or preshared key is a base64-encoded 32-byte value:
/// exactly 44 characters from the standard base64 alphabet, ending in `=`.
/// Rejecting anything else also rejects embedded newlines (config injection).
fn is_valid_wg_key(key: &str) -> bool {
    key.len() == 44
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

/// Validate an `AllowedIPs` entry: it must parse as a bare IP or an IP/CIDR with
/// a valid prefix length. The value is validated EXACTLY as it will be emitted
/// (no trimming) so any surrounding/embedded whitespace or newline — which could
/// inject extra config directives — causes a rejection.
fn is_valid_allowed_ip(value: &str) -> bool {
    use std::net::IpAddr;
    if value.is_empty() {
        return false;
    }
    match value.split_once('/') {
        Some((addr, prefix)) => {
            let Ok(ip) = addr.parse::<IpAddr>() else {
                return false;
            };
            let Ok(len) = prefix.parse::<u8>() else {
                return false;
            };
            let max = if ip.is_ipv4() { 32 } else { 128 };
            len <= max
        }
        None => value.parse::<IpAddr>().is_ok(),
    }
}

/// Validate an `Endpoint` entry as `host:port`. The host must be an IP literal
/// (v4, or bracketed v6) and the port a valid u16. WireGuard endpoints from the
/// control plane are always resolved IPs, so requiring a literal is safe and
/// strict. The value is validated EXACTLY as emitted (no trimming) so newlines /
/// stray whitespace are rejected rather than re-emitted into the config.
fn is_valid_endpoint(value: &str) -> bool {
    use std::net::SocketAddr;
    // SocketAddr parsing requires an IP literal + port and rejects newlines and
    // surrounding whitespace.
    value.parse::<SocketAddr>().is_ok()
}

impl WireGuardBackend {
    pub fn new(listen_port: u16) -> Result<Self> {
        info!(listen_port = listen_port, "wireguard_backend_initializing");
        let config_dir = if cfg!(target_os = "windows") {
            ".".to_string() // Current dir or specific AppData path
        } else {
            "/etc/wireguard".to_string()
        };
        info!(
            config_dir = config_dir.as_str(),
            "wireguard_config_directory"
        );
        Ok(Self {
            listen_port,
            config_dir,
        })
    }

    fn key_path(&self) -> String {
        format!("{}/{}", self.config_dir, WG_KEY_PATH)
    }

    fn conf_path(&self) -> String {
        format!("{}/{}", self.config_dir, WG_CONF)
    }

    fn ensure_keys_and_config(&self) -> Result<()> {
        debug!(
            config_dir = self.config_dir.as_str(),
            "ensuring_keys_and_config"
        );

        if !Path::new(&self.config_dir).exists() {
            info!(
                config_dir = self.config_dir.as_str(),
                "creating_config_directory"
            );
            fs::create_dir_all(&self.config_dir).context("create config dir")?;
        }

        let key_path = self.key_path();
        if !Path::new(&key_path).exists() {
            info!(
                key_path = key_path.as_str(),
                "generating_wireguard_private_key"
            );
            let output = Command::new("wg")
                .arg("genkey")
                .output()
                .context("wg genkey")?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                error!(stderr = stderr.as_ref(), "wg_genkey_failed");
                return Err(anyhow!("wg genkey failed: {}", stderr));
            }
            let key = String::from_utf8_lossy(&output.stdout).trim().to_string();
            fs::write(&key_path, format!("{}\n", key)).context("write wg private key")?;
            // Restrict permissions on private key file
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = fs::metadata(&key_path)?.permissions();
                perms.set_mode(0o600);
                fs::set_permissions(&key_path, perms)?;
            }
            info!("wireguard_private_key_generated");
        } else {
            debug!(key_path = key_path.as_str(), "wireguard_key_exists");
        }

        let conf_path = self.conf_path();
        if !Path::new(&conf_path).exists() {
            info!(conf_path = conf_path.as_str(), "creating_wireguard_config");
            let privkey = fs::read_to_string(&key_path)
                .unwrap_or_default()
                .trim()
                .to_string();
            // Address is configured by the OS network manager; keep only keys/port in wg config.
            // Note: do not include wg-quick-only directives (like Address/SaveConfig) because we
            // manage the interface via `wg` and OS tooling.
            let conf = format!(
                "[Interface]\nPrivateKey = {privkey}\nListenPort = {port}\n",
                port = self.listen_port
            );
            fs::write(&conf_path, conf).context("write wg0.conf")?;
            info!("wireguard_config_created");
        } else {
            debug!(conf_path = conf_path.as_str(), "wireguard_config_exists");
        }
        Ok(())
    }

    /// Seconds since the last handshake within which a WireGuard peer is treated
    /// as an active session. WireGuard rekeys ~every 120s, so 180s gives one
    /// missed-rekey of slack before a peer is considered idle/disconnected.
    const ACTIVE_HANDSHAKE_WINDOW_SECS: u64 = 180;

    /// Whether a peer counts as an active session given its `latest_handshake`
    /// Unix timestamp (0 = never) and the current Unix time. Pure/testable.
    fn is_peer_active(latest_handshake: u64, now_secs: u64) -> bool {
        if latest_handshake == 0 {
            return false; // never completed a handshake => not a live session
        }
        // Recent handshake (guard against clock skew where hs > now).
        now_secs.saturating_sub(latest_handshake) <= Self::ACTIVE_HANDSHAKE_WINDOW_SECS
    }

    /// Returns true if the WireGuard interface currently exists. Used to decide
    /// whether a syncconf failure warrants a heavy full reconfigure (only when
    /// the interface is genuinely gone) vs. leaving live sessions untouched.
    fn interface_exists(iface: &str) -> bool {
        // `wg show <iface>` succeeds only when the interface is present.
        Command::new("wg")
            .args(["show", iface])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    fn parse_status() -> Result<BackendStatus> {
        debug!(interface = WG_IFACE, "parsing_wireguard_status");
        // 'wg show' output is relatively standard across platforms
        let output = Command::new("wg")
            .args(["show", WG_IFACE, "dump"])
            .output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            debug!(stderr = stderr.as_ref(), "wg_show_dump_failed");
            return Err(anyhow!("wg show dump failed: {}", stderr));
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut active = 0usize;
        let mut rx_total: u64 = 0;
        let mut tx_total: u64 = 0;
        for line in text.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 9 {
                let latest_hs = parts[5].parse::<u64>().unwrap_or(0);
                let rx = parts[6].parse::<u64>().unwrap_or(0);
                let tx = parts[7].parse::<u64>().unwrap_or(0);
                // Count a peer as an active session only if it handshaked
                // recently. WireGuard rekeys roughly every 2 minutes, so a peer
                // with a handshake inside the window is genuinely connected. The
                // old logic counted any peer that had *ever* exchanged bytes
                // (even with latest_handshake==0), over-reporting stale peers.
                if Self::is_peer_active(latest_hs, now) {
                    active += 1;
                }
                rx_total = rx_total.saturating_add(rx);
                tx_total = tx_total.saturating_add(tx);
            }
        }
        debug!(
            active_sessions = active,
            rx_total = rx_total,
            tx_total = tx_total,
            "wireguard_status_parsed"
        );
        Ok(BackendStatus {
            protocol: "wireguard".into(),
            active_sessions: active,
            egress_bytes: tx_total,
            ingress_bytes: rx_total,
            running: true,
        })
    }

    /// Parse `wg show <iface> transfer` output into per-peer cumulative
    /// counters. Each line is `<base64-pubkey>\t<rx-bytes>\t<tx-bytes>`.
    /// Pure (no I/O) so it can be unit-tested; malformed lines are skipped.
    fn parse_transfer_text(text: &str) -> Vec<PeerUsage> {
        let mut usage = Vec::new();
        for line in text.lines() {
            let mut parts = line.split('\t');
            let (Some(pk), Some(rx), Some(tx)) = (parts.next(), parts.next(), parts.next()) else {
                continue;
            };
            if !is_valid_wg_key(pk) {
                continue;
            }
            let (Ok(rx_bytes), Ok(tx_bytes)) = (rx.parse::<u64>(), tx.parse::<u64>()) else {
                continue;
            };
            usage.push(PeerUsage {
                public_key: Some(pk.to_string()),
                username: None,
                rx_bytes,
                tx_bytes,
            });
        }
        usage
    }

    /// Render the WireGuard interface + peers config. Pure (no I/O) so it can be
    /// unit-tested. Peers with malformed public keys are skipped (logged at warn).
    fn render_config(privkey: &str, listen_port: u16, peers: &[PeerSpec]) -> String {
        let mut conf = format!(
            "[Interface]\nPrivateKey = {}\nListenPort = {}\n",
            privkey, listen_port
        );

        for (i, peer) in peers.iter().enumerate() {
            if let Some(pk) = &peer.public_key {
                // Validate WireGuard public key format (44 chars base64)
                if !is_valid_wg_key(pk) {
                    warn!(
                        peer_index = i,
                        "skipping_peer_with_invalid_public_key_format"
                    );
                    continue;
                }
                // The control plane is trusted but not infallible: every value
                // below is interpolated into a config file parsed line-by-line,
                // so a stray newline or shell/charset-illegal value could inject
                // extra directives. Validate each field the same way we validate
                // the public key and DROP the whole peer if any field is bad,
                // rather than emitting a malformed/injected config.
                if let Some(psk) = &peer.preshared_key {
                    if !is_valid_wg_key(psk) {
                        warn!(peer_index = i, "skipping_peer_with_invalid_preshared_key");
                        continue;
                    }
                }
                if !peer.allowed_ips.iter().all(|a| is_valid_allowed_ip(a)) {
                    warn!(peer_index = i, "skipping_peer_with_invalid_allowed_ips");
                    continue;
                }
                if let Some(ep) = &peer.endpoint {
                    if !is_valid_endpoint(ep) {
                        warn!(peer_index = i, "skipping_peer_with_invalid_endpoint");
                        continue;
                    }
                }

                debug!(
                    peer_index = i,
                    public_key_prefix = &pk[..8.min(pk.len())],
                    allowed_ips = ?peer.allowed_ips,
                    endpoint = peer.endpoint.as_deref(),
                    "adding_peer_to_config"
                );
                conf.push_str(&format!("\n[Peer]\nPublicKey = {}\n", pk));
                if let Some(psk) = &peer.preshared_key {
                    conf.push_str(&format!("PresharedKey = {}\n", psk));
                }
                if !peer.allowed_ips.is_empty() {
                    conf.push_str(&format!("AllowedIPs = {}\n", peer.allowed_ips.join(",")));
                }
                if let Some(ep) = &peer.endpoint {
                    conf.push_str(&format!("Endpoint = {}\n", ep));
                }
                conf.push_str("PersistentKeepalive = 25\n");
            }
        }
        conf
    }
}

impl VpnBackend for WireGuardBackend {
    fn protocol(&self) -> VpnProtocol {
        VpnProtocol::WireGuard
    }

    fn start(&self) -> Result<()> {
        info!(
            interface = WG_IFACE,
            port = self.listen_port,
            "starting_wireguard_backend"
        );

        self.ensure_keys_and_config()?;

        let nm = get_network_manager();
        info!(
            interface = WG_IFACE,
            address = "10.8.0.1/24",
            "configuring_wireguard_interface"
        );

        // Ensure configuration is applied and interface is up
        nm.configure_wireguard(WG_IFACE, "10.8.0.1/24", self.listen_port, &self.conf_path())?;
        info!(interface = WG_IFACE, "wireguard_interface_configured");

        nm.bring_up_interface(WG_IFACE)?;
        info!(interface = WG_IFACE, "wireguard_interface_up");

        // Set MTU to 1420 for WireGuard overhead
        let _ = std::process::Command::new("ip")
            .args(["link", "set", "dev", WG_IFACE, "mtu", "1420"])
            .status();

        // Add IPv6 address alongside IPv4
        let _ = std::process::Command::new("ip")
            .args(["-6", "addr", "add", "fd42:42:42::1/64", "dev", WG_IFACE])
            .status();
        info!(interface = WG_IFACE, "wireguard_mtu_and_ipv6_configured");

        Ok(())
    }

    fn stop(&self) -> Result<()> {
        info!(interface = WG_IFACE, "stopping_wireguard_backend");
        let nm = get_network_manager();
        nm.teardown_interface(WG_IFACE)?;
        info!(interface = WG_IFACE, "wireguard_interface_down");
        Ok(())
    }

    fn status(&self) -> Result<BackendStatus> {
        Self::parse_status().or_else(|e| {
            debug!(error=?e, "wg_status_failed_returning_not_running");
            Ok(BackendStatus {
                protocol: "wireguard".into(),
                running: false,
                active_sessions: 0,
                egress_bytes: 0,
                ingress_bytes: 0,
            })
        })
    }

    fn peer_usage(&self) -> Result<Vec<PeerUsage>> {
        // Cumulative per-peer counters since the interface came up.
        let output = Command::new("wg")
            .args(["show", WG_IFACE, "transfer"])
            .output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(anyhow!("wg show transfer failed: {}", stderr));
        }
        Ok(Self::parse_transfer_text(&String::from_utf8_lossy(
            &output.stdout,
        )))
    }

    fn public_key(&self) -> Option<String> {
        let key_path = self.key_path();
        if !Path::new(&key_path).exists() {
            debug!(key_path = key_path.as_str(), "private_key_not_found");
            return None;
        }
        let privkey = match fs::read_to_string(&key_path) {
            Ok(k) => Zeroizing::new(k.trim().to_string()),
            Err(e) => {
                warn!(error = ?e, "failed_to_read_private_key");
                return None;
            }
        };

        debug!("deriving_public_key_from_private_key");
        let mut child = Command::new("wg")
            .arg("pubkey")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .ok()?;

        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write;
            let _ = stdin.write_all(privkey.as_bytes());
        }
        drop(privkey); // Zeroize the key material

        let output = child.wait_with_output().ok()?;
        if output.status.success() {
            let pubkey = String::from_utf8_lossy(&output.stdout).trim().to_string();
            info!(public_key = pubkey.as_str(), "wireguard_public_key_derived");
            return Some(pubkey);
        }
        warn!("failed_to_derive_public_key");
        None
    }

    fn apply_peers(&self, peers: &[PeerSpec]) -> Result<()> {
        info!(peer_count = peers.len(), "applying_wireguard_peers");

        let privkey = Zeroizing::new(fs::read_to_string(self.key_path())?.trim().to_string());

        let conf = Self::render_config(privkey.as_str(), self.listen_port, peers);

        let conf_path = self.conf_path();
        let tmp_conf = format!("{}.new", conf_path);
        debug!(tmp_conf = tmp_conf.as_str(), "writing_temporary_config");
        fs::write(&tmp_conf, &conf)?;
        // Restrict permissions — config contains private key
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&tmp_conf)?.permissions();
            perms.set_mode(0o600);
            fs::set_permissions(&tmp_conf, perms)?;
        }

        let nm = get_network_manager();

        if cfg!(target_os = "windows") {
            // Windows has no `wg syncconf`, so updating peers requires rewriting
            // the conf and asking the network manager to reload it. NOTE: the
            // Windows network manager's configure_wireguard reinstalls the tunnel
            // SERVICE (/uninstalltunnelservice + /installtunnelservice), which
            // bounces every live session. That is unavoidable for a peer change
            // on Windows today; it is intentionally confined to this Windows-only
            // branch so routine Linux peer updates never trigger it.
            info!("windows_mode_full_config_replace");
            fs::rename(&tmp_conf, &conf_path)?;
            nm.configure_wireguard(WG_IFACE, "10.8.0.1/24", self.listen_port, &conf_path)?;
        } else {
            // Linux/Mac routine path: `wg syncconf` applies peer changes in place
            // WITHOUT bouncing the interface or existing sessions. Prefer it.
            debug!(interface = WG_IFACE, "attempting_wg_syncconf");
            let status = Command::new("wg")
                .args(["syncconf", WG_IFACE, &tmp_conf])
                .status();
            match status {
                Ok(s) if s.success() => {
                    info!("wg_syncconf_succeeded");
                    fs::rename(&tmp_conf, &conf_path)?;
                }
                Ok(_) | Err(_) => {
                    // syncconf failed. Only fall back to the heavy full
                    // reconfigure (which can recreate/bounce the interface) when
                    // the interface is GENUINELY MISSING — that is the only case
                    // the full path can fix. For any other transient syncconf
                    // error (e.g. a malformed temp conf) we keep the conf updated
                    // but do NOT bounce a healthy interface and drop live sessions.
                    if let Err(e) = &status {
                        error!(error = ?e, "wg_syncconf_error");
                    } else if let Ok(s) = &status {
                        warn!(exit_code = ?s.code(), "wg_syncconf_failed");
                    }
                    fs::rename(&tmp_conf, &conf_path)?;
                    if Self::interface_exists(WG_IFACE) {
                        warn!(
                            interface = WG_IFACE,
                            "syncconf_failed_but_interface_present; NOT bouncing live sessions"
                        );
                        return Err(anyhow!(
                            "wg syncconf failed and interface {WG_IFACE} is present; \
                             leaving existing sessions intact (config file updated)"
                        ));
                    }
                    warn!(
                        interface = WG_IFACE,
                        "interface_missing; performing full reconfigure"
                    );
                    nm.configure_wireguard(WG_IFACE, "10.8.0.1/24", self.listen_port, &conf_path)?;
                }
            }
        }

        info!(peer_count = peers.len(), "wireguard_peers_applied");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A valid WireGuard public key is 44 base64 chars (32 bytes encoded).
    const VALID_PK: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    fn peer(pk: Option<&str>) -> PeerSpec {
        PeerSpec {
            public_key: pk.map(|s| s.to_string()),
            preshared_key: None,
            allowed_ips: vec!["10.8.0.2/32".to_string()],
            endpoint: None,
            username: None,
            password: None,
        }
    }

    #[test]
    fn render_config_interface_section() {
        let conf = WireGuardBackend::render_config("PRIVKEY", 51820, &[]);
        assert!(conf.starts_with("[Interface]\n"));
        assert!(conf.contains("PrivateKey = PRIVKEY\n"));
        assert!(conf.contains("ListenPort = 51820\n"));
        // No peers => no [Peer] sections.
        assert!(!conf.contains("[Peer]"));
    }

    // A valid base64 preshared key (32 bytes -> 44 chars).
    const VALID_PSK: &str = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzND0=";

    #[test]
    fn render_config_includes_valid_peer_fields() {
        assert_eq!(VALID_PK.len(), 44);
        let mut p = peer(Some(VALID_PK));
        p.preshared_key = Some(VALID_PSK.to_string());
        p.allowed_ips = vec!["10.8.0.2/32".to_string(), "fd42::2/128".to_string()];
        p.endpoint = Some("1.2.3.4:51820".to_string());

        let conf = WireGuardBackend::render_config("PRIVKEY", 51820, &[p]);
        assert!(conf.contains(&format!("PublicKey = {VALID_PK}\n")));
        assert!(conf.contains(&format!("PresharedKey = {VALID_PSK}\n")));
        assert!(conf.contains("AllowedIPs = 10.8.0.2/32,fd42::2/128\n"));
        assert!(conf.contains("Endpoint = 1.2.3.4:51820\n"));
        assert!(conf.contains("PersistentKeepalive = 25\n"));
    }

    #[test]
    fn render_config_rejects_injection_in_preshared_key() {
        // A PSK carrying a newline + an injected directive must drop the peer.
        let mut p = peer(Some(VALID_PK));
        p.preshared_key = Some("AAAA\nAllowedIPs = 0.0.0.0/0".to_string());
        let conf = WireGuardBackend::render_config("PRIVKEY", 51820, &[p]);
        assert!(
            !conf.contains("[Peer]"),
            "injected PSK peer must be dropped"
        );
    }

    #[test]
    fn render_config_rejects_injection_in_allowed_ips() {
        // A newline-bearing AllowedIPs entry must drop the peer.
        let mut p = peer(Some(VALID_PK));
        p.allowed_ips = vec!["10.8.0.2/32\nEndpoint = 9.9.9.9:1".to_string()];
        let conf = WireGuardBackend::render_config("PRIVKEY", 51820, &[p]);
        assert!(
            !conf.contains("[Peer]"),
            "injected AllowedIPs peer must be dropped"
        );

        // A non-IP / out-of-range CIDR is also rejected.
        let mut p2 = peer(Some(VALID_PK));
        p2.allowed_ips = vec!["not-an-ip".to_string()];
        assert!(!WireGuardBackend::render_config("PRIVKEY", 51820, &[p2]).contains("[Peer]"));

        let mut p3 = peer(Some(VALID_PK));
        p3.allowed_ips = vec!["10.8.0.2/99".to_string()];
        assert!(!WireGuardBackend::render_config("PRIVKEY", 51820, &[p3]).contains("[Peer]"));
    }

    #[test]
    fn render_config_rejects_injection_in_endpoint() {
        // Newline / non-IP-literal endpoints must drop the peer.
        let mut p = peer(Some(VALID_PK));
        p.endpoint = Some("1.2.3.4:51820\nPersistentKeepalive = 0".to_string());
        let conf = WireGuardBackend::render_config("PRIVKEY", 51820, &[p]);
        assert!(
            !conf.contains("[Peer]"),
            "injected endpoint peer must be dropped"
        );

        let mut p2 = peer(Some(VALID_PK));
        p2.endpoint = Some("evil.example.com:51820".to_string());
        assert!(!WireGuardBackend::render_config("PRIVKEY", 51820, &[p2]).contains("[Peer]"));

        let mut p3 = peer(Some(VALID_PK));
        p3.endpoint = Some("1.2.3.4".to_string()); // missing port
        assert!(!WireGuardBackend::render_config("PRIVKEY", 51820, &[p3]).contains("[Peer]"));
    }

    #[test]
    fn render_config_accepts_ipv6_endpoint() {
        let mut p = peer(Some(VALID_PK));
        p.endpoint = Some("[fd42::2]:51820".to_string());
        p.allowed_ips = vec!["0.0.0.0/0".to_string(), "::/0".to_string()];
        let conf = WireGuardBackend::render_config("PRIVKEY", 51820, &[p]);
        assert!(conf.contains("[Peer]"));
        assert!(conf.contains("Endpoint = [fd42::2]:51820\n"));
    }

    #[test]
    fn is_peer_active_requires_recent_handshake() {
        let now = 1_000_000u64;
        // Never handshaked => not active, even if bytes were exchanged earlier.
        assert!(!WireGuardBackend::is_peer_active(0, now));
        // Handshake just now => active.
        assert!(WireGuardBackend::is_peer_active(now, now));
        // Within the window => active.
        assert!(WireGuardBackend::is_peer_active(now - 120, now));
        assert!(WireGuardBackend::is_peer_active(
            now - WireGuardBackend::ACTIVE_HANDSHAKE_WINDOW_SECS,
            now
        ));
        // Older than the window => idle/disconnected.
        assert!(!WireGuardBackend::is_peer_active(
            now - WireGuardBackend::ACTIVE_HANDSHAKE_WINDOW_SECS - 1,
            now
        ));
        // Clock skew (hs in the future) must not panic and counts as active.
        assert!(WireGuardBackend::is_peer_active(now + 10, now));
    }

    #[test]
    fn validators_accept_well_formed_and_reject_malformed() {
        assert!(is_valid_wg_key(VALID_PK));
        assert!(is_valid_wg_key(VALID_PSK));
        assert!(!is_valid_wg_key("short"));
        assert!(!is_valid_wg_key(&"A".repeat(45)));
        assert!(!is_valid_wg_key("AAAA\nBBBB"));

        assert!(is_valid_allowed_ip("10.8.0.2/32"));
        assert!(is_valid_allowed_ip("fd42::2/128"));
        assert!(is_valid_allowed_ip("10.8.0.2"));
        assert!(!is_valid_allowed_ip("10.8.0.2/33"));
        assert!(!is_valid_allowed_ip("garbage"));

        assert!(is_valid_endpoint("1.2.3.4:51820"));
        assert!(is_valid_endpoint("[fd42::2]:51820"));
        assert!(!is_valid_endpoint("1.2.3.4"));
        assert!(!is_valid_endpoint("host:51820"));
        assert!(!is_valid_endpoint("1.2.3.4:51820\n"));
    }

    #[test]
    fn render_config_skips_invalid_public_key_lengths() {
        // Too short, too long, and embedded newline are all rejected.
        let bad_short = peer(Some("tooshort"));
        let bad_long = peer(Some(&"A".repeat(45)));
        let mut bad_newline = peer(Some(VALID_PK));
        bad_newline.public_key = Some(format!("{}\n", &VALID_PK[..43]));

        let conf =
            WireGuardBackend::render_config("PRIVKEY", 51820, &[bad_short, bad_long, bad_newline]);
        assert!(
            !conf.contains("[Peer]"),
            "no malformed peer should be written"
        );
    }

    #[test]
    fn render_config_skips_peers_without_public_key() {
        let conf = WireGuardBackend::render_config("PRIVKEY", 51820, &[peer(None)]);
        assert!(!conf.contains("[Peer]"));
    }

    #[test]
    fn render_config_mixes_valid_and_invalid_peers() {
        let conf = WireGuardBackend::render_config(
            "PRIVKEY",
            51820,
            &[peer(Some("bad")), peer(Some(VALID_PK)), peer(None)],
        );
        // Exactly one [Peer] section for the single valid peer.
        assert_eq!(conf.matches("[Peer]").count(), 1);
        assert!(conf.contains(&format!("PublicKey = {VALID_PK}\n")));
    }

    #[test]
    fn parse_transfer_text_extracts_per_peer_counters() {
        const PK2: &str = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzND0=";
        let text = format!("{VALID_PK}\t1024\t2048\n{PK2}\t0\t0\n");
        let usage = WireGuardBackend::parse_transfer_text(&text);
        assert_eq!(usage.len(), 2);
        assert_eq!(usage[0].public_key.as_deref(), Some(VALID_PK));
        assert_eq!(usage[0].username, None);
        assert_eq!(usage[0].rx_bytes, 1024);
        assert_eq!(usage[0].tx_bytes, 2048);
        assert_eq!(usage[1].rx_bytes, 0);
        assert_eq!(usage[1].tx_bytes, 0);
    }

    #[test]
    fn parse_transfer_text_skips_malformed_lines() {
        let text = format!(
            "not-a-key\t1\t2\n\
             {VALID_PK}\tnotanumber\t2\n\
             {VALID_PK}\t1\n\
             \n\
             {VALID_PK}\t11\t22\n"
        );
        let usage = WireGuardBackend::parse_transfer_text(&text);
        // Only the final well-formed line survives.
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].rx_bytes, 11);
        assert_eq!(usage[0].tx_bytes, 22);
    }

    #[test]
    fn parse_transfer_text_empty_input() {
        assert!(WireGuardBackend::parse_transfer_text("").is_empty());
    }

    #[test]
    fn render_config_omits_empty_optional_fields() {
        let mut p = peer(Some(VALID_PK));
        p.allowed_ips = vec![]; // empty => no AllowedIPs line
        p.endpoint = None; // => no Endpoint line
        p.preshared_key = None; // => no PresharedKey line
        let conf = WireGuardBackend::render_config("PRIVKEY", 51820, &[p]);
        assert!(conf.contains("[Peer]"));
        assert!(!conf.contains("AllowedIPs"));
        assert!(!conf.contains("Endpoint"));
        assert!(!conf.contains("PresharedKey"));
    }
}

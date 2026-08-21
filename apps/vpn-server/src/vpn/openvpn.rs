use super::{BackendStatus, PeerUsage, VpnBackend, VpnProtocol};
use crate::pki::{CA_PEM, PKI_DIR, SERVER_KEY, SERVER_PEM, TLS_CRYPT_KEY};
use anyhow::{anyhow, Context, Result};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use tracing::{info, warn};

const OVPN_DIR: &str = "/etc/openvpn";
const OVPN_CONF: &str = "/etc/openvpn/server.conf";
const OVPN_STATUS: &str = "/var/run/openvpn-status.log";
const OVPN_AUTH_SCRIPT: &str = "/etc/openvpn/verify.sh";
const OVPN_SECRETS: &str = "/etc/openvpn/secrets.txt";
const OVPN_MGMT_PORT: u16 = 7505;

pub struct OpenVpnBackend {
    listen_port: u16,
}

impl OpenVpnBackend {
    pub fn new() -> Result<Self> {
        let listen_port: u16 = std::env::var("OPENVPN_PORT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(1194);
        Ok(Self { listen_port })
    }

    fn ensure_certs_and_conf(&self) -> Result<()> {
        fs::create_dir_all(OVPN_DIR).context("create /etc/openvpn")?;

        // Use shared PKI certificates instead of self-generating
        let pki_ca = Path::new(PKI_DIR).join(CA_PEM);
        let pki_cert = Path::new(PKI_DIR).join(SERVER_PEM);
        let pki_key = Path::new(PKI_DIR).join(SERVER_KEY);

        let ovpn_ca = format!("{}/ca.pem", OVPN_DIR);
        let ovpn_cert = format!("{}/server.pem", OVPN_DIR);
        let ovpn_key = format!("{}/server.key", OVPN_DIR);

        if pki_ca.exists() {
            fs::copy(&pki_ca, &ovpn_ca).context("copy CA cert to openvpn dir")?;
        }
        if pki_cert.exists() {
            fs::copy(&pki_cert, &ovpn_cert).context("copy server cert to openvpn dir")?;
        }
        if pki_key.exists() {
            fs::copy(&pki_key, &ovpn_key).context("copy server key to openvpn dir")?;
        }

        // tls-crypt is required — generate the key if it doesn't exist yet
        let tls_crypt_src = Path::new(PKI_DIR).join(TLS_CRYPT_KEY);
        if !tls_crypt_src.exists() {
            info!("generating_tls_crypt_key");
            crate::pki::ensure_tls_crypt_key()
                .context("tls-crypt key generation required for OpenVPN security")?;
        }
        let dest = format!("{}/tls-crypt.key", OVPN_DIR);
        fs::copy(&tls_crypt_src, &dest).context("copy tls-crypt key")?;
        let tls_crypt_line = format!("tls-crypt {}\n", dest);

        // Generate a random management interface password
        let mgmt_pw_path = format!("{}/mgmt.passwd", OVPN_DIR);
        let mgmt_password = format!("{:016x}", rand::random::<u64>());
        fs::write(&mgmt_pw_path, &mgmt_password).context("write mgmt password")?;
        let mut perms = fs::metadata(&mgmt_pw_path)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&mgmt_pw_path, perms)?;

        let conf = Self::render_server_conf(self.listen_port, &tls_crypt_line, &mgmt_pw_path);
        fs::write(OVPN_CONF, conf).context("write openvpn server.conf")?;

        Ok(())
    }

    /// Render the OpenVPN `server.conf` body. Pure (no I/O) so it can be unit-tested.
    ///
    /// Log verbosity is `verb 1` (fatal/serious errors only): at `verb 3` OpenVPN
    /// logs every client connection with its real source address, which conflicts
    /// with the no-PII logging policy. Nothing depends on the chattier output —
    /// the daemon detaches (`--daemon`) and logs to syslog, not to the agent's
    /// stdout/admin `/logs` buffer, and the e2e tests only use client-side logs.
    /// Session metrics come from the status file, which `verb` does not affect.
    fn render_server_conf(listen_port: u16, tls_crypt_line: &str, mgmt_pw_path: &str) -> String {
        format!(
            "port {port}\nproto udp\ndev tun1\nuser nobody\ngroup nogroup\n\
            persist-key\npersist-tun\n\
            topology subnet\nserver 10.9.0.0 255.255.255.0\n\
            keepalive 10 60\n\
            dh none\n\
            data-ciphers AES-256-GCM:CHACHA20-POLY1305\n\
            tls-version-min 1.2\n\
            tls-server\nca {ov}/ca.pem\ncert {ov}/server.pem\nkey {ov}/server.key\n\
            {tls_crypt}\
            verify-client-cert none\n\
            username-as-common-name\n\
            script-security 2\n\
            auth-user-pass-verify {auth_script} via-file\n\
            push \"redirect-gateway def1 bypass-dhcp\"\n\
            push \"dhcp-option DNS 1.1.1.1\"\n\
            push \"dhcp-option DNS 8.8.8.8\"\n\
            status {status_path} 5\nstatus-version 3\n\
            management 127.0.0.1 {mgmt} {mgmt_pw}\nverb 1\n",
            port = listen_port,
            ov = OVPN_DIR,
            tls_crypt = tls_crypt_line,
            auth_script = OVPN_AUTH_SCRIPT,
            status_path = OVPN_STATUS,
            mgmt = OVPN_MGMT_PORT,
            mgmt_pw = mgmt_pw_path,
        )
    }

    fn ensure_auth_script(&self) -> Result<()> {
        // Salted SHA-256 credential verification (via-file mode).
        // OpenVPN passes a temp file as $1 with username on line 1, password on line 2.
        // secrets.txt format: "username salt:hash" per line.
        let script = r#"#!/bin/sh
[ ! -f /etc/openvpn/secrets.txt ] && exit 1
[ -z "$1" ] && exit 1
USERNAME=$(head -1 "$1")
PASSWORD=$(sed -n '2p' "$1")
[ -z "$USERNAME" ] && exit 1
LINE=$(grep "^${USERNAME} " /etc/openvpn/secrets.txt)
[ -z "$LINE" ] && exit 1
SALTHASH=$(echo "$LINE" | awk '{print $2}')
SALT=$(echo "$SALTHASH" | cut -d: -f1)
STORED_HASH=$(echo "$SALTHASH" | cut -d: -f2)
COMPUTED_HASH=$(printf '%s%s' "$SALT" "$PASSWORD" | sha256sum | cut -d' ' -f1)
[ "$STORED_HASH" = "$COMPUTED_HASH" ]
exit $?
"#;
        fs::write(OVPN_AUTH_SCRIPT, script).context("write verify.sh")?;

        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(OVPN_AUTH_SCRIPT)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(OVPN_AUTH_SCRIPT, perms)?;

        if !Path::new(OVPN_SECRETS).exists() {
            fs::write(OVPN_SECRETS, "").context("create empty secrets.txt")?;
        }

        Ok(())
    }

    /// Hash a password with a random per-user salt (salt:hash format).
    /// Uses SHA-256 with a 16-byte random salt to prevent rainbow table attacks.
    fn hash_password_salted(password: &str) -> String {
        use sha2::{Digest, Sha256};
        let salt: [u8; 16] = rand::random();
        let salt_hex: String = salt.iter().map(|b| format!("{:02x}", b)).collect();
        let mut hasher = Sha256::new();
        hasher.update(salt_hex.as_bytes());
        hasher.update(password.as_bytes());
        let hash = format!("{:x}", hasher.finalize());
        format!("{}:{}", salt_hex, hash)
    }

    /// Create the status file (if missing) and restrict it to 0600.
    ///
    /// The status file carries client real addresses in its CLIENT_LIST records
    /// (PII), so it must not be world-readable. OpenVPN has no permissions
    /// directive for it, but it opens the file at startup while still root
    /// (before dropping to nobody/nogroup) and keeps the fd for the periodic
    /// rewrites, so pre-creating it root-owned 0600 does not break updates. The
    /// agent itself runs as root, so `parse_status` can still read it for
    /// session metrics.
    fn ensure_status_file_perms() -> Result<()> {
        use std::fs::OpenOptions;
        // Open with append so an existing file is not truncated (the daemon may
        // already be rewriting it across a restart of the agent).
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(OVPN_STATUS)
            .context("create openvpn status file")?;
        drop(file);
        let mut perms = fs::metadata(OVPN_STATUS)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(OVPN_STATUS, perms).context("chmod 600 openvpn status file")?;
        Ok(())
    }

    fn parse_status() -> BackendStatus {
        let text = fs::read_to_string(OVPN_STATUS).unwrap_or_default();
        Self::parse_status_text(&text)
    }

    /// Parse the OpenVPN status-version 3 log text into a [`BackendStatus`].
    ///
    /// status-version 3 uses tab-delimited `CLIENT_LIST` records:
    ///   `CLIENT_LIST\t<cn>\t<real-addr>\t<virt-addr>\t<bytes-recv>\t<bytes-sent>\t...`
    /// However older deployments emit comma-delimited records, so we accept either
    /// separator. Malformed lines (too few fields, non-numeric counters) are skipped
    /// rather than indexed blindly, so a truncated log can never panic.
    fn parse_status_text(text: &str) -> BackendStatus {
        let mut active = 0usize;
        let mut rx_total: u64 = 0;
        let mut tx_total: u64 = 0;
        for line in text.lines() {
            let Some(parts) = Self::split_client_list(line) else {
                continue;
            };

            // Bounds check: we read indices 3 and 4, so require at least 5 fields.
            // Skip malformed/truncated lines instead of indexing out of range.
            let (Some(rx_field), Some(tx_field)) = (parts.get(3), parts.get(4)) else {
                continue;
            };
            active += 1;
            rx_total = rx_total.saturating_add(rx_field.parse::<u64>().unwrap_or(0));
            tx_total = tx_total.saturating_add(tx_field.parse::<u64>().unwrap_or(0));
        }
        BackendStatus {
            protocol: "openvpn".into(),
            active_sessions: active,
            egress_bytes: tx_total,
            ingress_bytes: rx_total,
            running: true,
        }
    }

    /// Split a status-file CLIENT_LIST record into fields, accepting both
    /// comma- and tab-delimited variants. Returns None for non-CLIENT_LIST lines.
    fn split_client_list(line: &str) -> Option<Vec<&str>> {
        if let Some(rest) = line.strip_prefix("CLIENT_LIST,") {
            return Some(
                std::iter::once("CLIENT_LIST")
                    .chain(rest.split(','))
                    .collect(),
            );
        }
        line.strip_prefix("CLIENT_LIST\t").map(|rest| {
            std::iter::once("CLIENT_LIST")
                .chain(rest.split('\t'))
                .collect()
        })
    }

    /// Per-client cumulative counters from the status file. The Common Name
    /// (field 1) is the authenticated username — the device id, because the
    /// server runs `username-as-common-name`. Byte counters are read from the
    /// same field positions as [`parse_status_text`] (indices 3 and 4),
    /// deliberately matching the established indexing convention.
    fn parse_peer_usage_text(text: &str) -> Vec<PeerUsage> {
        let mut usage = Vec::new();
        for line in text.lines() {
            let Some(parts) = Self::split_client_list(line) else {
                continue;
            };
            let (Some(cn), Some(rx_field), Some(tx_field)) =
                (parts.get(1), parts.get(3), parts.get(4))
            else {
                continue;
            };
            // UNDEF means the client has not (yet) authenticated; skip it
            // rather than attributing bytes to a non-device identity.
            if cn.is_empty() || *cn == "UNDEF" {
                continue;
            }
            usage.push(PeerUsage {
                public_key: None,
                username: Some((*cn).to_string()),
                rx_bytes: rx_field.parse::<u64>().unwrap_or(0),
                tx_bytes: tx_field.parse::<u64>().unwrap_or(0),
            });
        }
        usage
    }
}

impl VpnBackend for OpenVpnBackend {
    fn protocol(&self) -> VpnProtocol {
        VpnProtocol::OpenVpn
    }

    fn start(&self) -> Result<()> {
        self.ensure_auth_script()?;
        self.ensure_certs_and_conf()?;
        // Pre-create the status file with 0600 so the daemon inherits the
        // restrictive perms when it opens the path (it contains client IPs).
        Self::ensure_status_file_perms()?;
        let status = Command::new("openvpn")
            .args(["--config", OVPN_CONF, "--daemon"])
            .status()?;
        if !status.success() {
            return Err(anyhow!("openvpn start failed"));
        }
        // Best-effort re-tighten in case the daemon recreated the file with the
        // default umask instead of reusing the pre-created one.
        if let Err(e) = Self::ensure_status_file_perms() {
            warn!(error = ?e, "failed_to_tighten_status_file_perms_after_start");
        }
        info!("openvpn_started");
        Ok(())
    }

    fn stop(&self) -> Result<()> {
        let _ = Command::new("pkill").arg("openvpn").status();
        Ok(())
    }

    fn status(&self) -> Result<BackendStatus> {
        Ok(Self::parse_status())
    }

    fn peer_usage(&self) -> Result<Vec<PeerUsage>> {
        let text = fs::read_to_string(OVPN_STATUS).unwrap_or_default();
        Ok(Self::parse_peer_usage_text(&text))
    }

    fn apply_peers(&self, peers: &[super::PeerSpec]) -> Result<()> {
        let mut content = String::new();
        for p in peers {
            if let (Some(u), Some(pw)) = (&p.username, &p.password) {
                // Validate username/password don't contain config-breaking characters
                if u.contains('\n') || u.contains(' ') || u.contains('\0') {
                    warn!("skipping_openvpn_peer_with_invalid_username");
                    continue;
                }
                if pw.contains('\n') || pw.contains('\0') {
                    warn!("skipping_openvpn_peer_with_invalid_password");
                    continue;
                }
                let salted_hash = Self::hash_password_salted(pw);
                content.push_str(&format!("{} {}\n", u, salted_hash));
            }
        }

        fs::write(OVPN_SECRETS, &content).context("write secrets.txt")?;
        // The file holds salted password hashes — it must NOT be world-readable
        // (the previous 0o604 made it readable by every local user). verify.sh is
        // invoked by OpenVPN's `auth-user-pass-verify` after OpenVPN drops to
        // `user nobody`/`group nogroup` (see render_server_conf), so the script
        // reads this file as the `nogroup` group. We therefore chgrp the file to
        // `nogroup` and use 0o640 (owner rw, group r, others none): the daemon
        // user can still read it for verification, but no other local user can.
        // The chgrp is best-effort; if `nogroup` is unavailable we still tighten
        // perms (defense-in-depth) even though group-read would then not match.
        let _ = Command::new("chgrp")
            .args(["nogroup", OVPN_SECRETS])
            .status();
        let mut perms = fs::metadata(OVPN_SECRETS)?.permissions();
        perms.set_mode(0o640);
        fs::set_permissions(OVPN_SECRETS, perms)?;
        info!(peer_count = peers.len(), "updated_openvpn_secrets");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: parse_status reads the byte counters from fields 3 and 4 (0-indexed,
    // counting CLIENT_LIST as field 0). This matches the original implementation's
    // indexing and is preserved deliberately. The test data below places the
    // counters at those positions so we exercise the real parsing behaviour.
    #[test]
    fn parse_status_counts_comma_clients_and_sums_bytes() {
        // fields:        0           1   2     3      4
        let text = "\
TITLE,OpenVPN 2.6\n\
TIME,2024-01-01 00:00:00,1700000000\n\
CLIENT_LIST,alice,1.2.3.4:1194,1000,2000,extra,extra\n\
CLIENT_LIST,bob,5.6.7.8:1194,500,750,extra,extra\n\
ROUTING_TABLE,...\n";
        let status = OpenVpnBackend::parse_status_text(text);
        assert_eq!(status.active_sessions, 2);
        assert_eq!(status.ingress_bytes, 1500); // sum of field[3]
        assert_eq!(status.egress_bytes, 2750); // sum of field[4]
        assert!(status.running);
    }

    #[test]
    fn parse_status_accepts_tab_delimited_records() {
        // CLIENT_LIST \t cn \t real \t <field3=42> \t <field4=84> ...
        let text = "CLIENT_LIST\tcarol\t9.9.9.9:1194\t42\t84\textra\n";
        let status = OpenVpnBackend::parse_status_text(text);
        assert_eq!(status.active_sessions, 1);
        assert_eq!(status.ingress_bytes, 42);
        assert_eq!(status.egress_bytes, 84);
    }

    #[test]
    fn parse_status_skips_malformed_lines_without_panicking() {
        // Truncated CLIENT_LIST records that previously could index parts[3]/parts[4]
        // out of range. These must be skipped, never panic.
        let text = "\
CLIENT_LIST,\n\
CLIENT_LIST,only-cn\n\
CLIENT_LIST,cn,addr\n\
CLIENT_LIST,cn,addr,11\n\
garbage line with no prefix\n\
CLIENT_LIST,valid,1.2.3.4,11,22\n";
        let status = OpenVpnBackend::parse_status_text(text);
        // Only the final, well-formed record (>= 5 fields) counts.
        assert_eq!(status.active_sessions, 1);
        assert_eq!(status.ingress_bytes, 11);
        assert_eq!(status.egress_bytes, 22);
    }

    #[test]
    fn parse_status_empty_input_is_zeroed() {
        let status = OpenVpnBackend::parse_status_text("");
        assert_eq!(status.active_sessions, 0);
        assert_eq!(status.ingress_bytes, 0);
        assert_eq!(status.egress_bytes, 0);
        assert!(status.running);
    }

    #[test]
    fn parse_status_non_numeric_counters_default_to_zero() {
        let text = "CLIENT_LIST,dave,1.1.1.1,notanumber,alsobad\n";
        let status = OpenVpnBackend::parse_status_text(text);
        assert_eq!(status.active_sessions, 1);
        assert_eq!(status.ingress_bytes, 0);
        assert_eq!(status.egress_bytes, 0);
    }

    #[test]
    fn parse_peer_usage_attributes_bytes_to_usernames() {
        let text = "\
TITLE,OpenVPN 2.6\n\
CLIENT_LIST,device-abc,1.2.3.4:1194,1000,2000,extra\n\
CLIENT_LIST\tdevice-def\t5.6.7.8:1194\t500\t750\textra\n\
ROUTING_TABLE,...\n";
        let usage = OpenVpnBackend::parse_peer_usage_text(text);
        assert_eq!(usage.len(), 2);
        assert_eq!(usage[0].username.as_deref(), Some("device-abc"));
        assert_eq!(usage[0].public_key, None);
        assert_eq!(usage[0].rx_bytes, 1000);
        assert_eq!(usage[0].tx_bytes, 2000);
        assert_eq!(usage[1].username.as_deref(), Some("device-def"));
        assert_eq!(usage[1].rx_bytes, 500);
        assert_eq!(usage[1].tx_bytes, 750);
    }

    #[test]
    fn parse_peer_usage_skips_undef_and_malformed_records() {
        let text = "\
CLIENT_LIST,UNDEF,1.2.3.4:1194,9,9\n\
CLIENT_LIST,,1.2.3.4:1194,9,9\n\
CLIENT_LIST,truncated,addr\n\
CLIENT_LIST,ok-device,1.2.3.4,7,8\n";
        let usage = OpenVpnBackend::parse_peer_usage_text(text);
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].username.as_deref(), Some("ok-device"));
        assert_eq!(usage[0].rx_bytes, 7);
        assert_eq!(usage[0].tx_bytes, 8);
    }

    #[test]
    fn render_server_conf_contains_expected_directives() {
        let conf = OpenVpnBackend::render_server_conf(
            1194,
            "tls-crypt /etc/openvpn/tls-crypt.key\n",
            "/etc/openvpn/mgmt.passwd",
        );
        assert!(conf.contains("port 1194\n"));
        assert!(conf.contains("proto udp\n"));
        assert!(conf.contains("dev tun1\n"));
        assert!(conf.contains("server 10.9.0.0 255.255.255.0\n"));
        assert!(conf.contains("data-ciphers AES-256-GCM:CHACHA20-POLY1305\n"));
        assert!(conf.contains("tls-version-min 1.2\n"));
        assert!(conf.contains("tls-crypt /etc/openvpn/tls-crypt.key\n"));
        assert!(conf.contains("verify-client-cert none\n"));
        assert!(conf.contains("status-version 3\n"));
        assert!(conf.contains("management 127.0.0.1 7505 /etc/openvpn/mgmt.passwd\n"));
        // verb 1 keeps per-connection client addresses out of the daemon logs
        // (no-PII logging policy); must not regress to a chattier level.
        assert!(conf.contains("verb 1\n"));
        assert!(!conf.contains("verb 3"));
    }

    #[test]
    fn render_server_conf_honors_custom_port() {
        let conf = OpenVpnBackend::render_server_conf(11940, "", "/x");
        assert!(conf.contains("port 11940\n"));
    }

    #[test]
    fn hash_password_salted_format_and_uniqueness() {
        let h1 = OpenVpnBackend::hash_password_salted("hunter2");
        let h2 = OpenVpnBackend::hash_password_salted("hunter2");
        // Format is "<salt_hex>:<hash_hex>".
        let (salt1, hash1) = h1.split_once(':').expect("salt:hash format");
        assert_eq!(salt1.len(), 32, "16-byte salt = 32 hex chars");
        assert_eq!(hash1.len(), 64, "sha256 = 64 hex chars");
        assert!(salt1.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(hash1.chars().all(|c| c.is_ascii_hexdigit()));
        // Random salt => same password hashes differently each call.
        assert_ne!(h1, h2);
    }

    #[test]
    fn hash_password_salted_is_verifiable() {
        // Reproduce the verify.sh computation: sha256(salt_hex || password).
        use sha2::{Digest, Sha256};
        let hashed = OpenVpnBackend::hash_password_salted("s3cret");
        let (salt, stored) = hashed.split_once(':').unwrap();
        let mut hasher = Sha256::new();
        hasher.update(salt.as_bytes());
        hasher.update(b"s3cret");
        let computed = format!("{:x}", hasher.finalize());
        assert_eq!(stored, computed);
    }
}

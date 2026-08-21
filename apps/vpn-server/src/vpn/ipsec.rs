use super::{BackendStatus, PeerSpec, PeerUsage, VpnBackend, VpnProtocol};
use anyhow::{Context, Result};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use tracing::{debug, info, warn};

const IPSEC_SECRETS: &str = "/etc/ipsec.secrets";

pub struct IpsecBackend;

impl IpsecBackend {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }

    fn parse_status() -> BackendStatus {
        let mut active = 0usize;
        let mut rx_total: u64 = 0;
        let mut tx_total: u64 = 0;
        // The IKEv2 backend runs the legacy stroke charon (`ipsec start`), so it
        // must be queried with `ipsec statusall` — not `swanctl`, which talks to
        // the unused vici/swanctl config backend and reports nothing here.
        if let Ok(output) = Command::new("ipsec").arg("statusall").output() {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    let trimmed = line.trim();
                    // "Security Associations (N up, M connecting):"
                    if let Some(rest) = trimmed.strip_prefix("Security Associations (") {
                        let num: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                        if let Ok(n) = num.parse::<usize>() {
                            active = n;
                        }
                    }
                    // Traffic counters appear as "<N> bytes_i, <N> bytes_o" in the
                    // CHILD_SA line.
                    rx_total = rx_total.saturating_add(digits_before(trimmed, "bytes_i"));
                    tx_total = tx_total.saturating_add(digits_before(trimmed, "bytes_o"));
                }
            }
        }
        BackendStatus {
            protocol: "ikev2".into(),
            active_sessions: active,
            egress_bytes: tx_total,
            ingress_bytes: rx_total,
            running: true,
        }
    }

    /// Parse `ipsec statusall` into per-EAP-identity cumulative counters.
    ///
    /// `statusall` lists each IKE_SA block followed by its CHILD_SAs:
    ///   conn[3]: ESTABLISHED 14 minutes ago, 10.0.0.1[srv]...203.0.113.5[id]
    ///   conn[3]: Remote EAP identity: device-abc
    ///   conn{1}:  AES_GCM_16_256, 12345 bytes_i (...), 67890 bytes_o (...)
    /// We track the identity of the current IKE_SA block ("Remote EAP
    /// identity:" preferred, falling back to the trailing bracketed remote
    /// identity on the ESTABLISHED line) and attribute subsequent CHILD_SA
    /// byte counters to it. KNOWN GAP: counters on CHILD_SA lines that appear
    /// before any identifiable IKE_SA header (truncated/reordered output) are
    /// skipped and logged at debug — fleet totals still come from
    /// [`parse_status`], only per-user attribution is lost for those lines.
    fn parse_peer_usage_text(text: &str) -> Vec<PeerUsage> {
        // Order-preserving accumulation: identity -> (rx, tx).
        let mut order: Vec<String> = Vec::new();
        let mut totals: std::collections::HashMap<String, (u64, u64)> =
            std::collections::HashMap::new();
        let mut current: Option<String> = None;

        for line in text.lines() {
            let trimmed = line.trim();

            // New IKE_SA block: "<conn>[<n>]: ESTABLISHED ..., a.b.c.d[x]...e.f.g.h[remote-id]"
            if trimmed.contains("]: ESTABLISHED") {
                current = trimmed
                    .rsplit_once('[')
                    .map(|(_, rest)| rest.trim_end_matches(']').trim().to_string())
                    .filter(|id| !id.is_empty() && id != "%any");
                continue;
            }

            // Explicit EAP identity overrides the IKE remote identity.
            if let Some((_, id)) = trimmed.split_once("Remote EAP identity:") {
                let id = id.trim();
                if !id.is_empty() {
                    current = Some(id.to_string());
                }
                continue;
            }

            // CHILD_SA traffic counters: "..., <N> bytes_i (...), <N> bytes_o (...)"
            if trimmed.contains("bytes_i") || trimmed.contains("bytes_o") {
                let rx = digits_before(trimmed, "bytes_i");
                let tx = digits_before(trimmed, "bytes_o");
                match &current {
                    Some(id) => {
                        let entry = totals.entry(id.clone()).or_insert_with(|| {
                            order.push(id.clone());
                            (0, 0)
                        });
                        entry.0 = entry.0.saturating_add(rx);
                        entry.1 = entry.1.saturating_add(tx);
                    }
                    None => {
                        debug!("ipsec_peer_usage_unattributed_counters_skipped");
                    }
                }
            }
        }

        order
            .into_iter()
            .map(|id| {
                let (rx, tx) = totals[&id];
                PeerUsage {
                    public_key: None,
                    username: Some(id),
                    rx_bytes: rx,
                    tx_bytes: tx,
                }
            })
            .collect()
    }
}

/// Parse the integer immediately preceding `kw` in `line`, e.g. the `12345` in
/// "12345 bytes_i" from `ipsec statusall` output. Returns 0 if absent.
fn digits_before(line: &str, kw: &str) -> u64 {
    let Some(pos) = line.find(kw) else {
        return 0;
    };
    let head = line[..pos].trim_end();
    let rev: String = head
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    rev.chars().rev().collect::<String>().parse().unwrap_or(0)
}

impl VpnBackend for IpsecBackend {
    fn protocol(&self) -> VpnProtocol {
        VpnProtocol::IkeV2
    }

    fn start(&self) -> Result<()> {
        // IKEv2 is started in main via setup_ikev2; nothing to do here.
        info!("ipsec backend start (no-op; managed by setup_ikev2)");
        Ok(())
    }

    fn stop(&self) -> Result<()> {
        let _ = Command::new("ipsec").arg("stop").output();
        Ok(())
    }

    fn status(&self) -> Result<BackendStatus> {
        Ok(Self::parse_status())
    }

    fn peer_usage(&self) -> Result<Vec<PeerUsage>> {
        // Same source as parse_status: the legacy stroke charon, queried via
        // `ipsec statusall` (swanctl talks to the unused vici backend here).
        let output = Command::new("ipsec").arg("statusall").output()?;
        if !output.status.success() {
            return Err(anyhow::anyhow!("ipsec statusall failed"));
        }
        Ok(Self::parse_peer_usage_text(&String::from_utf8_lossy(
            &output.stdout,
        )))
    }

    fn apply_peers(&self, peers: &[PeerSpec]) -> Result<()> {
        // Preserve existing RSA key line from ipsec.secrets
        let existing = fs::read_to_string(IPSEC_SECRETS).unwrap_or_default();
        // Preserve existing private key line (RSA or ECDSA)
        let key_line = existing
            .lines()
            .find(|l| l.contains(": RSA") || l.contains(": ECDSA"))
            .unwrap_or("")
            .to_string();

        let mut secrets = String::new();
        if !key_line.is_empty() {
            secrets.push_str(&key_line);
            secrets.push('\n');
        }

        for p in peers {
            if let (Some(u), Some(pw)) = (&p.username, &p.password) {
                // Validate username/password don't contain config-breaking characters.
                // Do NOT log the username itself — it is user-identifying (PII).
                // Identify the peer by its public-key prefix instead, consistent
                // with the redacting PeerSpec Debug impl in vpn/mod.rs.
                if u.contains('\n') || u.contains(':') || u.contains('"') {
                    warn!(
                        peer = p.public_key.as_deref().map(|k| &k[..8.min(k.len())]),
                        "skipping_peer_with_invalid_username_chars"
                    );
                    continue;
                }
                if pw.contains('\n') || pw.contains('"') {
                    warn!("skipping_peer_with_invalid_password_chars");
                    continue;
                }
                // EAP credentials for EAP-MSCHAPv2
                secrets.push_str(&format!("{u} : EAP \"{pw}\"\n"));
            }
        }

        fs::write(IPSEC_SECRETS, &secrets).context("write ipsec.secrets")?;

        // Restrict file permissions on secrets file
        let mut perms = fs::metadata(IPSEC_SECRETS)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(IPSEC_SECRETS, perms)?;

        // Reload strongSwan to pick up new EAP credentials. The IKEv2 backend
        // uses the legacy stroke charon (started via `ipsec start`), which reads
        // /etc/ipsec.secrets — so it must be reloaded with `ipsec rereadsecrets`.
        // `swanctl --load-all` (used previously) only reloads the unused vici
        // config and never picked up new peers, so EAP-MSCHAPv2 always failed
        // for any peer registered after charon startup.
        let _ = Command::new("ipsec").arg("rereadsecrets").output();

        info!(peer_count = peers.len(), "updated_ipsec_peers");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{digits_before, IpsecBackend};

    #[test]
    fn parses_byte_counter_before_keyword() {
        // Real `ipsec statusall` CHILD_SA line format.
        let line =
            "ikev2-eap{1}:  AES_GCM_16_256, 12345 bytes_i, 67890 bytes_o, rekeying in 42 minutes";
        assert_eq!(digits_before(line, "bytes_i"), 12345);
        assert_eq!(digits_before(line, "bytes_o"), 67890);
    }

    #[test]
    fn digits_before_zero_and_missing() {
        assert_eq!(digits_before("0 bytes_i, 0 bytes_o", "bytes_i"), 0);
        assert_eq!(digits_before("no counters here", "bytes_i"), 0);
        assert_eq!(digits_before("bytes_i", "bytes_i"), 0); // no preceding number
    }

    #[test]
    fn parse_peer_usage_attributes_child_sa_bytes_to_eap_identity() {
        let text = "\
Security Associations (2 up, 0 connecting):
ikev2-eap[3]: ESTABLISHED 14 minutes ago, 10.0.0.1[vpn.example.com]...203.0.113.5[anon-ike-id]
ikev2-eap[3]: Remote EAP identity: device-abc
ikev2-eap{1}:  INSTALLED, TUNNEL, reqid 1, ESP SPIs: c2a93a25_i c9c34fd4_o
ikev2-eap{1}:  AES_GCM_16_256, 12345 bytes_i (231 pkts, 4s ago), 67890 bytes_o (190 pkts, 4s ago), rekeying in 42 minutes
ikev2-eap[4]: ESTABLISHED 2 minutes ago, 10.0.0.1[vpn.example.com]...198.51.100.7[device-def]
ikev2-eap{2}:  INSTALLED, TUNNEL, reqid 2, ESP SPIs: aaaa_i bbbb_o
ikev2-eap{2}:  AES_GCM_16_256, 100 bytes_i, 200 bytes_o, rekeying in 10 minutes
";
        let usage = IpsecBackend::parse_peer_usage_text(text);
        assert_eq!(usage.len(), 2);
        // Explicit EAP identity wins over the IKE remote identity.
        assert_eq!(usage[0].username.as_deref(), Some("device-abc"));
        assert_eq!(usage[0].public_key, None);
        assert_eq!(usage[0].rx_bytes, 12345);
        assert_eq!(usage[0].tx_bytes, 67890);
        // Without a Remote EAP identity line, fall back to the bracketed
        // remote identity on the ESTABLISHED line.
        assert_eq!(usage[1].username.as_deref(), Some("device-def"));
        assert_eq!(usage[1].rx_bytes, 100);
        assert_eq!(usage[1].tx_bytes, 200);
    }

    #[test]
    fn parse_peer_usage_accumulates_multiple_child_sas_per_identity() {
        let text = "\
conn[1]: ESTABLISHED 1 minute ago, 10.0.0.1[srv]...1.2.3.4[device-x]
conn{1}:  AES_GCM_16_256, 10 bytes_i, 20 bytes_o, rekeying in 5 minutes
conn{2}:  AES_GCM_16_256, 1 bytes_i, 2 bytes_o, rekeying in 5 minutes
";
        let usage = IpsecBackend::parse_peer_usage_text(text);
        assert_eq!(usage.len(), 1);
        assert_eq!(usage[0].username.as_deref(), Some("device-x"));
        assert_eq!(usage[0].rx_bytes, 11);
        assert_eq!(usage[0].tx_bytes, 22);
    }

    #[test]
    fn parse_peer_usage_skips_unattributed_and_anonymous_counters() {
        // Counters before any IKE_SA header, and an SA whose remote identity
        // is %any with no EAP identity line, are both skipped (documented gap).
        let text = "\
conn{9}:  AES_GCM_16_256, 999 bytes_i, 999 bytes_o
conn[2]: ESTABLISHED 1 minute ago, 10.0.0.1[srv]...1.2.3.4[%any]
conn{3}:  AES_GCM_16_256, 5 bytes_i, 6 bytes_o
";
        let usage = IpsecBackend::parse_peer_usage_text(text);
        assert!(usage.is_empty());
    }

    #[test]
    fn parse_peer_usage_empty_input() {
        assert!(IpsecBackend::parse_peer_usage_text("").is_empty());
    }
}

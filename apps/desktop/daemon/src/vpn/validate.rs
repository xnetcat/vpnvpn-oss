//! Validation of attacker-influenced [`VpnConfig`] fields before they are written
//! into privileged configuration files.
//!
//! The daemon runs as root and writes WireGuard / OpenVPN / strongSwan config
//! files that are then handed to `wg-quick`, `openvpn`, and `ipsec`. Several of
//! those config formats allow embedding shell commands that run as root (e.g.
//! WireGuard's `PostUp`/`PreUp`/`PostDown`, OpenVPN's `up`/`down`/`script-security`).
//! If any config field reaches the file unescaped, a malicious or compromised
//! upstream (or a tampered local profile) could inject an extra directive via a
//! newline and achieve local privilege escalation to root.
//!
//! The functions here reject—rather than try to escape—anything that could break
//! out of the intended field: embedded newlines, INI section headers (`[`), and
//! the dangerous script directives. They also validate the structural fields
//! (endpoints, keys, IPs, CIDRs) so a malformed value can never silently produce
//! a misconfigured tunnel.

use anyhow::{bail, Result};
use std::net::IpAddr;
use vpnvpn_shared::protocol::{Protocol, VpnConfig};

/// Config directives that execute shell commands as root when present in a
/// WireGuard or strongSwan config. These must never appear inside an
/// attacker-influenced field, regardless of casing.
const FORBIDDEN_DIRECTIVES: &[&str] = &[
    "postup",
    "preup",
    "postdown",
    "predown",
    "table",
    "script-security",
    "up ",
    "down ",
];

/// Reject a value that could break out of a single config field/line.
///
/// A safe value contains no newlines (which would let an attacker append a new
/// directive line) and no `[` (which would let them open a new INI section such
/// as a second `[Interface]` with a `PostUp`). It must also not itself name one
/// of the forbidden command-executing directives.
fn reject_injection(field: &str, value: &str) -> Result<()> {
    if value.contains('\n') || value.contains('\r') {
        bail!("{field} contains a newline; refusing to write config");
    }
    if value.contains('[') || value.contains(']') {
        bail!("{field} contains an INI section character; refusing to write config");
    }
    if value.contains('\0') {
        bail!("{field} contains a NUL byte; refusing to write config");
    }
    let lower = value.to_ascii_lowercase();
    for directive in FORBIDDEN_DIRECTIVES {
        if lower.contains(directive) {
            bail!("{field} contains forbidden directive '{directive}'; refusing to write config");
        }
    }
    Ok(())
}

/// Validate a base64 WireGuard key (private/public/preshared), which decodes to
/// exactly 32 bytes (43 chars unpadded / 44 padded).
fn validate_wg_key(field: &str, value: &str) -> Result<()> {
    let trimmed = value.trim();
    reject_injection(field, trimmed)?;
    // WireGuard keys are url-unsafe standard base64 of 32 bytes.
    let normalized = match trimmed.len() {
        43 => format!("{trimmed}="),
        42 => format!("{trimmed}=="),
        44 => trimmed.to_string(),
        _ => bail!("{field} is not a valid 32-byte WireGuard key"),
    };
    use base64::Engine;
    match base64::engine::general_purpose::STANDARD.decode(normalized.as_bytes()) {
        Ok(bytes) if bytes.len() == 32 => Ok(()),
        _ => bail!("{field} is not valid base64 of a 32-byte key"),
    }
}

/// Validate `host:port` or bare host endpoint. `host` may be an IP or DNS name;
/// it must contain only characters valid in a hostname/IP literal so it cannot
/// inject config syntax.
pub fn validate_endpoint_host(field: &str, host: &str) -> Result<()> {
    let host = host.trim();
    reject_injection(field, host)?;
    if host.is_empty() {
        bail!("{field} is empty");
    }
    // IPv6 literals may appear bracketed in URLs but we strip brackets earlier;
    // accept a literal IP, otherwise validate as a DNS hostname.
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    // DNS hostname: labels of [A-Za-z0-9-], separated by dots. Allow underscore
    // (some providers use it) but nothing that could break config syntax.
    let valid = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'));
    if !valid {
        bail!("{field} '{host}' is not a valid host");
    }
    if host.len() > 253 {
        bail!("{field} is too long to be a valid host");
    }
    Ok(())
}

/// Validate a single DNS server entry is a literal IP address.
fn validate_dns(value: &str) -> Result<()> {
    let v = value.trim();
    reject_injection("dns_servers", v)?;
    if v.parse::<IpAddr>().is_err() {
        bail!("dns server '{v}' is not a valid IP address");
    }
    Ok(())
}

/// Validate an `ip` or `ip/prefix` value (used for assigned address / allowed IPs).
pub fn validate_cidr_or_ip(field: &str, value: &str) -> Result<()> {
    let v = value.trim();
    reject_injection(field, v)?;
    let (addr, prefix) = match v.split_once('/') {
        Some((a, p)) => (a, Some(p)),
        None => (v, None),
    };
    let ip: IpAddr = addr
        .parse()
        .map_err(|_| anyhow::anyhow!("{field} '{addr}' is not a valid IP address"))?;
    if let Some(prefix) = prefix {
        let max = match ip {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        let p: u8 = prefix
            .parse()
            .map_err(|_| anyhow::anyhow!("{field} prefix '{prefix}' is not a number"))?;
        if p > max {
            bail!("{field} prefix /{p} exceeds maximum /{max}");
        }
    }
    Ok(())
}

/// Validate every attacker-influenced field of a [`VpnConfig`] before any config
/// file is written. Returns an error (which the caller surfaces as a connection
/// failure) if any field is unsafe.
pub fn validate_config(config: &VpnConfig) -> Result<()> {
    // Common fields that flow into every backend's config.
    validate_endpoint_host("server_endpoint", &config.server_endpoint)?;
    for dns in &config.dns_servers {
        validate_dns(dns)?;
    }
    // server_id / server_region are written into comments/identifiers; ensure
    // they can't break out of a line or open a section.
    reject_injection("server_id", &config.server_id)?;
    reject_injection("server_region", &config.server_region)?;

    match config.protocol {
        Protocol::WireGuard => {
            if let Some(k) = &config.wg_private_key {
                validate_wg_key("wg_private_key", k)?;
            }
            if let Some(k) = &config.wg_server_public_key {
                validate_wg_key("wg_server_public_key", k)?;
            }
            if let Some(k) = &config.wg_public_key {
                validate_wg_key("wg_public_key", k)?;
            }
            if let Some(k) = &config.wg_preshared_key {
                validate_wg_key("wg_preshared_key", k)?;
            }
            if let Some(ip) = &config.assigned_ip {
                validate_cidr_or_ip("assigned_ip", ip)?;
            }
        }
        Protocol::OpenVPN => {
            // ovpn_config is a full config blob supplied upstream. We can't fully
            // parse it, but we forbid the directives that run commands as root.
            if let Some(blob) = &config.ovpn_config {
                validate_openvpn_blob(blob)?;
            }
            validate_credentials(config)?;
        }
        Protocol::IKEv2 => {
            if let Some(id) = &config.ikev2_identity {
                reject_injection("ikev2_identity", id)?;
            }
            if let Some(id) = &config.ikev2_remote_id {
                reject_injection("ikev2_remote_id", id)?;
            }
            validate_credentials(config)?;
        }
    }

    Ok(())
}

/// Validate generic username/password used by OpenVPN/IKEv2. These are written
/// into auth/secrets files; reject anything that could break out of the line.
fn validate_credentials(config: &VpnConfig) -> Result<()> {
    if let Some(u) = &config.username {
        reject_injection("username", u)?;
    }
    if let Some(p) = &config.password {
        // Passwords may contain `[`; the only real risk is a newline injecting a
        // new line into the auth file, so only reject control characters.
        if p.contains('\n') || p.contains('\r') || p.contains('\0') {
            bail!("password contains a newline; refusing to write auth file");
        }
    }
    Ok(())
}

/// Scan an upstream-supplied OpenVPN config blob for directives that execute
/// commands. OpenVPN only runs scripts when `script-security 2` (or higher) is
/// set together with `up`/`down`/`route-up`/etc.; rejecting any of these (and
/// the equivalent on Windows) keeps a malicious blob from running code as root.
fn validate_openvpn_blob(blob: &str) -> Result<()> {
    const DANGEROUS: &[&str] = &[
        "script-security",
        "up ",
        "down ",
        "up-restart",
        "route-up",
        "route-pre-down",
        "ipchange",
        "tls-verify",
        "auth-user-pass-verify",
        "client-connect",
        "client-disconnect",
        "learn-address",
        "setenv-safe",
    ];
    for line in blob.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with(';') {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        for directive in DANGEROUS {
            // Match the directive at the start of a line (a config directive),
            // tolerating leading whitespace already trimmed above.
            if lower == directive.trim() || lower.starts_with(directive) {
                bail!(
                    "OpenVPN config contains forbidden script directive '{}'; refusing to connect",
                    directive.trim()
                );
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wg_key() -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode([7u8; 32])
    }

    fn base_wg_config() -> VpnConfig {
        VpnConfig {
            protocol: Protocol::WireGuard,
            server_endpoint: "vpn.example.com".to_string(),
            server_port: 51820,
            wg_private_key: Some(wg_key()),
            wg_server_public_key: Some(wg_key()),
            assigned_ip: Some("10.0.0.2/32".to_string()),
            dns_servers: vec!["1.1.1.1".to_string()],
            ..Default::default()
        }
    }

    #[test]
    fn accepts_a_clean_wireguard_config() {
        assert!(validate_config(&base_wg_config()).is_ok());
    }

    #[test]
    fn rejects_postup_newline_injection_in_endpoint() {
        let mut cfg = base_wg_config();
        cfg.server_endpoint = "vpn.example.com\nPostUp = touch /tmp/pwned".to_string();
        let err = validate_config(&cfg).unwrap_err().to_string();
        assert!(err.contains("newline"), "got: {err}");
    }

    #[test]
    fn rejects_postup_directive_in_field() {
        let mut cfg = base_wg_config();
        // No newline, but the value itself names the dangerous directive.
        cfg.server_region = "PostUp = evil".to_string();
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_section_header_injection() {
        let mut cfg = base_wg_config();
        cfg.server_endpoint = "vpn.example.com]".to_string();
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_bad_assigned_ip() {
        let mut cfg = base_wg_config();
        cfg.assigned_ip = Some("not-an-ip".to_string());
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_non_ip_dns() {
        let mut cfg = base_wg_config();
        cfg.dns_servers = vec!["evil.example.com".to_string()];
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_short_wg_key() {
        let mut cfg = base_wg_config();
        cfg.wg_private_key = Some("too-short".to_string());
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn accepts_ip_endpoint() {
        let mut cfg = base_wg_config();
        cfg.server_endpoint = "203.0.113.7".to_string();
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn rejects_openvpn_script_security() {
        let cfg = VpnConfig {
            protocol: Protocol::OpenVPN,
            server_endpoint: "vpn.example.com".to_string(),
            ovpn_config: Some("client\nscript-security 2\nup /tmp/evil.sh\n".to_string()),
            username: Some("u".to_string()),
            password: Some("p".to_string()),
            dns_servers: vec!["1.1.1.1".to_string()],
            ..Default::default()
        };
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn accepts_clean_openvpn_blob() {
        let cfg = VpnConfig {
            protocol: Protocol::OpenVPN,
            server_endpoint: "vpn.example.com".to_string(),
            ovpn_config: Some(
                "client\ndev tun\nproto udp\nremote vpn.example.com 1194\n# up comment\n"
                    .to_string(),
            ),
            username: Some("u".to_string()),
            password: Some("p".to_string()),
            dns_servers: vec!["1.1.1.1".to_string()],
            ..Default::default()
        };
        assert!(validate_config(&cfg).is_ok());
    }

    #[test]
    fn rejects_newline_in_openvpn_password() {
        let cfg = VpnConfig {
            protocol: Protocol::OpenVPN,
            server_endpoint: "vpn.example.com".to_string(),
            ovpn_config: Some("client\n".to_string()),
            username: Some("user".to_string()),
            password: Some("pass\ninjected".to_string()),
            dns_servers: vec!["1.1.1.1".to_string()],
            ..Default::default()
        };
        assert!(validate_config(&cfg).is_err());
    }

    #[test]
    fn rejects_ikev2_identity_injection() {
        let cfg = VpnConfig {
            protocol: Protocol::IKEv2,
            server_endpoint: "vpn.example.com".to_string(),
            ikev2_identity: Some("id\n    leftupdown=/tmp/evil".to_string()),
            username: Some("u".to_string()),
            password: Some("p".to_string()),
            dns_servers: vec!["1.1.1.1".to_string()],
            ..Default::default()
        };
        assert!(validate_config(&cfg).is_err());
    }
}

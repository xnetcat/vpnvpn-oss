use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use rcgen::{
    BasicConstraints, Certificate, CertificateParams, DistinguishedName, DnType,
    ExtendedKeyUsagePurpose, IsCa, KeyUsagePurpose, SanType, PKCS_ECDSA_P256_SHA256,
};
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;
use std::{fs, path::Path};
use zeroize::Zeroizing;

pub const PKI_DIR: &str = "/etc/vpnvpn/pki";
pub const CA_PEM: &str = "ca.pem";
pub const SERVER_PEM: &str = "server.pem";
pub const SERVER_KEY: &str = "server.key";
pub const TLS_CRYPT_KEY: &str = "tls-crypt.key";

pub struct PkiArtifacts {
    pub ca_pem: String,
    pub server_pem: String,
    pub server_fingerprint: String,
}

/// Set restrictive permissions (0o600) on a file containing sensitive material.
fn restrict_permissions(path: &Path) -> Result<()> {
    let mut perms = fs::metadata(path)
        .with_context(|| format!("stat {}", path.display()))?
        .permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms).with_context(|| format!("chmod 0600 {}", path.display()))?;
    Ok(())
}

/// Set restrictive permissions (0o700) on a directory containing sensitive material.
fn restrict_dir_permissions(path: &Path) -> Result<()> {
    let mut perms = fs::metadata(path)
        .with_context(|| format!("stat {}", path.display()))?
        .permissions();
    perms.set_mode(0o700);
    fs::set_permissions(path, perms).with_context(|| format!("chmod 0700 {}", path.display()))?;
    Ok(())
}

/// Build [`PkiArtifacts`] from an env-provided CA bundle + fingerprint, reading the
/// server certificate from `server_pem_path`.
///
/// Returns an error if the server certificate file is missing or unreadable. This
/// replaces the previous `unwrap_or_default()` behaviour, which would silently hand
/// back an empty server cert and break the backends downstream.
fn pki_from_env(ca: String, fp: String, server_pem_path: &Path) -> Result<PkiArtifacts> {
    let server_pem = fs::read_to_string(server_pem_path).with_context(|| {
        format!(
            "VPN_OVPN_CA_BUNDLE is set but server cert is missing/unreadable at {}",
            server_pem_path.display()
        )
    })?;
    Ok(PkiArtifacts {
        ca_pem: ca,
        server_pem,
        server_fingerprint: fp,
    })
}

/// Decide whether regenerating PKI would orphan an existing CA: true when a CA
/// cert is present but the server cert is gone. In that state we cannot re-sign a
/// server cert (the CA key is not persisted), so minting fresh PKI would create a
/// new CA and break already-distributed client trust. Pure so it can be tested.
fn would_orphan_existing_ca(ca_exists: bool, server_exists: bool) -> bool {
    ca_exists && !server_exists
}

pub fn ensure_pki(public_ip: Option<String>) -> Result<PkiArtifacts> {
    // If env already provides OVPN bundle/fingerprint, respect it and skip generation.
    if let (Ok(ca), Ok(fp)) = (
        std::env::var("VPN_OVPN_CA_BUNDLE"),
        std::env::var("VPN_OVPN_PEER_FINGERPRINT"),
    ) {
        let server_pem_path = Path::new(PKI_DIR).join(SERVER_PEM);
        return pki_from_env(ca, fp, &server_pem_path);
    }

    fs::create_dir_all(PKI_DIR).context("create pki dir")?;
    restrict_dir_permissions(Path::new(PKI_DIR))?;

    let ca_pem_path = Path::new(PKI_DIR).join(CA_PEM);
    let server_pem_path = Path::new(PKI_DIR).join(SERVER_PEM);
    let server_key_path = Path::new(PKI_DIR).join(SERVER_KEY);

    // Common case: CA and server both already exist — reuse them as-is.
    if ca_pem_path.exists() && server_pem_path.exists() {
        let ca_pem = fs::read_to_string(&ca_pem_path).context("read existing ca pem")?;
        let server_pem =
            fs::read_to_string(&server_pem_path).context("read existing server pem")?;
        let fingerprint = fingerprint_pem(&server_pem)?;
        return Ok(PkiArtifacts {
            ca_pem,
            server_pem,
            server_fingerprint: fingerprint,
        });
    }

    // SAFETY: refuse to silently re-mint a NEW CA when one already exists.
    //
    // The CA private key is intentionally never persisted to disk (see below), so
    // if the CA cert exists but the server cert is missing we CANNOT re-sign a new
    // server cert under the existing CA — generating fresh PKI here would create a
    // brand-new CA, silently invalidating the trust anchor already distributed to
    // every existing client. That is a hard failure that needs operator action
    // (restore the server cert, or deliberately wipe the PKI dir to start over),
    // not a silent regeneration.
    if would_orphan_existing_ca(ca_pem_path.exists(), server_pem_path.exists()) {
        return Err(anyhow!(
            "CA exists at {} but server cert is missing at {}; refusing to mint a new CA \
             (the existing CA key is not persisted, so a regenerated CA would break trust for \
             already-distributed clients). Restore the server cert or remove {} to regenerate \
             the PKI from scratch.",
            ca_pem_path.display(),
            server_pem_path.display(),
            PKI_DIR,
        ));
    }

    // Generate fresh CA and server cert with ECDSA P-256 (PKCS_ECDSA_P256_SHA256).
    // (strongSwan 5.9+ accepts ECDSA P-256 server keys; see ikev2.rs, which
    // converts the key to PKCS#8 for charon.)
    let mut ca_params = CertificateParams::default();
    ca_params.alg = &PKCS_ECDSA_P256_SHA256;
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    ca_params.distinguished_name = DistinguishedName::new();
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "vpnvpn-ca");
    let ca_cert = Certificate::from_params(ca_params)?;
    let ca_pem = ca_cert.serialize_pem()?;
    fs::write(&ca_pem_path, &ca_pem).context("write ca pem")?;
    // CA private key is only needed during this function to sign the server cert.
    // Do not persist it to disk to reduce exposure surface.

    let mut server_params = CertificateParams::new(vec!["vpnvpn-server".into()]);
    server_params.alg = &PKCS_ECDSA_P256_SHA256;
    if let Some(ip) = public_ip {
        if let Ok(parsed_ip) = ip.parse() {
            server_params
                .subject_alt_names
                .push(SanType::IpAddress(parsed_ip));
        }
    }
    server_params.distinguished_name = DistinguishedName::new();
    server_params
        .distinguished_name
        .push(DnType::CommonName, "vpnvpn-server");
    server_params.is_ca = IsCa::NoCa;
    server_params.use_authority_key_identifier_extension = true;
    server_params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyEncipherment,
    ];
    server_params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let server_cert = Certificate::from_params(server_params)?;
    let server_pem = server_cert.serialize_pem_with_signer(&ca_cert)?;
    fs::write(&server_pem_path, &server_pem).context("write server pem")?;
    // Wrap server key in Zeroizing to clear from memory after write
    let server_key_pem = Zeroizing::new(server_cert.serialize_private_key_pem());
    fs::write(&server_key_path, server_key_pem.as_str()).context("write server key")?;
    drop(server_key_pem);
    restrict_permissions(&server_key_path)?;

    let fingerprint = fingerprint_pem(&server_pem)?;

    Ok(PkiArtifacts {
        ca_pem,
        server_pem,
        server_fingerprint: fingerprint,
    })
}

pub fn ensure_tls_crypt_key() -> Result<String> {
    let key_path = Path::new(PKI_DIR).join(TLS_CRYPT_KEY);
    if key_path.exists() {
        return fs::read_to_string(&key_path).context("read existing tls-crypt key");
    }

    fs::create_dir_all(PKI_DIR).context("create pki dir")?;
    restrict_dir_permissions(Path::new(PKI_DIR))?;

    let key_path_str = key_path
        .to_str()
        .ok_or_else(|| anyhow!("invalid tls-crypt key path"))?;

    let status = std::process::Command::new("openvpn")
        .args(["--genkey", "secret", key_path_str])
        .status()
        .context("run openvpn --genkey")?;

    if !status.success() {
        return Err(anyhow!("openvpn --genkey failed"));
    }

    restrict_permissions(&key_path)?;
    fs::read_to_string(&key_path).context("read generated tls-crypt key")
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>> {
    let stripped = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<String>();
    let der = BASE64_STANDARD
        .decode(stripped)
        .map_err(|e| anyhow!("pem base64 decode failed: {e}"))?;
    Ok(der)
}

fn fingerprint_pem(pem: &str) -> Result<String> {
    let der = pem_to_der(pem)?;
    let digest = Sha256::digest(&der);
    Ok(digest
        .iter()
        .map(|b| format!("{:02X}", b))
        .collect::<Vec<_>>()
        .join(":"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wrap arbitrary bytes in a minimal PEM-like envelope.
    fn pem_envelope(body: &str) -> String {
        format!("-----BEGIN CERTIFICATE-----\n{body}\n-----END CERTIFICATE-----\n")
    }

    #[test]
    fn pem_to_der_base64_round_trip() {
        let der_in: Vec<u8> = vec![0x30, 0x82, 0x01, 0x0a, 0xde, 0xad, 0xbe, 0xef, 0x00, 0xff];
        let b64 = BASE64_STANDARD.encode(&der_in);
        let pem = pem_envelope(&b64);
        let der_out = pem_to_der(&pem).expect("decode succeeds");
        assert_eq!(der_out, der_in);
    }

    #[test]
    fn pem_to_der_handles_multiline_body() {
        let der_in: Vec<u8> = (0u8..96).collect();
        let b64 = BASE64_STANDARD.encode(&der_in);
        // Split the base64 across several lines, as real PEM does.
        let wrapped: String = b64
            .as_bytes()
            .chunks(16)
            .map(|c| format!("{}\n", std::str::from_utf8(c).unwrap()))
            .collect();
        let pem = format!("-----BEGIN CERTIFICATE-----\n{wrapped}-----END CERTIFICATE-----\n");
        let der_out = pem_to_der(&pem).expect("decode succeeds");
        assert_eq!(der_out, der_in);
    }

    #[test]
    fn pem_to_der_rejects_invalid_base64() {
        let pem = pem_envelope("not valid base64 !!!");
        assert!(pem_to_der(&pem).is_err());
    }

    #[test]
    fn fingerprint_pem_matches_sha256_of_der() {
        let der_in: Vec<u8> = vec![1, 2, 3, 4, 5];
        let b64 = BASE64_STANDARD.encode(&der_in);
        let pem = pem_envelope(&b64);

        let fp = fingerprint_pem(&pem).expect("fingerprint succeeds");
        // Expected: uppercase hex of SHA-256(der), colon-separated.
        let expected_digest = Sha256::digest(&der_in);
        let expected: String = expected_digest
            .iter()
            .map(|b| format!("{:02X}", b))
            .collect::<Vec<_>>()
            .join(":");
        assert_eq!(fp, expected);
        // 32-byte digest => 32 colon-separated hex pairs.
        assert_eq!(fp.split(':').count(), 32);
    }

    #[test]
    fn would_orphan_existing_ca_logic() {
        // CA present, server missing => regeneration would orphan the CA (true).
        assert!(would_orphan_existing_ca(true, false));
        // Both present => reuse path, no orphan.
        assert!(!would_orphan_existing_ca(true, true));
        // Neither present => fresh generation is safe (no existing trust anchor).
        assert!(!would_orphan_existing_ca(false, false));
        // Server present but no CA => unusual, but not an orphaned-CA case.
        assert!(!would_orphan_existing_ca(false, true));
    }

    #[test]
    fn pki_from_env_reads_server_cert() {
        let dir = tempfile::tempdir().unwrap();
        let server_path = dir.path().join(SERVER_PEM);
        std::fs::write(&server_path, "SERVER-CERT-BODY").unwrap();

        let artifacts = pki_from_env(
            "CA-BUNDLE".to_string(),
            "AA:BB:CC".to_string(),
            &server_path,
        )
        .expect("present cert => ok");

        assert_eq!(artifacts.ca_pem, "CA-BUNDLE");
        assert_eq!(artifacts.server_fingerprint, "AA:BB:CC");
        assert_eq!(artifacts.server_pem, "SERVER-CERT-BODY");
    }

    #[test]
    fn pki_from_env_errors_when_server_cert_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist.pem");

        // Don't use expect_err: PkiArtifacts intentionally has no Debug impl to
        // avoid leaking cert material in test output.
        let result = pki_from_env("CA".to_string(), "FP".to_string(), &missing);
        let err = match result {
            Ok(_) => panic!("missing cert should error, not return empty string"),
            Err(e) => e,
        };
        let msg = format!("{err:#}");
        assert!(
            msg.contains("server cert is missing/unreadable"),
            "unexpected error message: {msg}"
        );
    }
}

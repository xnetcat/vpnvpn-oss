use crate::pki::{CA_PEM, PKI_DIR, SERVER_KEY, SERVER_PEM};
use anyhow::{anyhow, Context, Result};
use std::{fs, path::Path, process::Command};
use tracing::{info, warn};
use zeroize::Zeroizing;

#[derive(Debug, Clone)]
pub struct IkeMetadata {
    pub remote: String,
    pub ca_pem: String,
    pub server_fingerprint: String,
}

/// Convert a SEC1 ("EC PRIVATE KEY") PEM to an unencrypted PKCS#8 PEM via `openssl`.
/// Returns an error (instead of falling back) so callers never persist a key format
/// strongSwan may reject. The returned key is zeroized on drop.
fn convert_ec_key_to_pkcs8(ec_key_pem: &str) -> Result<Zeroizing<String>> {
    use std::io::Write;

    let mut child = Command::new("openssl")
        .args([
            "pkcs8",
            "-topk8",
            "-nocrypt",
            "-in",
            "/dev/stdin",
            "-out",
            "/dev/stdout",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .context("spawn openssl pkcs8")?;

    if let Some(ref mut stdin) = child.stdin {
        stdin
            .write_all(ec_key_pem.as_bytes())
            .context("write key to openssl stdin")?;
    }

    let output = child.wait_with_output().context("wait for openssl pkcs8")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "openssl pkcs8 conversion failed (exit {:?}): {}",
            output.status.code(),
            stderr.trim()
        ));
    }

    let pkcs8 = Zeroizing::new(String::from_utf8_lossy(&output.stdout).to_string());
    if !pkcs8.contains("BEGIN PRIVATE KEY") {
        return Err(anyhow!(
            "openssl pkcs8 conversion produced unexpected output (no PKCS#8 PEM)"
        ));
    }
    Ok(pkcs8)
}

/// Verify that the spawned `ipsec start --nofork` process actually came up.
///
/// Two failure modes are checked, polling for a few seconds:
///   1. The child process exited early (charon failed to start / config rejected).
///   2. The child is alive but `ipsec status` cannot reach the daemon.
fn verify_ipsec_started(child: &mut std::process::Child) -> Result<()> {
    use std::thread::sleep;
    use std::time::Duration;

    const ATTEMPTS: u32 = 10;
    for attempt in 1..=ATTEMPTS {
        sleep(Duration::from_millis(500));

        // 1. Did the foreground process die already?
        match child.try_wait() {
            Ok(Some(status)) => {
                return Err(anyhow!(
                    "ipsec start exited early with {:?} before charon was up",
                    status.code()
                ));
            }
            Ok(None) => {} // still running, good
            Err(e) => {
                return Err(anyhow!("failed to poll ipsec child process: {e}"));
            }
        }

        // 2. Is the daemon reachable? `ipsec status` succeeds once charon answers.
        if let Ok(out) = Command::new("ipsec").arg("status").output() {
            if out.status.success() {
                info!(attempt, "ipsec_started_and_reachable");
                return Ok(());
            }
        }
    }

    Err(anyhow!(
        "ipsec did not become reachable after {} attempts; charon may have failed to start",
        ATTEMPTS
    ))
}

pub fn setup_ikev2(
    public_ip: Option<String>,
    ca_pem: &str,
    server_pem: &str,
    server_fingerprint: &str,
) -> Result<IkeMetadata> {
    let enabled = std::env::var("IKEV2_ENABLED")
        .ok()
        .map(|v| v.to_lowercase() != "false")
        .unwrap_or(true);
    if !enabled {
        info!("ikev2 disabled via IKEV2_ENABLED=false");
        return Err(anyhow!("ikev2 disabled"));
    }

    let base = Path::new("/etc/ipsec.d");
    let cacerts = base.join("cacerts");
    let certs = base.join("certs");
    let private = base.join("private");
    fs::create_dir_all(&cacerts).context("create cacerts")?;
    fs::create_dir_all(&certs).context("create certs")?;
    fs::create_dir_all(&private).context("create private")?;

    let ca_path = cacerts.join(CA_PEM);
    let server_path = certs.join(SERVER_PEM);
    let key_path = private.join(SERVER_KEY);

    fs::write(&ca_path, ca_pem).context("write ikev2 ca pem")?;
    fs::write(&server_path, server_pem).context("write ikev2 server pem")?;
    let stored_key = Zeroizing::new(
        fs::read_to_string(Path::new(PKI_DIR).join(SERVER_KEY))
            .context("read generated server key")?,
    );
    // Convert to PKCS#8 if needed — strongSwan 5.9+ expects PKCS#8 for ECDSA keys.
    // A SEC1 ("EC PRIVATE KEY") key is not reliably accepted by charon, so a failed
    // conversion is a hard error rather than a silent fallback to a key strongSwan
    // would reject at load time (which would surface much later as auth failures).
    let key_str = stored_key.as_str();
    if key_str.contains("BEGIN EC PRIVATE KEY") {
        let pkcs8_key = convert_ec_key_to_pkcs8(key_str)
            .context("convert ECDSA server key to PKCS#8 for strongSwan")?;
        fs::write(&key_path, pkcs8_key.as_str()).context("write ikev2 server key (pkcs8)")?;
    } else {
        fs::write(&key_path, key_str).context("write ikev2 server key")?;
    }
    drop(stored_key);

    // Restrict permissions on private key
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&key_path)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&key_path, perms)?;
    }

    let id = std::env::var("IKEV2_IDENTITY")
        .ok()
        .or_else(|| public_ip.clone())
        .unwrap_or_else(|| "vpnvpn-ikev2".to_string());
    let remote = std::env::var("IKEV2_REMOTE")
        .ok()
        .or_else(|| public_ip.clone())
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let pool_v4 = std::env::var("IKEV2_POOL_V4").unwrap_or_else(|_| "10.9.0.0/24".to_string());
    let pool_v6 = std::env::var("IKEV2_POOL_V6").unwrap_or_else(|_| "fd42:42:42::/64".to_string());
    let ike_port = std::env::var("IKEV2_PORT").unwrap_or_else(|_| "500".to_string());

    let ipsec_conf = format!(
        r#"
config setup
    charondebug="ike 1, cfg 1"

# EAP-MSCHAPv2 (default — username/password authentication)
conn ikev2-eap
    keyexchange=ikev2
    auto=add
    ike=aes256-sha256-modp2048,aes256-sha256-ecp256!
    esp=aes256gcm128!
    left=%any
    leftid={id}
    leftcert=server.pem
    leftsendcert=always
    leftsubnet=0.0.0.0/0,::/0
    leftauth=pubkey
    right=%any
    rightid=%any
    rightauth=eap-mschapv2
    eap_identity=%identity
    rightsourceip={pool_v4},{pool_v6}
    dpdaction=clear
    dpddelay=30s
    fragmentation=yes
    rekey=yes
    mobike=yes

# EAP-TLS connection (certificate-based, for clients with certs)
conn ikev2-eaptls
    keyexchange=ikev2
    auto=add
    ike=aes256-sha256-modp2048,aes256-sha256-ecp256!
    esp=aes256gcm128!
    left=%any
    leftid={id}
    leftcert=server.pem
    leftsendcert=always
    leftsubnet=0.0.0.0/0,::/0
    leftauth=pubkey
    right=%any
    rightid=%any
    rightauth=eap-tls
    rightca="CN=vpnvpn-ca"
    eap_identity=%identity
    rightsourceip={pool_v4},{pool_v6}
    dpdaction=clear
    dpddelay=30s
    fragmentation=yes
    rekey=yes
    mobike=yes
"#,
        id = id,
        pool_v4 = pool_v4,
        pool_v6 = pool_v6
    );

    fs::write("/etc/ipsec.conf", ipsec_conf).context("write ipsec.conf")?;

    let secrets = format!(
        ": ECDSA {}\n",
        key_path
            .to_str()
            .ok_or_else(|| anyhow!("invalid key path"))?
    );
    fs::write("/etc/ipsec.secrets", &secrets).context("write ipsec.secrets")?;
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata("/etc/ipsec.secrets")?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions("/etc/ipsec.secrets", perms)?;
    }

    let stop = Command::new("ipsec").arg("stop").output().ok();
    if let Some(out) = stop {
        if !out.status.success() {
            warn!("ipsec stop returned non-zero");
        }
    }

    let mut start = Command::new("ipsec")
        .args(["start", "--nofork"])
        .spawn()
        .context("spawn ipsec start")?;
    info!("spawned ipsec with pid {}", start.id());

    // `--nofork` means the process stays in the foreground, so a quick exit or a
    // charon that never comes up are both real failures. Previously we assumed the
    // spawn succeeded and returned Ok unconditionally. Poll briefly: the child must
    // still be alive AND `ipsec status` must report charon is reachable.
    verify_ipsec_started(&mut start)?;

    Ok(IkeMetadata {
        remote: format!("{remote}:{}", ike_port),
        ca_pem: ca_pem.to_string(),
        server_fingerprint: server_fingerprint.to_string(),
    })
}

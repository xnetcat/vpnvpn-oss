//! IPC authentication module.
//!
//! Provides authentication mechanisms for daemon-GUI communication:
//! - Code-signing verification (macOS/Windows)
//! - Peer credentials (Linux via SO_PEERCRED)
//! - Nonce challenge-response

use anyhow::Result;
use base64::Engine;
use rand::Rng;
use std::time::{Duration, Instant};
use tracing::{debug, warn};

/// Authentication challenge.
///
/// Retained as part of the auth API surface (and exercised by unit tests); the
/// live handshake currently issues nonces via [`NonceStore`] directly.
#[allow(dead_code)]
pub struct AuthChallenge {
    pub nonce: String,
    pub created_at: Instant,
    pub expires_in: Duration,
}

#[allow(dead_code)]
impl AuthChallenge {
    /// Create a new authentication challenge.
    pub fn new(expires_in: Duration) -> Self {
        let mut nonce_bytes = [0u8; 32];
        rand::thread_rng().fill(&mut nonce_bytes);
        let nonce = base64::engine::general_purpose::STANDARD.encode(nonce_bytes);

        Self {
            nonce,
            created_at: Instant::now(),
            expires_in,
        }
    }

    /// Check if the challenge has expired.
    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() > self.expires_in
    }
}

/// Compile-time expected macOS Team ID, injected via the
/// `VPNVPN_EXPECTED_TEAM_ID` env var at build time (see build.rs in src-tauri /
/// the daemon's own build). In release builds this MUST be set, otherwise any
/// validly-signed (including ad-hoc) process claiming the bundle id would pass.
/// In debug builds it may be absent so a locally ad-hoc-signed GUI still works.
#[cfg(target_os = "macos")]
const EXPECTED_TEAM_ID: Option<&str> = option_env!("VPNVPN_EXPECTED_TEAM_ID");

/// Verify client credentials.
pub struct ClientVerifier {
    /// Expected bundle identifier (macOS).
    #[cfg(target_os = "macos")]
    expected_bundle_id: String,

    /// Expected signing authority (macOS).
    #[cfg(target_os = "macos")]
    expected_team_id: Option<String>,

    /// Allowed user IDs (Linux). Never empty in practice: at minimum it contains
    /// root (uid 0) plus the installing/owning user.
    #[cfg(target_os = "linux")]
    allowed_uids: Vec<u32>,
}

impl Default for ClientVerifier {
    fn default() -> Self {
        Self::new()
    }
}

impl ClientVerifier {
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            expected_bundle_id: "com.vpnvpn.desktop".to_string(),
            // SECURITY: required in release, optional only in debug.
            #[cfg(target_os = "macos")]
            expected_team_id: EXPECTED_TEAM_ID.map(str::to_string),
            // SECURITY: default to the owner-derived allowlist; NEVER allow-all.
            #[cfg(target_os = "linux")]
            allowed_uids: default_allowed_uids(),
        }
    }

    /// Construct a verifier with an explicit Linux UID allowlist (e.g. loaded
    /// from daemon settings). Root (uid 0) is always added. If the supplied list
    /// is empty, falls back to the owner-derived default (socket dir owner +
    /// root) — it is never allow-all.
    #[cfg(target_os = "linux")]
    pub fn with_allowed_uids(mut uids: Vec<u32>) -> Self {
        if uids.is_empty() {
            uids = default_allowed_uids();
        }
        if !uids.contains(&0) {
            uids.push(0);
        }
        Self { allowed_uids: uids }
    }

    /// Construct a verifier with an explicit Team ID expectation (macOS).
    ///
    /// Provided for callers that want to override the compile-time pinned Team
    /// ID (e.g. tests / future runtime config); the default constructor already
    /// applies the pinned `EXPECTED_TEAM_ID`.
    #[cfg(target_os = "macos")]
    #[allow(dead_code)]
    pub fn with_expected_team_id(team_id: Option<String>) -> Self {
        Self {
            expected_bundle_id: "com.vpnvpn.desktop".to_string(),
            expected_team_id: team_id.or_else(|| EXPECTED_TEAM_ID.map(str::to_string)),
        }
    }

    /// Verify a client connection.
    #[cfg(target_os = "macos")]
    pub fn verify_client(&self, pid: i32) -> Result<bool> {
        // Use codesign to verify the connecting process is validly signed and
        // (when configured) matches the expected bundle id / team id.
        verify_code_signature_macos(
            pid,
            &self.expected_bundle_id,
            self.expected_team_id.as_deref(),
        )
    }

    #[cfg(target_os = "linux")]
    pub fn verify_client(&self, uid: u32, _gid: u32, _pid: i32) -> Result<bool> {
        // SECURITY: peer uid must be on the allowlist. We NEVER allow-all: an
        // empty allowlist would let any local user drive the root daemon (LPE),
        // so `allowed_uids` is always populated with at least root + owner.
        let allowed = self.allowed_uids.contains(&uid);
        if allowed {
            debug!("Allowing client with UID {}", uid);
        } else {
            warn!("Rejecting client with UID {} (not in allowed list)", uid);
        }
        Ok(allowed)
    }

    #[cfg(target_os = "windows")]
    pub fn verify_client(&self, process_id: u32) -> Result<bool> {
        // NOTE: unverified on host (Windows-only)
        // Resolve the connecting process' image path and verify its Authenticode
        // signature. Unsigned or untrusted callers are rejected.
        let image_path = match windows_process_image_path(process_id) {
            Ok(p) => p,
            Err(e) => {
                warn!(
                    "Could not resolve image path for pid {}: {} - rejecting",
                    process_id, e
                );
                return Ok(false);
            }
        };
        debug!(
            "Verifying Authenticode signature of {}",
            image_path.display()
        );
        let trusted = verify_authenticode_windows(&image_path)?;
        if !trusted {
            warn!(
                "Process {} ({}) failed Authenticode verification",
                process_id,
                image_path.display()
            );
        }
        Ok(trusted)
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    pub fn verify_client(&self) -> Result<bool> {
        Ok(true)
    }
}

/// Verify the code signature of a connecting process on macOS.
///
/// Steps:
/// 1. `codesign --verify --pid <pid>` confirms the on-disk binary backing the
///    process is validly signed and unmodified.
/// 2. `codesign -dv --pid <pid>` exposes the signing identifiers. We require the
///    bundle identifier to match, and — when an expected team id is configured —
///    the `TeamIdentifier` to match as well.
///
/// In development the GUI may be ad-hoc signed (no team id). In that case we
/// still require a valid signature and matching bundle id, but skip the team-id
/// check (there is nothing to compare against).
#[cfg(target_os = "macos")]
fn verify_code_signature_macos(
    pid: i32,
    expected_bundle_id: &str,
    expected_team_id: Option<&str>,
) -> Result<bool> {
    use std::process::Command;

    // 1. Validate the signature itself.
    let output = Command::new("codesign")
        .args(["--verify", "--pid", &pid.to_string()])
        .output()?;

    if !output.status.success() {
        warn!("Process {} failed code signature verification", pid);
        return Ok(false);
    }

    // 2. Inspect signing identifiers. `codesign -dv` writes to stderr.
    let info_output = Command::new("codesign")
        .args(["-dv", "--pid", &pid.to_string()])
        .output()?;
    let info = String::from_utf8_lossy(&info_output.stderr);
    debug!("Code signing info for PID {}: {}", pid, info);

    // Identifier=<bundle id>
    let bundle_id = info
        .lines()
        .find_map(|l| l.strip_prefix("Identifier="))
        .map(str::trim);
    match bundle_id {
        Some(id) if id == expected_bundle_id => {}
        Some(id) => {
            warn!(
                "Process {} bundle id mismatch: got '{}', expected '{}'",
                pid, id, expected_bundle_id
            );
            return Ok(false);
        }
        None => {
            warn!("Process {} has no readable bundle identifier", pid);
            return Ok(false);
        }
    }

    // TeamIdentifier=<team id> (only enforced when we have an expectation).
    if let Some(expected_team) = expected_team_id {
        let team_id = info
            .lines()
            .find_map(|l| l.strip_prefix("TeamIdentifier="))
            .map(str::trim);
        match team_id {
            Some(t) if t == expected_team => {}
            other => {
                warn!(
                    "Process {} team id mismatch: got {:?}, expected '{}'",
                    pid, other, expected_team
                );
                return Ok(false);
            }
        }
    }

    Ok(true)
}

/// Resolve the full image path of a process by pid on Windows.
///
/// NOTE: unverified on host (Windows-only)
#[cfg(target_os = "windows")]
fn windows_process_image_path(process_id: u32) -> Result<std::path::PathBuf> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // Safety: OpenProcess returns a handle we close below; on failure it
    // returns an error which we propagate.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }
        .map_err(|e| anyhow::anyhow!("OpenProcess failed: {}", e))?;

    let mut buf = vec![0u16; 32768];
    let mut size = buf.len() as u32;

    // Safety: handle is valid; buf/size describe the output buffer.
    let result = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
    };

    // Always close the handle regardless of the query outcome.
    // Safety: handle was returned by OpenProcess and not yet closed.
    let _ = unsafe { CloseHandle(handle) };

    result.map_err(|e| anyhow::anyhow!("QueryFullProcessImageNameW failed: {}", e))?;

    let path = String::from_utf16_lossy(&buf[..size as usize]);
    Ok(std::path::PathBuf::from(path))
}

/// Verify the Authenticode signature of a file on disk (public wrapper).
///
/// Used when staging daemon updates to ensure the incoming binary is signed and
/// trusted before it replaces the running daemon.
///
/// NOTE: unverified on host (Windows-only)
#[cfg(target_os = "windows")]
pub fn verify_file_authenticode(path: &std::path::Path) -> Result<bool> {
    verify_authenticode_windows(path)
}

/// Verify an Authenticode signature on a file via WinVerifyTrust.
///
/// Returns `Ok(true)` only when the file carries a valid, trusted Authenticode
/// signature chaining to a trusted root. Unsigned files and files with broken
/// or untrusted signatures return `Ok(false)`.
///
/// NOTE: unverified on host (Windows-only)
#[cfg(target_os = "windows")]
fn verify_authenticode_windows(path: &std::path::Path) -> Result<bool> {
    use std::process::Command;

    // Verify the Authenticode signature via PowerShell's Get-AuthenticodeSignature.
    // A trusted, unmodified binary reports Status == "Valid"; unsigned or tampered
    // binaries report another status (e.g. NotSigned, HashMismatch, UnknownError).
    // This performs the same trust-chain check as WinVerifyTrust without the
    // brittle FFI surface (WINTRUST_DATA et al.).
    //
    // SECURITY: `path` is the image path of a *connecting* process, so it must be
    // treated as untrusted. It is passed via an environment variable and read with
    // `$env:...` — PowerShell evaluates env-var values as data, never as code — so
    // a crafted path (including PowerShell "smart-quote" U+2018/U+2019 breakouts)
    // cannot inject commands into this privileged daemon.
    let output = match Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-AuthenticodeSignature -LiteralPath $env:VPNVPN_AUTHENTICODE_PATH).Status",
        ])
        .env("VPNVPN_AUTHENTICODE_PATH", path)
        .output()
    {
        Ok(o) => o,
        Err(e) => {
            warn!("failed to run Get-AuthenticodeSignature: {e}");
            return Ok(false);
        }
    };

    let status = String::from_utf8_lossy(&output.stdout);
    let trusted = output.status.success() && status.trim().eq_ignore_ascii_case("Valid");
    if !trusted {
        debug!(
            "Authenticode verification failed for {}: status={}",
            path.display(),
            status.trim()
        );
    }
    Ok(trusted)
}

/// Compute the default Linux UID allowlist when no explicit list is configured.
///
/// SECURITY: this is the fallback that replaces the old (insecure) allow-all
/// behaviour. It authorizes:
/// - root (uid 0): the daemon itself / admin tooling, and
/// - the user who owns the socket's parent directory (the installing user),
///   derived from `SUDO_UID` (set when the daemon was started via sudo) or the
///   directory owner of the socket path's parent.
///
/// It is never empty and never allow-all.
#[cfg(target_os = "linux")]
pub fn default_allowed_uids() -> Vec<u32> {
    let mut uids = vec![0u32]; // root is always allowed

    // 1. Prefer SUDO_UID (the user who launched the daemon via sudo).
    if let Ok(sudo_uid) = std::env::var("SUDO_UID") {
        if let Ok(uid) = sudo_uid.trim().parse::<u32>() {
            if !uids.contains(&uid) {
                uids.push(uid);
            }
        }
    }

    // 2. Otherwise (and additionally) trust the owner of the socket's parent
    //    directory — the user who installed/owns the daemon's runtime dir.
    let socket_path = crate::get_socket_path();
    if let Some(parent) = std::path::Path::new(&socket_path).parent() {
        if let Ok(meta) = std::fs::metadata(parent) {
            use std::os::unix::fs::MetadataExt;
            let owner = meta.uid();
            if !uids.contains(&owner) {
                uids.push(owner);
            }
        }
    }

    debug!("Default allowed UIDs: {:?}", uids);
    uids
}

/// Get peer credentials from a Unix socket.
#[cfg(target_os = "linux")]
pub fn get_peer_credentials(fd: std::os::unix::io::RawFd) -> Result<(u32, u32, i32)> {
    use nix::sys::socket::{getsockopt, sockopt::PeerCredentials};
    use std::os::fd::BorrowedFd;

    // Safety: fd is a valid file descriptor from an accepted socket
    let borrowed_fd = unsafe { BorrowedFd::borrow_raw(fd) };
    let creds = getsockopt(&borrowed_fd, PeerCredentials)?;
    Ok((creds.uid(), creds.gid(), creds.pid()))
}

/// Get peer credentials from a Unix socket on macOS.
///
/// macOS does not expose `SO_PEERCRED`. Instead it provides:
/// - `LOCAL_PEERCRED` (SOL_LOCAL) returning a `xucred` with the peer uid/gids.
/// - `LOCAL_PEERPID` (SOL_LOCAL) returning the peer process id.
///
/// Returns `(uid, gid, pid)` for the connected peer.
#[cfg(target_os = "macos")]
pub fn get_peer_credentials(fd: std::os::unix::io::RawFd) -> Result<(u32, u32, i32)> {
    use std::mem;

    // LOCAL_PEERCRED -> xucred (uid + groups)
    let mut cred: libc::xucred = unsafe { mem::zeroed() };
    let mut cred_len = mem::size_of::<libc::xucred>() as libc::socklen_t;

    // Safety: `fd` is a valid descriptor from an accepted socket; the buffer and
    // length match the option being queried.
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERCRED,
            &mut cred as *mut libc::xucred as *mut libc::c_void,
            &mut cred_len,
        )
    };
    if rc != 0 {
        return Err(anyhow::anyhow!(
            "LOCAL_PEERCRED failed: {}",
            std::io::Error::last_os_error()
        ));
    }

    if cred.cr_version != libc::XUCRED_VERSION {
        warn!(
            "Unexpected xucred version {} (expected {})",
            cred.cr_version,
            libc::XUCRED_VERSION
        );
    }

    let uid = cred.cr_uid;
    // The primary group is the first entry of cr_groups when present.
    let gid = if cred.cr_ngroups > 0 {
        cred.cr_groups[0]
    } else {
        0
    };

    // LOCAL_PEERPID -> pid
    let mut pid: libc::pid_t = 0;
    let mut pid_len = mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // Safety: as above; querying the peer pid into a pid_t-sized buffer.
    let pid_rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            &mut pid as *mut libc::pid_t as *mut libc::c_void,
            &mut pid_len,
        )
    };
    if pid_rc != 0 {
        // PID lookup is best-effort; uid/gid are the security-relevant fields.
        debug!("LOCAL_PEERPID failed: {}", std::io::Error::last_os_error());
        pid = 0;
    }

    debug!(
        "macOS peer credentials: uid={}, gid={}, pid={}",
        uid, gid, pid
    );
    Ok((uid, gid, pid as i32))
}

/// Nonce store for challenge-response authentication.
pub struct NonceStore {
    /// Active nonces with their creation time.
    nonces: std::collections::HashMap<String, Instant>,
    /// Maximum age of a nonce.
    max_age: Duration,
    /// Maximum number of active nonces.
    max_nonces: usize,
}

impl NonceStore {
    pub fn new(max_age: Duration, max_nonces: usize) -> Self {
        Self {
            nonces: std::collections::HashMap::new(),
            max_age,
            max_nonces,
        }
    }

    /// Maximum age of an issued nonce.
    pub fn max_age(&self) -> Duration {
        self.max_age
    }

    /// Generate and store a new nonce.
    pub fn generate(&mut self) -> String {
        // Clean up expired nonces first
        self.cleanup();

        // Generate new nonce
        let mut nonce_bytes = [0u8; 16];
        rand::thread_rng().fill(&mut nonce_bytes);
        let nonce = base64::engine::general_purpose::STANDARD.encode(nonce_bytes);

        // Store nonce
        self.nonces.insert(nonce.clone(), Instant::now());

        nonce
    }

    /// Validate and consume a nonce.
    pub fn validate(&mut self, nonce: &str) -> bool {
        if let Some(created_at) = self.nonces.remove(nonce) {
            if created_at.elapsed() <= self.max_age {
                return true;
            }
        }
        false
    }

    /// Clean up expired nonces.
    fn cleanup(&mut self) {
        let max_age = self.max_age;
        self.nonces
            .retain(|_, created_at| created_at.elapsed() <= max_age);

        // If still too many, remove oldest
        while self.nonces.len() >= self.max_nonces {
            if let Some(oldest_key) = self
                .nonces
                .iter()
                .min_by_key(|(_, created_at)| *created_at)
                .map(|(k, _)| k.clone())
            {
                self.nonces.remove(&oldest_key);
            } else {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_nonce_store() {
        let mut store = NonceStore::new(Duration::from_secs(60), 10);

        let nonce = store.generate();
        assert!(!nonce.is_empty());

        // First validation should succeed
        assert!(store.validate(&nonce));

        // Second validation should fail (nonce consumed)
        assert!(!store.validate(&nonce));
    }

    #[test]
    fn test_auth_challenge() {
        let challenge = AuthChallenge::new(Duration::from_secs(60));
        assert!(!challenge.nonce.is_empty());
        assert!(!challenge.is_expired());
    }

    #[test]
    fn test_nonce_store_max_age() {
        let store = NonceStore::new(Duration::from_secs(42), 10);
        assert_eq!(store.max_age(), Duration::from_secs(42));
    }

    #[test]
    fn test_expired_nonce_is_invalid() {
        // A nonce older than max_age must not validate.
        let mut store = NonceStore::new(Duration::from_millis(1), 10);
        let nonce = store.generate();
        std::thread::sleep(Duration::from_millis(5));
        assert!(!store.validate(&nonce));
    }

    #[test]
    fn test_distinct_nonces() {
        let mut store = NonceStore::new(Duration::from_secs(60), 10);
        let a = store.generate();
        let b = store.generate();
        assert_ne!(a, b, "generated nonces must be unique");
    }

    /// SECURITY: a disallowed uid must be rejected; an allowed uid passes; root
    /// is always allowed. There is no allow-all path.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_uid_allowlist_is_enforced() {
        let verifier = ClientVerifier::with_allowed_uids(vec![1000]);
        // Allowed user passes.
        assert!(verifier.verify_client(1000, 1000, 1234).unwrap());
        // Root is always allowed (added automatically).
        assert!(verifier.verify_client(0, 0, 1).unwrap());
        // A different (disallowed) uid is rejected.
        assert!(!verifier.verify_client(31337, 31337, 4242).unwrap());
    }

    /// An empty allowlist must NOT mean allow-all: it falls back to the
    /// owner-derived default which still excludes arbitrary uids.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_empty_allowlist_is_not_allow_all() {
        let verifier = ClientVerifier::with_allowed_uids(vec![]);
        // root is always present.
        assert!(verifier.verify_client(0, 0, 1).unwrap());
        // A high, unlikely-to-be-owner uid is rejected (proves it's not allow-all).
        assert!(!verifier.verify_client(4_000_000_000, 0, 1).unwrap());
    }

    /// In release builds a Team ID must be present (None only allowed in debug).
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_team_id_required_in_release() {
        let verifier = ClientVerifier::new();
        if cfg!(debug_assertions) {
            // Debug: team id may be None (ad-hoc dev signing).
        } else {
            assert!(
                verifier.expected_team_id.is_some(),
                "release builds must pin an expected Team ID"
            );
        }
    }
}

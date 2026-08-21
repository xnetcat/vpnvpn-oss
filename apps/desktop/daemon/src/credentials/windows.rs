//! Windows Credential Manager storage.
//!
//! Uses the Win32 Credential Management API (`CredWriteW` / `CredReadW` /
//! `CredDeleteW`) directly so that store/get/delete round-trip correctly.
//!
//! The previous implementation shelled out to `cmdkey` (which never returns the
//! stored secret) and to a non-built-in PowerShell cmdlet (`Get-StoredCredential`),
//! so reads always returned `None`. The API approach below stores the secret in
//! the `CredentialBlob` and reads it straight back.
//!
//! NOTE: unverified on host (Windows-only). Gated with `#[cfg(windows)]` and
//! checked in CI via `cargo check --target x86_64-pc-windows-msvc`.
#![cfg(windows)]

use anyhow::{anyhow, Result};
use windows::core::PWSTR;
use windows::Win32::Foundation::{ERROR_NOT_FOUND, FILETIME};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

/// Build the credential target name from service + key.
fn target_name(service: &str, key: &str) -> String {
    format!("{service}:{key}")
}

/// Encode a Rust string as a NUL-terminated UTF-16 buffer for Win32 wide APIs.
fn to_wide_nul(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Store a credential in Windows Credential Manager.
pub fn store(service: &str, key: &str, value: &str) -> Result<()> {
    let target = target_name(service, key);
    let mut target_w = to_wide_nul(&target);
    let mut user_w = to_wide_nul(key);

    // The secret is stored as the credential blob (UTF-16, no NUL terminator —
    // the length is carried explicitly in CredentialBlobSize).
    let blob: Vec<u16> = value.encode_utf16().collect();
    let blob_bytes = blob.len() * std::mem::size_of::<u16>();

    // Not `mut`: CredWriteW takes *const CREDENTIALW and nothing mutates this.
    let cred = CREDENTIALW {
        Flags: Default::default(),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target_w.as_mut_ptr()),
        Comment: PWSTR::null(),
        LastWritten: FILETIME::default(),
        CredentialBlobSize: blob_bytes as u32,
        CredentialBlob: blob.as_ptr() as *mut u8,
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: PWSTR::null(),
        UserName: PWSTR(user_w.as_mut_ptr()),
    };

    // Safety: `cred` and all pointers within it remain valid for the duration of
    // the call (the backing Vecs outlive it). CredWriteW copies the data.
    unsafe { CredWriteW(&cred, 0) }.map_err(|e| anyhow!("CredWriteW failed: {e}"))?;

    Ok(())
}

/// Get a credential from Windows Credential Manager.
///
/// Returns `Ok(None)` when no credential exists for the target, `Ok(Some(..))`
/// with the decoded secret otherwise.
pub fn get(service: &str, key: &str) -> Result<Option<String>> {
    let target = target_name(service, key);
    let target_w = to_wide_nul(&target);

    let mut pcred: *mut CREDENTIALW = std::ptr::null_mut();

    // Safety: target_w is a valid NUL-terminated wide string; pcred receives an
    // allocation we free with CredFree below.
    let result = unsafe {
        CredReadW(
            PWSTR(target_w.as_ptr() as *mut u16),
            CRED_TYPE_GENERIC,
            None,
            &mut pcred,
        )
    };

    if let Err(e) = result {
        if e.code() == ERROR_NOT_FOUND.to_hresult() {
            return Ok(None);
        }
        return Err(anyhow!("CredReadW failed: {e}"));
    }

    if pcred.is_null() {
        return Ok(None);
    }

    // Safety: pcred is a valid CREDENTIALW returned by CredReadW.
    let value = unsafe {
        let cred = &*pcred;
        let size = cred.CredentialBlobSize as usize;
        let out = if size == 0 || cred.CredentialBlob.is_null() {
            String::new()
        } else {
            // Blob is UTF-16; reinterpret the byte buffer as u16.
            let count = size / std::mem::size_of::<u16>();
            let slice = std::slice::from_raw_parts(cred.CredentialBlob as *const u16, count);
            String::from_utf16_lossy(slice)
        };
        CredFree(pcred as *const _ as *mut _);
        out
    };

    Ok(Some(value))
}

/// Delete a credential from Windows Credential Manager.
///
/// Treats "not found" as success so deletes are idempotent.
pub fn delete(service: &str, key: &str) -> Result<()> {
    let target = target_name(service, key);
    let target_w = to_wide_nul(&target);

    // Safety: target_w is a valid NUL-terminated wide string.
    let result = unsafe {
        CredDeleteW(
            PWSTR(target_w.as_ptr() as *mut u16),
            CRED_TYPE_GENERIC,
            None,
        )
    };

    if let Err(e) = result {
        if e.code() == ERROR_NOT_FOUND.to_hresult() {
            return Ok(());
        }
        return Err(anyhow!("CredDeleteW failed: {e}"));
    }

    Ok(())
}

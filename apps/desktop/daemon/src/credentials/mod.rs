//! Secure credential storage using OS-native mechanisms.
//!
//! - macOS: Keychain Services
//! - Windows: Credential Manager
//! - Linux: libsecret (GNOME Keyring / KWallet)

use anyhow::Result;

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
mod linux;

const SERVICE_NAME: &str = "com.vpnvpn.daemon";

/// Store a credential securely.
pub fn store(key: &str, value: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    return macos::store(SERVICE_NAME, key, value);

    #[cfg(target_os = "windows")]
    return windows::store(SERVICE_NAME, key, value);

    #[cfg(target_os = "linux")]
    return linux::store(SERVICE_NAME, key, value);

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (key, value);
        Err(anyhow::anyhow!(
            "Credential storage not supported on this platform"
        ))
    }
}

/// Retrieve a credential.
pub fn get(key: &str) -> Result<Option<String>> {
    #[cfg(target_os = "macos")]
    return macos::get(SERVICE_NAME, key);

    #[cfg(target_os = "windows")]
    return windows::get(SERVICE_NAME, key);

    #[cfg(target_os = "linux")]
    return linux::get(SERVICE_NAME, key);

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = key;
        Err(anyhow::anyhow!(
            "Credential storage not supported on this platform"
        ))
    }
}

/// Delete a credential.
pub fn delete(key: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    return macos::delete(SERVICE_NAME, key);

    #[cfg(target_os = "windows")]
    return windows::delete(SERVICE_NAME, key);

    #[cfg(target_os = "linux")]
    return linux::delete(SERVICE_NAME, key);

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = key;
        Err(anyhow::anyhow!(
            "Credential storage not supported on this platform"
        ))
    }
}

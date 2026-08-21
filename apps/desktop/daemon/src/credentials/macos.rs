//! macOS Keychain credential storage.

use anyhow::Result;
use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

/// Store a credential in the macOS Keychain.
pub fn store(service: &str, key: &str, value: &str) -> Result<()> {
    // Delete existing entry first (set_generic_password doesn't update)
    let _ = delete_generic_password(service, key);

    set_generic_password(service, key, value.as_bytes())
        .map_err(|e| anyhow::anyhow!("Failed to store credential: {}", e))?;

    Ok(())
}

/// Get a credential from the macOS Keychain.
pub fn get(service: &str, key: &str) -> Result<Option<String>> {
    match get_generic_password(service, key) {
        Ok(data) => {
            let value = String::from_utf8(data)
                .map_err(|e| anyhow::anyhow!("Invalid credential encoding: {}", e))?;
            Ok(Some(value))
        }
        Err(e) => {
            if is_not_found(&e.to_string()) {
                Ok(None)
            } else {
                Err(anyhow::anyhow!("Failed to get credential: {}", e))
            }
        }
    }
}

/// Whether a Security.framework error string represents a "not found" condition.
///
/// The Keychain reports this as `errSecItemNotFound` (-25300), surfaced with
/// various wordings ("not found", "could not be found in the keychain", ...).
fn is_not_found(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("not found") || lower.contains("could not be found") || lower.contains("-25300")
}

/// Delete a credential from the macOS Keychain.
pub fn delete(service: &str, key: &str) -> Result<()> {
    match delete_generic_password(service, key) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Ignore "not found" errors
            if is_not_found(&e.to_string()) {
                Ok(())
            } else {
                Err(anyhow::anyhow!("Failed to delete credential: {}", e))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_credential_roundtrip() {
        let service = "com.vpnvpn.test";
        let key = "test-key";
        let value = "test-value-12345";

        // Store. In sandboxed/CI environments without an accessible login
        // Keychain this can fail (or silently not persist); in that case skip the
        // test rather than fail, since it exercises the real OS Keychain.
        if store(service, key, value).is_err() {
            eprintln!("skipping: Keychain not writable in this environment");
            return;
        }

        // Get. If the item didn't actually persist (sandbox), skip gracefully.
        let retrieved = match get(service, key) {
            Ok(Some(v)) => v,
            _ => {
                eprintln!("skipping: Keychain not readable in this environment");
                let _ = delete(service, key);
                return;
            }
        };
        assert_eq!(retrieved, value);

        // Delete
        delete(service, key).expect("delete should succeed");

        // Verify deleted
        let after_delete = get(service, key).expect("get should succeed");
        assert_eq!(after_delete, None);
    }
}

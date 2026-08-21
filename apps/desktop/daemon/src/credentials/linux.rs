//! Linux credential storage using secret-tool (libsecret).

use anyhow::Result;

/// Store a credential using secret-tool.
pub fn store(service: &str, key: &str, value: &str) -> Result<()> {
    // Use secret-tool to store in GNOME Keyring / KWallet
    let mut child = std::process::Command::new("secret-tool")
        .args([
            "store",
            "--label",
            &format!("vpnVPN: {}", key),
            "service",
            service,
            "key",
            key,
        ])
        .stdin(std::process::Stdio::piped())
        .spawn()?;

    if let Some(stdin) = child.stdin.as_mut() {
        use std::io::Write;
        stdin.write_all(value.as_bytes())?;
    }

    let status = child.wait()?;
    if !status.success() {
        return Err(anyhow::anyhow!("secret-tool store failed"));
    }

    Ok(())
}

/// Get a credential using secret-tool.
pub fn get(service: &str, key: &str) -> Result<Option<String>> {
    let output = std::process::Command::new("secret-tool")
        .args(["lookup", "service", service, "key", key])
        .output()?;

    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            Ok(None)
        } else {
            Ok(Some(value))
        }
    } else {
        // Not found or error
        Ok(None)
    }
}

/// Delete a credential using secret-tool.
pub fn delete(service: &str, key: &str) -> Result<()> {
    let _ = std::process::Command::new("secret-tool")
        .args(["clear", "service", service, "key", key])
        .output();

    Ok(())
}

//! Internet connectivity checking.

use tokio::time::{timeout, Duration};
use tracing::{debug, warn};

/// Check if internet connectivity is available.
/// Uses hybrid method: tries ICMP ping first, falls back to DNS lookup if ping fails.
/// Returns `true` if internet is available, `false` otherwise.
pub async fn check_internet_connectivity() -> bool {
    // Try ping first (faster, more reliable)
    if check_ping().await {
        debug!("Internet connectivity confirmed via ping");
        return true;
    }

    debug!("Ping check failed, trying DNS lookup...");

    // Fallback to DNS lookup
    if check_dns().await {
        debug!("Internet connectivity confirmed via DNS lookup");
        return true;
    }

    warn!("Internet connectivity check failed (both ping and DNS failed)");
    false
}

/// Check internet connectivity via ICMP ping.
/// Tries both 8.8.8.8 (Google DNS) and 1.1.1.1 (Cloudflare DNS).
async fn check_ping() -> bool {
    let ping_targets = ["8.8.8.8", "1.1.1.1"];

    for target in &ping_targets {
        if ping_host(target).await {
            return true;
        }
    }

    false
}

/// Ping a specific host.
/// Note: `ping` CLI flags differ between Unix variants, so we
/// use per-OS implementations to keep timeouts sane.
#[cfg(target_os = "macos")]
async fn ping_host(host: &str) -> bool {
    // macOS `ping`: `-W` is a deadline in seconds.
    let output = timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("ping")
            .args(["-c", "1", "-W", "2", host])
            .output(),
    )
    .await;

    match output {
        Ok(Ok(result)) => result.status.success(),
        Ok(Err(_)) => false,
        Err(_) => false, // Timeout
    }
}

#[cfg(target_os = "linux")]
async fn ping_host(host: &str) -> bool {
    // Many Linux `ping` implementations treat `-W` as milliseconds.
    // Use 2000ms to align with the 2s overall timeout.
    let output = timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("ping")
            .args(["-c", "1", "-W", "2000", host])
            .output(),
    )
    .await;

    match output {
        Ok(Ok(result)) => result.status.success(),
        Ok(Err(_)) => false,
        Err(_) => false, // Timeout
    }
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
async fn ping_host(host: &str) -> bool {
    // Fallback for other Unix-like OSes – keep the original behavior.
    let output = timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("ping")
            .args(["-c", "1", "-W", "2", host])
            .output(),
    )
    .await;

    match output {
        Ok(Ok(result)) => result.status.success(),
        Ok(Err(_)) => false,
        Err(_) => false, // Timeout
    }
}

#[cfg(windows)]
async fn ping_host(host: &str) -> bool {
    let output = timeout(
        Duration::from_secs(2),
        tokio::process::Command::new("ping")
            .args(["-n", "1", "-w", "2000", host])
            .output(),
    )
    .await;

    match output {
        Ok(Ok(result)) => result.status.success(),
        Ok(Err(_)) => false,
        Err(_) => false, // Timeout
    }
}

/// Check internet connectivity via DNS lookup.
/// Tries to resolve google.com.
async fn check_dns() -> bool {
    let dns_targets = ["google.com", "cloudflare.com"];

    for target in &dns_targets {
        if resolve_dns(target).await {
            return true;
        }
    }

    false
}

/// Resolve a DNS hostname.
#[cfg(unix)]
async fn resolve_dns(hostname: &str) -> bool {
    use std::net::ToSocketAddrs;

    // Spawn-blocking requires a 'static lifetime, so clone the hostname
    let hostname_owned = hostname.to_string();

    let result = timeout(
        Duration::from_secs(2),
        tokio::task::spawn_blocking(move || {
            format!("{}:80", hostname_owned).to_socket_addrs().is_ok()
        }),
    )
    .await;

    match result {
        Ok(Ok(resolved)) => resolved,
        _ => false,
    }
}

#[cfg(windows)]
async fn resolve_dns(hostname: &str) -> bool {
    use std::net::ToSocketAddrs;

    // Spawn-blocking requires a 'static lifetime, so clone the hostname
    let hostname_owned = hostname.to_string();

    let result = timeout(
        Duration::from_secs(2),
        tokio::task::spawn_blocking(move || {
            format!("{}:80", hostname_owned).to_socket_addrs().is_ok()
        }),
    )
    .await;

    match result {
        Ok(Ok(resolved)) => resolved,
        _ => false,
    }
}

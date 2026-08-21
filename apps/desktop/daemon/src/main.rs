//! vpnVPN Daemon - Privileged VPN management service.
//!
//! This daemon runs with elevated privileges and manages:
//! - VPN connections (WireGuard, OpenVPN, IKEv2)
//! - Kill-switch and firewall rules
//! - Credential storage
//! - Network routing
//!
//! # Development Mode
//!
//! Run with `--dev` flag to use a user-accessible socket path:
//! ```bash
//! sudo cargo run -- --dev
//! ```
//!
//! For hot reload during development:
//! ```bash
//! sudo cargo watch -x 'run -- --dev'
//! ```

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connectivity;
mod credentials;
mod firewall;
mod ipc;
mod platform;
mod state;
mod tools;
mod update;
mod vpn;

use anyhow::Result;
use clap::Parser;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{error, info, warn};

use state::DaemonState;

/// Daemon version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Command-line arguments for the daemon.
#[derive(Parser, Debug)]
#[command(name = "vpnvpn-daemon")]
#[command(about = "vpnVPN privileged daemon for VPN management")]
#[command(version = VERSION)]
pub struct Args {
    /// Run in development mode with user-accessible socket
    #[arg(long, short)]
    pub dev: bool,

    /// Custom socket path (overrides default)
    #[arg(long)]
    pub socket: Option<String>,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "info")]
    pub log_level: String,
}

/// Global config set from CLI args
pub static DEV_MODE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Get the socket path based on mode
pub fn get_socket_path() -> String {
    if DEV_MODE.load(std::sync::atomic::Ordering::Relaxed) {
        // Dev mode: use /tmp for easy access without root
        "/tmp/vpnvpn-daemon.sock".to_string()
    } else {
        // Production: use /var/run (requires root)
        "/var/run/vpnvpn-daemon.sock".to_string()
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Set dev mode flag
    DEV_MODE.store(args.dev, std::sync::atomic::Ordering::Relaxed);

    // Initialize logging with specified level
    init_logging(&args.log_level);

    if args.dev {
        warn!("===========================================");
        warn!("  RUNNING IN DEVELOPMENT MODE");
        warn!("  Socket: {}", get_socket_path());
        warn!("  Hot reload: sudo cargo watch -x 'run -- --dev'");
        warn!("===========================================");
    }

    info!("vpnVPN Daemon v{} starting...", VERSION);

    // Apply any update staged by a previous `PrepareUpdate` before doing anything
    // else. If a staged binary was swapped in, re-exec from the updated path so we
    // run the new code (the current process still has the old binary in memory).
    if !args.dev {
        if let Err(e) = apply_staged_update_and_reexec() {
            warn!("Failed to apply staged daemon update: {}", e);
        }
    }

    // Platform-specific initialization
    #[cfg(target_os = "macos")]
    platform::macos::init()?;

    #[cfg(target_os = "windows")]
    platform::windows::init()?;

    #[cfg(target_os = "linux")]
    platform::linux::init()?;

    // Load configuration. `mut` is required on Linux (we may record allowed
    // UIDs below); on other platforms the binding is not mutated.
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut config: vpnvpn_shared::config::DaemonSettings =
        vpnvpn_shared::config::config_file("daemon.json")
            .and_then(|path| {
                if path.exists() {
                    std::fs::read_to_string(&path)
                        .ok()
                        .and_then(|s| serde_json::from_str(&s).ok())
                } else {
                    None
                }
            })
            .unwrap_or_default();

    // SECURITY (Linux): on first run record the authorized UID(s) so the IPC
    // socket only accepts the installing user (and root). If none are configured
    // yet, derive them from SUDO_UID / the socket dir owner and persist them.
    #[cfg(target_os = "linux")]
    {
        if config.allowed_uids.is_empty() {
            config.allowed_uids = crate::ipc::auth::default_allowed_uids();
            info!("Recorded authorized UIDs: {:?}", config.allowed_uids);
            if let Some(path) = vpnvpn_shared::config::config_file("daemon.json") {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                if let Ok(json) = serde_json::to_string_pretty(&config) {
                    if let Err(e) = std::fs::write(&path, json) {
                        warn!("Failed to persist authorized UIDs: {}", e);
                    }
                }
            }
        }
    }

    // Create daemon state
    let state = Arc::new(RwLock::new(DaemonState::new(config)));

    // Start IPC server
    let ipc_handle = {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(e) = ipc::server::run(state).await {
                error!("IPC server error: {}", e);
            }
        })
    };

    // Start internet connectivity monitoring task
    let monitor_state = Arc::clone(&state);
    tokio::spawn(async move {
        monitor_connectivity(monitor_state).await;
    });

    // Set up signal handlers for graceful shutdown
    let shutdown_state = Arc::clone(&state);
    tokio::spawn(async move {
        if let Err(e) = wait_for_shutdown().await {
            error!("Shutdown signal error: {}", e);
        }

        info!("Shutdown signal received, cleaning up...");

        // Cleanup
        let mut state = shutdown_state.write().await;
        if let Err(e) = state.cleanup().await {
            error!("Cleanup error: {}", e);
        }
    });

    // Wait for IPC server to finish
    ipc_handle.await?;

    info!("vpnVPN Daemon stopped");
    Ok(())
}

/// Apply a previously staged daemon update (from `PrepareUpdate`) and, if one was
/// applied, re-exec the daemon from the now-updated binary so the new code runs.
///
/// The running process still holds the old binary in memory, so after swapping
/// the on-disk binary we must `exec` the updated path. A marker env var guards
/// against an infinite re-exec loop if something goes wrong.
fn apply_staged_update_and_reexec() -> Result<()> {
    const REEXEC_GUARD: &str = "VPNVPN_DAEMON_UPDATED";

    let manager = match update::UpdateManager::new() {
        Ok(m) => m,
        Err(e) => {
            // Unsupported platform / unknown paths: nothing to apply.
            tracing::debug!("Update manager unavailable: {}", e);
            return Ok(());
        }
    };

    // Nothing staged -> nothing to do.
    if manager.staged_path().is_none() {
        return Ok(());
    }

    // Avoid re-applying/looping if we already re-exec'd once for this update.
    if std::env::var(REEXEC_GUARD).is_ok() {
        info!("Staged update already applied this launch; skipping re-exec");
        manager.cleanup();
        return Ok(());
    }

    info!("Applying staged daemon update");
    manager.apply_update()?;

    // Re-exec from the updated current binary path so the new code takes over.
    let current = std::env::current_exe()?;
    let args: Vec<String> = std::env::args().skip(1).collect();

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let err = std::process::Command::new(&current)
            .args(&args)
            .env(REEXEC_GUARD, "1")
            .exec();
        // exec only returns on error.
        Err(anyhow::anyhow!("re-exec after update failed: {}", err))
    }

    #[cfg(not(unix))]
    {
        // On Windows we cannot exec-in-place; spawn the updated binary and exit so
        // the service manager tracks the new process.
        std::process::Command::new(&current)
            .args(&args)
            .env(REEXEC_GUARD, "1")
            .spawn()?;
        std::process::exit(0);
    }
}

fn init_logging(level: &str) {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    // Use RUST_LOG env var if set, otherwise use CLI argument
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(level));

    let registry = tracing_subscriber::registry()
        .with(
            fmt::layer()
                .with_target(true)
                .with_thread_ids(true)
                .with_ansi(true),
        ) // Enable colors in terminal
        .with(filter);

    // On Windows the daemon runs as a service without an attached console, so
    // stdout is discarded. Additionally tee logs to a file the GUI can read.
    //
    // NOTE: unverified on host (Windows-only)
    #[cfg(target_os = "windows")]
    {
        if let Some(file) = open_windows_log_file() {
            registry
                .with(
                    fmt::layer()
                        .with_target(true)
                        .with_thread_ids(true)
                        .with_ansi(false)
                        .with_writer(std::sync::Mutex::new(file)),
                )
                .init();
            return;
        }
    }

    registry.init();
}

/// Open (creating/appending) the Windows daemon log file.
///
/// Path: `%ProgramData%\vpnvpn\daemon.log`, matching what the GUI reads.
///
/// NOTE: unverified on host (Windows-only)
#[cfg(target_os = "windows")]
fn open_windows_log_file() -> Option<std::fs::File> {
    let program_data =
        std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
    let dir = format!(r"{}\vpnvpn", program_data);
    let _ = std::fs::create_dir_all(&dir);
    let path = format!(r"{}\daemon.log", dir);
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}

async fn wait_for_shutdown() -> Result<()> {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        let mut sigterm = signal(SignalKind::terminate())?;
        let mut sigint = signal(SignalKind::interrupt())?;

        tokio::select! {
            _ = sigterm.recv() => {
                info!("Received SIGTERM");
            }
            _ = sigint.recv() => {
                info!("Received SIGINT");
            }
        }
    }

    #[cfg(windows)]
    {
        tokio::signal::ctrl_c().await?;
        info!("Received Ctrl+C");
    }

    Ok(())
}

/// Monitor internet connectivity and auto-disconnect VPN if internet is lost.
async fn monitor_connectivity(state: Arc<RwLock<DaemonState>>) {
    use tokio::time::{interval, Duration};
    use vpnvpn_shared::protocol::ConnectionState;

    info!("Internet connectivity monitor started (checking every 5 seconds)");

    let mut interval = interval(Duration::from_secs(5));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        interval.tick().await;

        // Check if VPN is actually connected by checking both daemon state and actual interface
        let (is_connected_daemon, protocol, interface_name) = {
            let state = state.read().await;
            (
                state.connection.state == ConnectionState::Connected,
                state.connection.protocol,
                state.connection.interface_name.clone(),
            )
        };

        // Also check actual VPN interface status (in case daemon state is stale)
        let is_connected_actual = if let Some(protocol) = protocol {
            match protocol {
                vpnvpn_shared::Protocol::WireGuard => {
                    // Check if WireGuard interface exists and is up
                    if let Ok(status) = crate::vpn::wireguard::check_status().await {
                        status.state == ConnectionState::Connected
                    } else {
                        false
                    }
                }
                vpnvpn_shared::Protocol::OpenVPN => {
                    // Check if OpenVPN process is running
                    if let Ok(status) = crate::vpn::openvpn::check_status().await {
                        status.state == ConnectionState::Connected
                    } else {
                        false
                    }
                }
                vpnvpn_shared::Protocol::IKEv2 => {
                    // For IKEv2, rely on daemon state only
                    is_connected_daemon
                }
            }
        } else {
            false
        };

        // Unexpected tunnel drop: the daemon believes it's connected, but the
        // actual interface is gone while the network path is otherwise fine. If
        // auto-reconnect is enabled (and this wasn't a user disconnect), try to
        // re-establish the last config with backoff.
        if is_connected_daemon && !is_connected_actual {
            let (auto_reconnect, user_disconnected) = {
                let s = state.read().await;
                (s.settings.auto_reconnect, s.user_disconnected)
            };
            if auto_reconnect && !user_disconnected {
                warn!(
                    "Tunnel dropped unexpectedly (interface: {:?}); attempting auto-reconnect",
                    interface_name
                );
                {
                    let mut s = state.write().await;
                    s.connection.state = ConnectionState::Reconnecting;
                }
                match crate::ipc::handler::try_auto_reconnect(state.clone()).await {
                    Ok(true) => info!("Auto-reconnect restored the tunnel"),
                    Ok(false) => {
                        // Gave up / disabled: settle to disconnected.
                        let mut s = state.write().await;
                        s.connection = vpnvpn_shared::ConnectionStatus::default();
                    }
                    Err(e) => error!("Auto-reconnect error: {}", e),
                }
                continue;
            }
        }

        // VPN is considered connected if either daemon says so OR interface is actually up
        let is_connected = is_connected_daemon || is_connected_actual;

        if !is_connected {
            // VPN not connected, skip check
            continue;
        }

        // VPN is connected, check internet connectivity
        let has_internet = connectivity::check_internet_connectivity().await;

        if !has_internet {
            // VPN connected but internet lost - auto-disconnect
            warn!(
                "VPN connected (interface: {:?}) but internet connection lost - auto-disconnecting",
                interface_name
            );

            if let Err(e) = crate::ipc::handler::auto_disconnect_vpn(state.clone()).await {
                error!("Failed to auto-disconnect VPN: {}", e);
            }
        }
    }
}

use axum::{routing::get, Router};
use clap::{Args, Parser, Subcommand};
use std::{env, net::SocketAddr};
use tokio::net::TcpListener;
use tokio::signal;
use tracing::{error, info, warn};

mod client;
mod ikev2;
mod logging;
mod metrics;
mod net;
mod pki;
mod vpn;

#[derive(Parser, Debug, Clone)]
#[command(author, version, about, long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug, Clone)]
enum Command {
    /// Run the VPN node agent (default mode).
    Run(RunArgs),
    /// Check prerequisites and environment without starting the server.
    Doctor,
}

#[derive(Args, Debug, Clone)]
struct RunArgs {
    /// Control Plane API URL
    #[arg(long, env = "API_URL")]
    api_url: String,

    /// Authentication Token for Control Plane
    #[arg(long, env = "VPN_TOKEN")]
    token: String,

    /// Port for the VPN server to listen on (UDP)
    #[arg(long, env = "LISTEN_UDP_PORT", default_value_t = 51820)]
    listen_port: u16,

    /// Admin API port
    #[arg(long, env = "ADMIN_PORT", default_value_t = 8080)]
    admin_port: u16,

    /// Optional static peer public key for local/docker tests
    #[arg(long, env = "STATIC_PEER_PUBLIC_KEY")]
    static_peer_public_key: Option<String>,

    /// Optional static peer allowed IPs (comma-separated, e.g. 10.8.0.2/32,10.8.0.3/32)
    #[arg(long, env = "STATIC_PEER_ALLOWED_IPS")]
    static_peer_allowed_ips: Option<String>,

    /// Optional static peer endpoint (host:port) for local/docker tests
    #[arg(long, env = "STATIC_PEER_ENDPOINT")]
    static_peer_endpoint: Option<String>,
}

#[tokio::main]
async fn main() {
    let log_buffer = logging::init_logging();
    let cli = Cli::parse();

    match cli.command {
        Command::Run(args) => {
            if let Err(code) = run_server(args, log_buffer).await {
                std::process::exit(code);
            }
        }
        Command::Doctor => {
            let ok = run_doctor();
            std::process::exit(if ok { 0 } else { 1 });
        }
    }
}

/// Constant-time byte-slice equality for secret comparison (admin token).
///
/// A naive `==` short-circuits on the first differing byte, leaking the length
/// of the matching prefix through timing. `subtle::ConstantTimeEq` compares in
/// constant time for equal-length inputs; we first fold in a length check so the
/// result is `false` for mismatched lengths without an early data-dependent
/// return. (The length itself is not secret-dependent here.)
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}

/// Capped exponential backoff for the peer-sync loop.
///
/// Given the number of `consecutive_failures` (>= 1), returns the next sleep in
/// seconds: `base * 2^(failures-1)`, saturated at `max`. e.g. base=2,max=60 ->
/// 2, 4, 8, 16, 32, 60, 60, ... Pure so it can be unit-tested.
fn next_backoff_secs(consecutive_failures: u32, base: u64, max: u64) -> u64 {
    if consecutive_failures == 0 {
        return base.min(max);
    }
    // Cap the shift so 2^exp never overflows; once shifted past `max` we clamp.
    let exp = (consecutive_failures - 1).min(20);
    let scaled = base.checked_shl(exp).unwrap_or(max);
    scaled.min(max)
}

fn run_doctor() -> bool {
    info!(target: "doctor", "running_doctor_checks");

    // OS-level VPN tooling and TUN/TAP prerequisites.
    let nm = crate::net::os::get_network_manager();
    match nm.check_dependencies() {
        Ok(_) => {
            info!(target: "doctor", "network_manager_dependencies_ok");
        }
        Err(e) => {
            error!(target: "doctor", error = ?e, "network_manager_dependencies_failed");
            return false;
        }
    }

    info!(target: "doctor", "doctor_checks_passed");
    true
}

/// Set up IP forwarding and NAT masquerading for VPN client traffic.
/// This allows VPN clients to access the internet through the VPN node.
fn setup_nat_and_forwarding() -> Result<(), i32> {
    use std::process::Command;

    info!("setting_up_ip_forwarding_and_nat");

    // Enable IPv4 forwarding
    let forward_result = Command::new("sysctl")
        .args(["-w", "net.ipv4.ip_forward=1"])
        .output();

    match forward_result {
        Ok(output) if output.status.success() => {
            info!("ipv4_forwarding_enabled");
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(stderr = stderr.as_ref(), "failed_to_enable_ipv4_forwarding");
        }
        Err(e) => {
            warn!(error = ?e, "failed_to_run_sysctl_for_ipv4_forwarding");
        }
    }

    // Enable IPv6 forwarding (needed for WireGuard/IKEv2 IPv6 pools)
    let forward_v6_result = Command::new("sysctl")
        .args(["-w", "net.ipv6.conf.all.forwarding=1"])
        .output();

    match forward_v6_result {
        Ok(output) if output.status.success() => {
            info!("ipv6_forwarding_enabled");
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            warn!(stderr = stderr.as_ref(), "failed_to_enable_ipv6_forwarding");
        }
        Err(e) => {
            warn!(error = ?e, "failed_to_run_sysctl_for_ipv6_forwarding");
        }
    }

    // Find the default route interface
    // In host network mode, this will be the host's main interface (e.g., en0, eth0, wlan0)
    // In Docker bridge mode, this will be eth0
    let default_iface = find_default_interface().unwrap_or_else(|| {
        warn!("could_not_determine_default_interface_using_eth0");
        "eth0".to_string()
    });

    // Validate interface name to prevent iptables argument injection
    if !default_iface
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        || default_iface.is_empty()
        || default_iface.len() > 15
    {
        error!(interface = default_iface.as_str(), "invalid_interface_name");
        return Err(1);
    }

    info!(
        interface = default_iface.as_str(),
        "setting_up_nat_masquerading"
    );

    // Set up IPv4 NAT masquerading for traffic from the VPN interface going out
    // the default interface. This allows VPN clients to reach the internet.
    if let Err(()) = ensure_masquerade("iptables", &default_iface) {
        // IPv4 NAT is required — fail the boot if it cannot be installed.
        return Err(1);
    }

    // Set up IPv6 NAT masquerading for the same egress interface.
    //
    // We hand out IPv6 ULA addresses (WireGuard fd42:42:42::/64, IKEv2
    // fd42:42:42::/64) and enable v6 forwarding, but without v6 NAT those ULA
    // source addresses are non-routable on the public internet and return
    // traffic never comes back — clients get a v6 default route that black-holes.
    // NAT66/masquerade for the ULA prefix gives parity with IPv4 so dual-stack
    // clients actually get working IPv6 egress. (NAT66 on ULA is a pragmatic
    // choice for nodes without a routed/delegated global v6 prefix.)
    //
    // ip6tables may be absent on v4-only hosts; treat a missing binary / failure
    // as a non-fatal warning rather than aborting the whole node.
    if ensure_masquerade("ip6tables", &default_iface).is_err() {
        warn!(
            interface = default_iface.as_str(),
            "ipv6_nat_masquerade_unavailable (ip6tables missing or failed); IPv6 egress may not work"
        );
    }

    // Set up FORWARD rules for VPN interfaces.
    // Docker sets FORWARD policy to DROP, so we must explicitly allow VPN traffic.
    // Use -I (insert) to place rules before Docker's chains which would otherwise drop traffic.
    // Install the same rules for both IPv4 (iptables) and IPv6 (ip6tables) so the
    // dual-stack ULA pools we hand out can actually forward. ip6tables failures
    // are best-effort (the binary may be absent on v4-only hosts).
    let vpn_ifaces = ["wg0", "tun0", "tun1"];
    for bin in ["iptables", "ip6tables"] {
        for vpn_iface in &vpn_ifaces {
            // Allow forwarding from VPN interface to the default (outbound) interface
            ensure_iptables_rule(
                bin,
                &[
                    "-I",
                    "FORWARD",
                    "-i",
                    vpn_iface,
                    "-o",
                    &default_iface,
                    "-j",
                    "ACCEPT",
                ],
            );
            // Allow established/related return traffic back into the VPN interface
            ensure_iptables_rule(
                bin,
                &[
                    "-I",
                    "FORWARD",
                    "-i",
                    &default_iface,
                    "-o",
                    vpn_iface,
                    "-m",
                    "state",
                    "--state",
                    "RELATED,ESTABLISHED",
                    "-j",
                    "ACCEPT",
                ],
            );
        }
    }

    info!("forward_rules_configured");

    Ok(())
}

/// Build the POSTROUTING MASQUERADE rule args for the given egress interface and
/// the given iptables `op` ("-C" to check, "-A" to add). Pure so it can be
/// unit-tested without invoking iptables/ip6tables. The same arg shape is used
/// for both `iptables` (IPv4) and `ip6tables` (IPv6).
fn masquerade_args<'a>(op: &'a str, iface: &'a str) -> Vec<&'a str> {
    vec![
        "-t",
        "nat",
        op,
        "POSTROUTING",
        "-o",
        iface,
        "-j",
        "MASQUERADE",
    ]
}

/// Ensure a POSTROUTING MASQUERADE rule exists for `iface` using the given
/// `bin` (`iptables` for IPv4 or `ip6tables` for IPv6). Returns Err(()) if the
/// rule is absent and could not be added (caller decides whether that is fatal).
fn ensure_masquerade(bin: &str, iface: &str) -> Result<(), ()> {
    use std::process::Command;

    let check = Command::new(bin)
        .args(masquerade_args("-C", iface))
        .output();
    let needs_add = match check {
        Ok(output) => !output.status.success(), // missing if check fails
        Err(_) => true,                         // binary missing / not runnable
    };

    if !needs_add {
        info!(
            bin = bin,
            interface = iface,
            "nat_masquerading_already_configured"
        );
        return Ok(());
    }

    match Command::new(bin)
        .args(masquerade_args("-A", iface))
        .output()
    {
        Ok(output) if output.status.success() => {
            info!(bin = bin, interface = iface, "nat_masquerading_configured");
            Ok(())
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!(
                bin = bin,
                stderr = stderr.as_ref(),
                interface = iface,
                "failed_to_setup_nat_masquerading"
            );
            Err(())
        }
        Err(e) => {
            error!(bin = bin, error = ?e, interface = iface, "failed_to_run_iptables_for_nat");
            Err(())
        }
    }
}

/// Add a rule via `bin` (iptables or ip6tables) if it doesn't already exist.
fn ensure_iptables_rule(bin: &str, args: &[&str]) {
    use std::process::Command;

    // Build the corresponding -C (check) args by replacing -A/-I with -C
    let check_args: Vec<&str> = args
        .iter()
        .map(|a| if *a == "-A" || *a == "-I" { "-C" } else { a })
        .collect();

    let exists = Command::new(bin)
        .args(&check_args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if exists {
        return;
    }

    match Command::new(bin).args(args).output() {
        Ok(output) if output.status.success() => {
            info!(
                bin = bin,
                rule = args.join(" ").as_str(),
                "iptables_rule_added"
            );
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error!(
                bin = bin,
                stderr = stderr.as_ref(),
                rule = args.join(" ").as_str(),
                "failed_to_add_iptables_rule"
            );
        }
        Err(e) => {
            error!(bin = bin, error = ?e, rule = args.join(" ").as_str(), "failed_to_run_iptables");
        }
    }
}

/// Find the default network interface by checking the default route.
fn find_default_interface() -> Option<String> {
    use std::process::Command;

    // Try 'ip route' first (Linux)
    if let Ok(output) = Command::new("ip")
        .args(["route", "show", "default"])
        .output()
    {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            // Parse "default via ... dev eth0 ..."
            for line in stdout.lines() {
                if let Some(dev_pos) = line.find("dev ") {
                    let after_dev = &line[dev_pos + 4..];
                    if let Some(space_pos) = after_dev.find(char::is_whitespace) {
                        let iface = after_dev[..space_pos].trim();
                        if !iface.is_empty() {
                            return Some(iface.to_string());
                        }
                    } else if !after_dev.trim().is_empty() {
                        return Some(after_dev.trim().to_string());
                    }
                }
            }
        }
    }

    // Fallback: try to find any non-loopback interface
    if let Ok(output) = Command::new("ip").args(["route", "show"]).output() {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if let Some(dev_pos) = line.find("dev ") {
                    let after_dev = &line[dev_pos + 4..];
                    if let Some(space_pos) = after_dev.find(char::is_whitespace) {
                        let iface = after_dev[..space_pos].trim();
                        if !iface.is_empty() && iface != "lo" && !iface.starts_with("wg") {
                            return Some(iface.to_string());
                        }
                    }
                }
            }
        }
    }

    None
}

async fn run_server(
    args: RunArgs,
    log_buffer: std::sync::Arc<logging::LogBuffer>,
) -> Result<(), i32> {
    info!(
        api_url = %args.api_url,
        listen_port = args.listen_port,
        admin_port = args.admin_port,
        "starting_vpn_server"
    );

    // Start Admin Server EARLY so we can debug registration failures
    let admin_server = tokio::spawn(run_admin(args.admin_port, log_buffer));
    info!(port = args.admin_port, "admin_server_started_early");

    // Log environment for debugging
    info!(
        server_id = env::var("SERVER_ID").ok(),
        vpn_region = env::var("VPN_REGION").ok(),
        vpn_protocols = env::var("VPN_PROTOCOLS").ok(),
        metrics_url = env::var("METRICS_URL").ok().map(|_| "[SET]"),
        "environment_variables"
    );

    // Check system dependencies
    info!("checking_system_dependencies");
    let nm = crate::net::os::get_network_manager();
    if let Err(e) = nm.check_dependencies() {
        error!(error = ?e, "missing_dependencies");
        return Err(1);
    }
    info!("system_dependencies_check_passed");

    // Initialize VPN backends
    let protos_env = env::var("VPN_PROTOCOLS").unwrap_or_else(|_| "wireguard,openvpn,ikev2".into());
    info!(
        protocols_config = protos_env.as_str(),
        "parsing_vpn_protocols"
    );

    let enabled: Vec<vpn::VpnProtocol> = protos_env
        .split(',')
        .map(|s| s.trim().to_ascii_lowercase())
        .filter_map(|s| match s.as_str() {
            "wireguard" => Some(vpn::VpnProtocol::WireGuard),
            "openvpn" => Some(vpn::VpnProtocol::OpenVpn),
            "ikev2" => Some(vpn::VpnProtocol::IkeV2),
            other => {
                warn!(protocol = other, "unknown_protocol_skipped");
                None
            }
        })
        .collect();

    info!(
        enabled_protocols = ?enabled.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
        "vpn_protocols_enabled"
    );

    info!("initializing_vpn_node");
    let node = match vpn::VpnNode::new(&enabled, args.listen_port) {
        Ok(n) => {
            info!("vpn_node_created_successfully");
            n
        }
        Err(e) => {
            error!(error = ?e, "failed_to_create_vpn_node");
            return Err(1);
        }
    };

    // Generate PKI before starting backends (OpenVPN/IKEv2 need certs)
    let detected_public_ip_early = {
        // Bound the external-IP probe so a hung service can't stall startup.
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let services = ["https://api.ipify.org", "https://ifconfig.me/ip"];
        let mut ip = None;
        for svc in services {
            if let Ok(resp) = client.get(svc).send().await {
                if let Ok(text) = resp.text().await {
                    let trimmed = text.trim();
                    if trimmed.parse::<std::net::IpAddr>().is_ok() {
                        ip = Some(trimmed.to_string());
                        break;
                    }
                }
            }
        }
        ip
    };

    if let Err(err) = pki::ensure_pki(detected_public_ip_early.clone()) {
        error!(error = ?err, "pki_generation_failed_before_backend_start");
        return Err(1);
    }
    // Also generate the tls-crypt key for OpenVPN and expose it via env so the
    // registration metadata can ship it to the control plane. Clients must embed
    // this shared key as <tls-crypt>; without it the server silently drops their
    // control-channel packets and the connection never establishes.
    match pki::ensure_tls_crypt_key() {
        Ok(key) => std::env::set_var("VPN_OVPN_TLS_CRYPT_KEY", key),
        Err(err) => warn!(error = ?err, "tls_crypt_key_generation_failed"),
    }

    info!("starting_all_vpn_backends");
    node.start_all();

    // Set up IP forwarding and NAT masquerading for VPN client traffic
    // This allows VPN clients to access the internet through the VPN node
    setup_nat_and_forwarding()?;

    let node_arc = std::sync::Arc::new(node);
    let _ = vpn::VPN_NODE.set(node_arc.clone());
    info!("vpn_node_registered_globally");

    // Optional static peer for local/docker tests (bypasses control plane peer sync)
    // Treat empty env/flag as "disabled" so docker default-empty vars don't break WireGuard.
    if let Some(static_pk) = args
        .static_peer_public_key
        .clone()
        .filter(|pk| !pk.trim().is_empty())
    {
        let allowed_raw = args
            .static_peer_allowed_ips
            .clone()
            .unwrap_or_else(|| "10.8.0.2/32".to_string());
        let allowed_ips: Vec<String> = allowed_raw
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let static_peer = vpn::PeerSpec {
            public_key: Some(static_pk),
            preshared_key: None,
            allowed_ips,
            endpoint: args.static_peer_endpoint.clone(),
            username: None,
            password: None,
        };

        match node_arc.apply_peers(&[static_peer]) {
            Ok(_) => info!("applied_static_peer_configuration"),
            Err(e) => error!(error = ?e, "static_peer_apply_failed"),
        }
    }

    // Client initialization
    let server_id = env::var("SERVER_ID")
        .or_else(|_| env::var("HOSTNAME"))
        .unwrap_or_else(|_| "vpn-node".to_string());

    let cp_client = std::sync::Arc::new(crate::client::ControlPlaneClient::new(
        args.api_url.clone(),
        args.token.clone(),
        server_id.clone(),
    ));

    // Detect public IP early for metadata
    let detected_public_ip = cp_client.detect_public_ip().await;

    // Detect geolocation BEFORE spawning any tasks to avoid thread-unsafe env::set_var.
    // All env vars must be set before spawning async tasks.
    if let Some(ref ip) = detected_public_ip {
        info!(ip = ip.as_str(), "detected_public_ip");

        if env::var("VPN_IKEV2_REMOTE").is_err() {
            env::set_var("VPN_IKEV2_REMOTE", format!("{ip}:500"));
        }
        if env::var("VPN_WG_ENDPOINT").is_err() {
            env::set_var("VPN_WG_ENDPOINT", ip.clone());
        }
        if env::var("VPN_OVPN_ENDPOINT").is_err() {
            env::set_var("VPN_OVPN_ENDPOINT", ip.clone());
        }

        // Detect geolocation synchronously (before spawning tasks)
        if env::var("VPN_REGION").is_err() || env::var("VPN_COUNTRY").is_err() {
            if let Some((country, region)) = cp_client.detect_geolocation(ip).await {
                info!(
                    country = country.as_str(),
                    region = region.as_str(),
                    "detected_geolocation_from_ip"
                );
                env::set_var("VPN_COUNTRY", &country);
                env::set_var("VPN_REGION", &region);
            } else {
                warn!("failed_to_detect_geolocation");
            }
        }
    }

    if env::var("VPN_WG_PORT").is_err() {
        env::set_var("VPN_WG_PORT", args.listen_port.to_string());
    }
    if env::var("VPN_OVPN_PORT").is_err() {
        env::set_var("VPN_OVPN_PORT", "1194");
    }

    // Registration / PKI / IKEv2 setup.
    //
    // These must run for ANY enabled protocol, not just WireGuard. Previously
    // the whole block was nested inside `if let Some(pubkey) = get_public_key()`,
    // so an IKEv2- or OpenVPN-only node (VPN_PROTOCOLS without "wireguard") had
    // no WG key, fell into the `else`, and exited(1) — never registering, doing
    // PKI, or starting strongSwan. We now decouple them: a WireGuard public key
    // is only REQUIRED when WireGuard is actually enabled.
    let wireguard_enabled = enabled.contains(&vpn::VpnProtocol::WireGuard);
    let wg_pubkey = node_arc.get_public_key();
    if wireguard_enabled && wg_pubkey.is_none() {
        error!("wireguard_enabled_but_no_public_key_found; cannot register");
        return Err(1);
    }
    // For non-WireGuard nodes there is no WG key; the control plane still needs a
    // value for the publicKey field, so send an empty string.
    let pubkey = wg_pubkey.unwrap_or_default();

    {
        let client = cp_client.clone();
        let listen_port = args.listen_port;

        // Generate self-signed PKI for OpenVPN/IKE if none provided via env
        let pki_artifacts = match pki::ensure_pki(detected_public_ip.clone()) {
            Ok(pki) => {
                // Set env vars before any tasks are spawned (safe, single-threaded context)
                env::set_var("VPN_OVPN_CA_BUNDLE", &pki.ca_pem);
                env::set_var("VPN_OVPN_PEER_FINGERPRINT", &pki.server_fingerprint);
                pki
            }
            Err(err) => {
                warn!(error = ?err, "pki_generation_failed");
                return Err(1);
            }
        };

        // Attempt to start IKEv2 (strongSwan) with generated PKI (only if enabled)
        if enabled.contains(&vpn::VpnProtocol::IkeV2) {
            if let Ok(meta) = crate::ikev2::setup_ikev2(
                detected_public_ip.clone(),
                &pki_artifacts.ca_pem,
                &pki_artifacts.server_pem,
                &pki_artifacts.server_fingerprint,
            ) {
                if env::var("VPN_IKEV2_REMOTE").is_err() {
                    env::set_var("VPN_IKEV2_REMOTE", &meta.remote);
                }
                env::set_var("VPN_IKEV2_FINGERPRINT", &meta.server_fingerprint);
                env::set_var("VPN_IKEV2_CA_BUNDLE", &meta.ca_pem);
            }
        }

        const MAX_ATTEMPTS: u32 = 12; // ~1 minute of retries
        let mut attempts: u32 = 0;

        loop {
            attempts += 1;
            match client.register(&pubkey, listen_port).await {
                Ok(_) => {
                    info!("successfully_registered_with_control_plane");
                    break;
                }
                Err(e) => {
                    error!(error = ?e, attempt = attempts, "registration_failed_retrying");
                    if attempts >= MAX_ATTEMPTS {
                        error!("registration_failed_max_retries; exiting vpn-node");
                        return Err(1);
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
    }

    // Peer Sync Loop
    let sync_node = node_arc.clone();
    let sync_client = cp_client.clone();
    tokio::spawn(async move {
        // Steady-state poll interval and capped exponential backoff bounds.
        const STEADY_INTERVAL_SECS: u64 = 2;
        const MAX_BACKOFF_SECS: u64 = 60;
        // Consecutive control-plane failures; drives the backoff. Reset to 0 on
        // any successful fetch so we return to the fast steady-state cadence.
        let mut consecutive_failures: u32 = 0;

        loop {
            // Sleep BEFORE each attempt. On success we use the steady interval
            // plus a small random jitter so a whole fleet of nodes does not
            // poll the control plane in lock-step (thundering herd). On failure
            // we back off exponentially (2s -> capped at 60s) to avoid hammering
            // a struggling control plane.
            let sleep_secs = if consecutive_failures == 0 {
                STEADY_INTERVAL_SECS
            } else {
                next_backoff_secs(consecutive_failures, STEADY_INTERVAL_SECS, MAX_BACKOFF_SECS)
            };
            let jitter_ms: u64 = rand::random::<u64>() % 1000;
            tokio::time::sleep(
                std::time::Duration::from_secs(sleep_secs)
                    + std::time::Duration::from_millis(jitter_ms),
            )
            .await;

            match sync_client.fetch_peers().await {
                Ok(peers) => {
                    consecutive_failures = 0;
                    info!(count = peers.len(), "applying_peers");
                    metrics::set_registered_peers(peers.len());
                    if let Err(e) = sync_node.apply_peers(&peers) {
                        error!(error = ?e, "apply_peers_failed");
                    }
                }
                // IMPORTANT: on a fetch failure we deliberately do NOT touch the
                // applied peer set — we keep the last-known-good configuration so
                // existing sessions survive a control-plane outage. apply_peers /
                // peer wiping must only happen on a SUCCESSFUL fetch above.
                Err(e) => {
                    consecutive_failures = consecutive_failures.saturating_add(1);
                    error!(
                        error = ?e,
                        consecutive_failures,
                        "peer_sync_request_failed_keeping_last_known_good"
                    );
                }
            }
        }
    });

    // Heartbeat Loop - send periodic status updates to stay marked as online.
    // Use the resolved pubkey (empty for non-WireGuard nodes) so IKEv2/OpenVPN-
    // only nodes still heartbeat instead of silently going offline.
    let heartbeat_client = cp_client.clone();
    let heartbeat_pubkey = pubkey.clone();
    tokio::spawn(async move {
        let public_ip = detected_public_ip.clone();

        loop {
            // Send heartbeat every 2 minutes (well under the 5 minute offline threshold)
            tokio::time::sleep(std::time::Duration::from_secs(120)).await;

            match heartbeat_client
                .heartbeat(&heartbeat_pubkey, args.listen_port, public_ip.clone())
                .await
            {
                Ok(_) => info!("heartbeat_sent"),
                Err(e) => error!(error = ?e, "heartbeat_failed"),
            }
        }
    });

    // Initialize metrics to 0 so every series is present before any activity.
    metrics::ensure_registered();

    // Periodic sampler to update in-process Prometheus metrics
    tokio::spawn(async move {
        loop {
            if let Some(node) = vpn::VPN_NODE.get() {
                metrics::update_from_statuses(&node.collect_status());
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });

    // Optional metrics ingestion to external metrics service
    if let Ok(metrics_url) = std::env::var("METRICS_URL") {
        let server_id = std::env::var("SERVER_ID")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "vpn-node".to_string());
        let region = std::env::var("VPN_REGION").ok();
        // The control-plane `POST /metrics/vpn` endpoint now REQUIRES the node
        // bearer token (the same VPN_TOKEN already used for /server/register).
        // Attach it to every metrics POST below.
        let metrics_token = args.token.clone();

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        // System information snapshot used to derive CPU and memory usage.
        let mut sys = sysinfo::System::new_all();

        tokio::spawn(async move {
            loop {
                // Refresh basic system metrics
                sys.refresh_cpu();
                sys.refresh_memory();

                let cpu = sys.global_cpu_info().cpu_usage() as f64;
                let total_mem = sys.total_memory() as f64;
                let used_mem = sys.used_memory() as f64;
                let mem_ratio = if total_mem > 0.0 {
                    (used_mem / total_mem).clamp(0.0, 1.0)
                } else {
                    0.0
                };

                if let Some(node) = vpn::VPN_NODE.get() {
                    let statuses = node.collect_status();
                    let mut total_active = 0usize;
                    let mut total_egress = 0u64;
                    let mut total_ingress = 0u64;
                    for st in &statuses {
                        total_active += st.active_sessions;
                        total_egress = total_egress.saturating_add(st.egress_bytes);
                        total_ingress = total_ingress.saturating_add(st.ingress_bytes);
                    }

                    // Per-peer cumulative transfer counters (since daemon
                    // start). Raw values; the control plane stores them as-is
                    // and consumers compute reset-aware deltas.
                    let peers = node.collect_peer_usage();

                    let body = serde_json::json!({
                        "serverId": server_id,
                        "activePeers": total_active,
                        "region": region,
                        "cpu": cpu,
                        "memory": mem_ratio,
                        "egressBytes": total_egress,
                        "ingressBytes": total_ingress,
                        "peers": peers,
                    });

                    if let Err(e) = client
                        .post(&metrics_url)
                        .bearer_auth(&metrics_token)
                        .json(&body)
                        .send()
                        .await
                    {
                        error!(error=?e, "metrics_publish_failed");
                    }
                }

                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
            }
        });
    }

    tokio::select! {
        _ = signal::ctrl_c() => {
            info!(signal="ctrl_c");
        }
        r = admin_server => { if let Err(e)=r { error!("admin_error"=?e); } }
    }

    Ok(())
}

async fn run_admin(port: u16, log_buffer: std::sync::Arc<logging::LogBuffer>) {
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;

    // Admin token for sensitive endpoints (logs, status, pubkey).
    // If not set, these endpoints return 403.
    let admin_token: Option<String> = std::env::var("ADMIN_API_TOKEN")
        .ok()
        .filter(|t| !t.trim().is_empty());

    fn check_admin_auth(headers: &axum::http::HeaderMap, expected: &Option<String>) -> bool {
        match expected {
            None => false, // No token configured = sensitive endpoints disabled
            Some(token) => {
                if let Some(auth) = headers.get(header::AUTHORIZATION) {
                    if let Ok(val) = auth.to_str() {
                        if let Some(presented) = val.strip_prefix("Bearer ") {
                            // Constant-time comparison to avoid leaking the token
                            // length/prefix through timing of an early-exit `==`.
                            if constant_time_eq(presented.as_bytes(), token.as_bytes()) {
                                return true;
                            }
                        }
                    }
                }
                // A token is configured but the caller presented none or an
                // invalid one — a genuine authentication failure.
                crate::metrics::record_admin_auth_failure();
                false
            }
        }
    }

    #[derive(serde::Serialize)]
    struct HealthCheck {
        status: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        active: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    }

    #[derive(serde::Serialize)]
    struct HealthResponse {
        status: &'static str,
        timestamp: String,
        service: &'static str,
        checks: std::collections::HashMap<String, HealthCheck>,
    }

    async fn health() -> impl IntoResponse {
        let mut checks = std::collections::HashMap::new();

        // VPN backends check
        let vpn_check = if let Some(node) = crate::vpn::VPN_NODE.get() {
            let statuses = node.collect_status();
            let active_protocols: Vec<String> = statuses
                .iter()
                .filter(|s| s.running)
                .map(|s| s.protocol.clone())
                .collect();

            if active_protocols.is_empty() {
                HealthCheck {
                    status: "error",
                    active: Some(vec![]),
                    error: Some("No VPN backends running".to_string()),
                }
            } else {
                HealthCheck {
                    status: "ok",
                    active: Some(active_protocols),
                    error: None,
                }
            }
        } else {
            HealthCheck {
                status: "error",
                active: None,
                error: Some("VPN node not initialized".to_string()),
            }
        };
        checks.insert("vpnBackends".to_string(), vpn_check);

        // System resources check (basic sanity)
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let total_mem = sys.total_memory();
        let used_mem = sys.used_memory();
        let mem_ratio = if total_mem > 0 {
            (used_mem as f64 / total_mem as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };

        // Consider system unhealthy if memory usage exceeds 95%
        let system_check = if mem_ratio > 0.95 {
            HealthCheck {
                status: "error",
                active: None,
                error: Some(format!("Memory usage critical: {:.1}%", mem_ratio * 100.0)),
            }
        } else {
            HealthCheck {
                status: "ok",
                active: None,
                error: None,
            }
        };
        checks.insert("system".to_string(), system_check);

        // Determine overall status
        let has_error = checks.values().any(|c| c.status == "error");
        let overall_status = if has_error { "unhealthy" } else { "healthy" };

        let response = HealthResponse {
            status: overall_status,
            timestamp: chrono::Utc::now().to_rfc3339(),
            service: "vpn-server",
            checks,
        };

        let status_code = if has_error {
            StatusCode::SERVICE_UNAVAILABLE
        } else {
            StatusCode::OK
        };

        (status_code, axum::Json(response))
    }

    async fn metrics() -> (
        [(axum::http::header::HeaderName, axum::http::HeaderValue); 1],
        Vec<u8>,
    ) {
        let buffer = crate::metrics::encode_prometheus();
        (
            [(
                axum::http::header::CONTENT_TYPE,
                axum::http::HeaderValue::from_static("text/plain; version=0.0.4"),
            )],
            buffer,
        )
    }
    // status, pubkey, logs endpoints below require ADMIN_API_TOKEN auth

    #[derive(Clone)]
    struct AdminState {
        log_buffer: std::sync::Arc<logging::LogBuffer>,
        admin_token: Option<String>,
    }

    async fn logs_authed(
        axum::extract::State(state): axum::extract::State<AdminState>,
        headers: axum::http::HeaderMap,
    ) -> impl IntoResponse {
        if !check_admin_auth(&headers, &state.admin_token) {
            return (StatusCode::FORBIDDEN, "Admin token required".to_string());
        }
        (StatusCode::OK, state.log_buffer.snapshot().join("\n"))
    }

    async fn status_authed(
        axum::extract::State(state): axum::extract::State<AdminState>,
        headers: axum::http::HeaderMap,
    ) -> impl IntoResponse {
        if !check_admin_auth(&headers, &state.admin_token) {
            return (StatusCode::FORBIDDEN, axum::Json(Vec::new()));
        }
        let statuses = crate::vpn::VPN_NODE
            .get()
            .map(|n| n.collect_status())
            .unwrap_or_default();
        (StatusCode::OK, axum::Json(statuses))
    }

    async fn pubkey_authed(
        axum::extract::State(state): axum::extract::State<AdminState>,
        headers: axum::http::HeaderMap,
    ) -> impl IntoResponse {
        // The WireGuard server public key is not strictly secret (clients need
        // it), but the control plane already distributes it; exposing it here
        // unauthenticated needlessly aids fingerprinting of the node, so gate it
        // behind the admin token like /logs and /status.
        if !check_admin_auth(&headers, &state.admin_token) {
            return (StatusCode::FORBIDDEN, axum::Json(None::<String>));
        }
        let pk = crate::vpn::VPN_NODE.get().and_then(|n| n.get_public_key());
        (StatusCode::OK, axum::Json(pk))
    }

    let admin_state = AdminState {
        log_buffer: log_buffer.clone(),
        admin_token: admin_token.clone(),
    };

    // Endpoint authentication policy:
    //   /health  — public liveness probe, no secrets.
    //   /metrics — kept PUBLIC: Prometheus scrapes it and changing the scrape
    //              config (to send a bearer) is out of scope. It exposes only
    //              aggregate counters/gauges (sessions, bytes, cpu/mem ratios) —
    //              no keys, certs, peer identities, or tls-crypt material.
    //   /status  — gated (per-protocol session/byte detail).
    //   /pubkey  — gated (node fingerprinting surface).
    //   /logs    — gated (log buffer; must never contain secrets, see client.rs).
    let app = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route("/status", get(status_authed))
        .route("/pubkey", get(pubkey_authed))
        .route("/logs", get(logs_authed))
        .with_state(admin_state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    // Handle bind failure (e.g. port already in use) instead of panicking — a
    // port conflict should produce a clear log line, not an unwrap panic.
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            error!(port = port, error = ?e, "admin_server_bind_failed");
            return;
        }
    };
    info!(port = port, "admin_server_listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            signal::ctrl_c().await.ok();
        })
        .await
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_eq_matches_equal_slices() {
        assert!(constant_time_eq(b"s3cret-token", b"s3cret-token"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn constant_time_eq_rejects_mismatches_and_length_diffs() {
        assert!(!constant_time_eq(b"s3cret-token", b"s3cret-toker"));
        assert!(!constant_time_eq(b"short", b"longer-token"));
        assert!(!constant_time_eq(b"prefix", b"prefix-extra"));
    }

    #[test]
    fn next_backoff_secs_is_capped_exponential() {
        // base=2, max=60 -> 2, 4, 8, 16, 32, then clamps at 60.
        assert_eq!(next_backoff_secs(1, 2, 60), 2);
        assert_eq!(next_backoff_secs(2, 2, 60), 4);
        assert_eq!(next_backoff_secs(3, 2, 60), 8);
        assert_eq!(next_backoff_secs(4, 2, 60), 16);
        assert_eq!(next_backoff_secs(5, 2, 60), 32);
        // 2^5=64 > 60 => clamped.
        assert_eq!(next_backoff_secs(6, 2, 60), 60);
        // Very large failure counts must not overflow; stay clamped at max.
        assert_eq!(next_backoff_secs(1_000_000, 2, 60), 60);
    }

    #[test]
    fn next_backoff_secs_zero_failures_is_base() {
        assert_eq!(next_backoff_secs(0, 2, 60), 2);
    }

    #[test]
    fn masquerade_args_shape_is_correct_for_both_families() {
        // Same arg shape is used for iptables (v4) and ip6tables (v6); only the
        // op flag and interface change.
        assert_eq!(
            masquerade_args("-C", "eth0"),
            vec![
                "-t",
                "nat",
                "-C",
                "POSTROUTING",
                "-o",
                "eth0",
                "-j",
                "MASQUERADE"
            ]
        );
        assert_eq!(
            masquerade_args("-A", "ens3"),
            vec![
                "-t",
                "nat",
                "-A",
                "POSTROUTING",
                "-o",
                "ens3",
                "-j",
                "MASQUERADE"
            ]
        );
    }
}

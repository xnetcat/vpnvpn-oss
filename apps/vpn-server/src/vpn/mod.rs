use anyhow::Result;
use once_cell::sync::OnceCell;
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

pub mod ipsec;
pub mod openvpn;
pub mod wireguard;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VpnProtocol {
    WireGuard,
    OpenVpn,
    IkeV2,
}

impl VpnProtocol {
    pub fn as_str(&self) -> &'static str {
        match self {
            VpnProtocol::WireGuard => "wireguard",
            VpnProtocol::OpenVpn => "openvpn",
            VpnProtocol::IkeV2 => "ikev2",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct BackendStatus {
    pub protocol: String,
    pub active_sessions: usize,
    pub egress_bytes: u64,
    pub ingress_bytes: u64,
    pub running: bool,
}

/// Per-peer cumulative transfer counters (bytes since daemon start), pushed to
/// the control plane alongside the server-level metric. Serialized camelCase to
/// match the existing `POST /metrics/vpn` payload conventions (`serverId`,
/// `activePeers`, `egressBytes`, ...). Identity is protocol-dependent:
/// WireGuard reports `public_key`, OpenVPN/IKEv2 report `username` (device id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

pub trait VpnBackend: Send + Sync {
    fn protocol(&self) -> VpnProtocol;
    fn start(&self) -> Result<()>;
    #[allow(dead_code)]
    fn stop(&self) -> Result<()>;
    fn status(&self) -> Result<BackendStatus>;
    fn apply_peers(&self, _peers: &[PeerSpec]) -> Result<()> {
        Ok(())
    }
    fn public_key(&self) -> Option<String> {
        None
    }
    /// Per-peer cumulative transfer counters. Default: none (backends that
    /// cannot attribute traffic to a peer simply report nothing).
    fn peer_usage(&self) -> Result<Vec<PeerUsage>> {
        Ok(Vec::new())
    }
}

#[derive(Clone, Serialize, serde::Deserialize)]
pub struct PeerSpec {
    pub public_key: Option<String>,
    pub preshared_key: Option<String>,
    pub allowed_ips: Vec<String>,
    pub endpoint: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
}

impl std::fmt::Debug for PeerSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerSpec")
            .field("public_key", &self.public_key)
            .field(
                "preshared_key",
                &self.preshared_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("allowed_ips", &self.allowed_ips)
            .field("endpoint", &self.endpoint)
            .field("username", &self.username)
            .field("password", &self.password.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

pub struct VpnNode {
    backends: Vec<Arc<dyn VpnBackend>>, // wireguard/openvpn/ipsec
    #[allow(dead_code)]
    last_egress_by_proto: Arc<RwLock<std::collections::HashMap<String, u64>>>,
    /// Mutex to serialize apply_peers calls and prevent concurrent config writes
    peers_lock: std::sync::Mutex<()>,
}

impl VpnNode {
    pub fn new(enabled: &[VpnProtocol], listen_port: u16) -> Result<Self> {
        info!(
            protocols = ?enabled.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
            listen_port = listen_port,
            "vpn_node_initializing"
        );

        let mut backends: Vec<Arc<dyn VpnBackend>> = Vec::new();
        for proto in enabled {
            match proto {
                VpnProtocol::WireGuard => {
                    info!(
                        protocol = "wireguard",
                        port = listen_port,
                        "creating_wireguard_backend"
                    );
                    match wireguard::WireGuardBackend::new(listen_port) {
                        Ok(backend) => {
                            info!(
                                protocol = "wireguard",
                                "wireguard_backend_created_successfully"
                            );
                            backends.push(Arc::new(backend));
                        }
                        Err(e) => {
                            error!(protocol = "wireguard", error = ?e, "failed_to_create_wireguard_backend");
                            return Err(e);
                        }
                    }
                }
                VpnProtocol::OpenVpn => {
                    info!(protocol = "openvpn", "creating_openvpn_backend");
                    match openvpn::OpenVpnBackend::new() {
                        Ok(backend) => {
                            info!(protocol = "openvpn", "openvpn_backend_created_successfully");
                            backends.push(Arc::new(backend));
                        }
                        Err(e) => {
                            error!(protocol = "openvpn", error = ?e, "failed_to_create_openvpn_backend");
                            return Err(e);
                        }
                    }
                }
                VpnProtocol::IkeV2 => {
                    info!(protocol = "ikev2", "creating_ipsec_backend");
                    match ipsec::IpsecBackend::new() {
                        Ok(backend) => {
                            info!(protocol = "ikev2", "ipsec_backend_created_successfully");
                            backends.push(Arc::new(backend));
                        }
                        Err(e) => {
                            error!(protocol = "ikev2", error = ?e, "failed_to_create_ipsec_backend");
                            return Err(e);
                        }
                    }
                }
            }
        }

        info!(backend_count = backends.len(), "vpn_node_initialized");

        Ok(Self {
            backends,
            last_egress_by_proto: Arc::new(RwLock::new(Default::default())),
            peers_lock: std::sync::Mutex::new(()),
        })
    }

    pub fn start_all(&self) {
        info!(
            backend_count = self.backends.len(),
            "starting_all_vpn_backends"
        );
        for b in &self.backends {
            let protocol = b.protocol().as_str();
            info!(protocol = protocol, "starting_backend");
            match b.start() {
                Ok(_) => info!(protocol = protocol, "backend_started_successfully"),
                Err(e) => error!(protocol = protocol, error = ?e, "backend_start_failed"),
            }
        }
        info!("all_backends_start_attempted");
    }

    #[allow(dead_code)]
    pub fn stop_all(&self) {
        info!(
            backend_count = self.backends.len(),
            "stopping_all_vpn_backends"
        );
        for b in &self.backends {
            let protocol = b.protocol().as_str();
            info!(protocol = protocol, "stopping_backend");
            match b.stop() {
                Ok(_) => info!(protocol = protocol, "backend_stopped_successfully"),
                Err(e) => error!(protocol = protocol, error = ?e, "backend_stop_failed"),
            }
        }
        info!("all_backends_stopped");
    }

    pub fn collect_status(&self) -> Vec<BackendStatus> {
        debug!(
            backend_count = self.backends.len(),
            "collecting_backend_status"
        );
        let statuses: Vec<BackendStatus> = self.backends
            .iter()
            .filter_map(|b| {
                match b.status() {
                    Ok(status) => {
                        debug!(
                            protocol = status.protocol.as_str(),
                            running = status.running,
                            active_sessions = status.active_sessions,
                            egress_bytes = status.egress_bytes,
                            ingress_bytes = status.ingress_bytes,
                            "backend_status"
                        );
                        Some(status)
                    }
                    Err(e) => {
                        warn!(protocol = b.protocol().as_str(), error = ?e, "failed_to_get_backend_status");
                        None
                    }
                }
            })
            .collect();
        debug!(status_count = statuses.len(), "status_collection_complete");
        statuses
    }

    /// Collect per-peer cumulative transfer counters across all backends.
    /// Backend failures are logged and skipped so one broken protocol never
    /// blocks usage reporting for the others.
    pub fn collect_peer_usage(&self) -> Vec<PeerUsage> {
        let mut usage: Vec<PeerUsage> = Vec::new();
        for b in &self.backends {
            match b.peer_usage() {
                Ok(mut peers) => usage.append(&mut peers),
                Err(e) => {
                    warn!(protocol = b.protocol().as_str(), error = ?e, "failed_to_collect_peer_usage");
                }
            }
        }
        usage
    }

    pub fn apply_peers(&self, peers: &[PeerSpec]) -> Result<()> {
        // Serialize peer updates to prevent concurrent config file writes (TOCTOU)
        let _guard = self.peers_lock.lock().unwrap_or_else(|e| e.into_inner());
        info!(peer_count = peers.len(), "applying_peers_to_all_backends");
        for peer in peers {
            debug!(
                public_key = peer.public_key.as_deref().map(|k| &k[..8.min(k.len())]),
                allowed_ips = ?peer.allowed_ips,
                endpoint = peer.endpoint.as_deref(),
                "peer_spec"
            );
        }

        // Apply to ALL enabled backends even if one fails. Previously we returned
        // on the first backend error, so a failure in one protocol (e.g. OpenVPN)
        // blocked peer application for the others (WireGuard/IKEv2). Collect every
        // failure and only return an aggregate error after attempting them all.
        let mut errors: Vec<String> = Vec::new();
        for b in &self.backends {
            let protocol = b.protocol().as_str();
            debug!(
                protocol = protocol,
                peer_count = peers.len(),
                "applying_peers_to_backend"
            );
            match b.apply_peers(peers) {
                Ok(_) => info!(protocol = protocol, "peers_applied_successfully"),
                Err(e) => {
                    error!(protocol = protocol, error = ?e, "failed_to_apply_peers");
                    errors.push(format!("{protocol}: {e:#}"));
                }
            }
        }

        if !errors.is_empty() {
            return Err(anyhow::anyhow!(
                "apply_peers failed for {} backend(s): {}",
                errors.len(),
                errors.join("; ")
            ));
        }

        info!(peer_count = peers.len(), "all_peers_applied");
        Ok(())
    }

    /// Test-only constructor that injects backends directly, so apply_peers /
    /// aggregation behavior can be exercised with mock backends (no real I/O).
    #[cfg(test)]
    pub fn from_backends(backends: Vec<Arc<dyn VpnBackend>>) -> Self {
        Self {
            backends,
            last_egress_by_proto: Arc::new(RwLock::new(Default::default())),
            peers_lock: std::sync::Mutex::new(()),
        }
    }

    pub fn get_public_key(&self) -> Option<String> {
        for b in &self.backends {
            if b.protocol() == VpnProtocol::WireGuard {
                let pk = b.public_key();
                if pk.is_some() {
                    debug!(protocol = "wireguard", "public_key_retrieved");
                }
                return pk;
            }
        }
        warn!("no_wireguard_backend_found_for_public_key");
        None
    }
}

pub static VPN_NODE: OnceCell<Arc<VpnNode>> = OnceCell::new();

#[cfg(test)]
mod tests;

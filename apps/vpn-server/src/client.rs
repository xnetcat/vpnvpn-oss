use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tracing::{debug, info};

use crate::vpn::PeerSpec;

pub struct ControlPlaneClient {
    client: Client,
    pub(crate) base_url: String,
    pub(crate) auth_token: String,
    pub(crate) server_id: String,
}

#[derive(Serialize)]
struct RegisterRequest {
    id: String,
    #[serde(rename = "publicKey")]
    public_key: String,
    #[serde(rename = "listenPort")]
    listen_port: u16,
    // Optional metadata about the node (region/country, etc.)
    metadata: Option<serde_json::Value>,
    #[serde(rename = "wgEndpoint")]
    wg_endpoint: Option<String>,
    #[serde(rename = "wgPort")]
    wg_port: Option<u16>,
    #[serde(rename = "ovpnEndpoint")]
    ovpn_endpoint: Option<String>,
    #[serde(rename = "ovpnPort")]
    ovpn_port: Option<u16>,
    #[serde(rename = "ovpnCaBundle")]
    ovpn_ca_bundle: Option<String>,
    #[serde(rename = "ovpnPeerFingerprint")]
    ovpn_peer_fingerprint: Option<String>,
    #[serde(rename = "ikev2Remote")]
    ikev2_remote: Option<String>,
}

// Redacting Debug impl (same pattern as PeerSpec in vpn/mod.rs): the register
// payload carries the CA bundle, cert fingerprints and (via metadata) the
// tls-crypt key, so a derived `{:?}` would leak them into the log buffer. Only
// expose non-sensitive presence flags here.
impl std::fmt::Debug for RegisterRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegisterRequest")
            .field("id", &self.id)
            .field("listen_port", &self.listen_port)
            .field("wg_endpoint", &self.wg_endpoint)
            .field("wg_port", &self.wg_port)
            .field("ovpn_endpoint", &self.ovpn_endpoint)
            .field("ovpn_port", &self.ovpn_port)
            .field(
                "ovpn_ca_bundle",
                &self.ovpn_ca_bundle.as_ref().map(|_| "[REDACTED]"),
            )
            .field(
                "ovpn_peer_fingerprint",
                &self.ovpn_peer_fingerprint.as_ref().map(|_| "[REDACTED]"),
            )
            .field("ikev2_remote", &self.ikev2_remote)
            .field("metadata", &self.metadata.as_ref().map(|_| "[REDACTED]"))
            .finish()
    }
}

#[derive(Debug, Deserialize)]
struct PeersResponse {
    peers: Vec<PeerSpec>,
}

impl ControlPlaneClient {
    pub fn new(base_url: String, auth_token: String, server_id: String) -> Self {
        let trimmed_url = base_url.trim_end_matches('/').to_string();
        if !trimmed_url.starts_with("https://") {
            tracing::warn!(
                url = trimmed_url.as_str(),
                "control_plane_url_is_not_https — tokens and peer data will be sent in plaintext"
            );
        }
        // Give the shared client a sensible default timeout so a hung control
        // plane (or external IP service) can never block a request indefinitely.
        // Individual call sites may still wrap requests in tighter timeouts.
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            base_url: trimmed_url,
            auth_token,
            server_id,
        }
    }

    pub async fn register(&self, public_key: &str, listen_port: u16) -> Result<()> {
        let url = format!("{}/server/register", self.base_url);

        // Optional metadata: region / country from env if available.
        let mut meta = serde_json::Map::new();
        if let Ok(region) = std::env::var("VPN_REGION") {
            meta.insert("region".to_string(), serde_json::Value::String(region));
        }
        if let Ok(country) = std::env::var("VPN_COUNTRY") {
            meta.insert("country".to_string(), serde_json::Value::String(country));
        }
        if let Ok(fp) = std::env::var("VPN_IKEV2_FINGERPRINT") {
            meta.insert(
                "ikev2Fingerprint".to_string(),
                serde_json::Value::String(fp),
            );
        }
        if let Ok(ca) = std::env::var("VPN_IKEV2_CA_BUNDLE") {
            meta.insert("ikev2CaBundle".to_string(), serde_json::Value::String(ca));
        }
        // tls-crypt is a shared group key; clients embed it as <tls-crypt> to
        // reach the OpenVPN server (which drops un-keyed control packets).
        if let Ok(key) = std::env::var("VPN_OVPN_TLS_CRYPT_KEY") {
            if !key.is_empty() {
                meta.insert("tlsCryptKey".to_string(), serde_json::Value::String(key));
            }
        }

        // Prefer explicit env for endpoints, otherwise fall back to detected public IP and listen_port
        let wg_endpoint = std::env::var("VPN_WG_ENDPOINT").ok();
        let mut wg_port = std::env::var("VPN_WG_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok());
        let ovpn_endpoint = std::env::var("VPN_OVPN_ENDPOINT").ok();
        let ovpn_port = std::env::var("VPN_OVPN_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok());
        let ovpn_ca_bundle = std::env::var("VPN_OVPN_CA_BUNDLE").ok();
        let ovpn_peer_fingerprint = std::env::var("VPN_OVPN_PEER_FINGERPRINT").ok();
        let ikev2_remote = std::env::var("VPN_IKEV2_REMOTE").ok();

        if wg_port.is_none() {
            wg_port = Some(listen_port);
        }

        let req = RegisterRequest {
            id: self.server_id.clone(),
            public_key: public_key.to_string(),
            listen_port,
            metadata: if meta.is_empty() {
                None
            } else {
                Some(serde_json::Value::Object(meta))
            },
            wg_endpoint,
            wg_port,
            ovpn_endpoint,
            ovpn_port,
            ovpn_ca_bundle,
            ovpn_peer_fingerprint,
            ikev2_remote,
        };

        // Do NOT log the full request: it carries the CA bundle, server cert
        // fingerprints, tls-crypt key (via metadata), and endpoints. Log only a
        // non-sensitive summary of which protocol material is present.
        info!(
            %url,
            node_id = req.id.as_str(),
            wg = req.wg_endpoint.is_some(),
            ovpn = req.ovpn_endpoint.is_some(),
            ovpn_ca = req.ovpn_ca_bundle.is_some(),
            ikev2 = req.ikev2_remote.is_some(),
            has_metadata = req.metadata.is_some(),
            "registering_with_control_plane"
        );

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.auth_token)
            .json(&req)
            .send()
            .await
            .context("failed to send register request")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("register request failed: {} - {}", status, text);
        }

        info!("successfully_registered");
        Ok(())
    }

    pub async fn fetch_peers(&self) -> Result<Vec<PeerSpec>> {
        let url = format!("{}/server/peers?id={}", self.base_url, self.server_id);
        debug!(%url, "fetching_peers");

        let resp = self
            .client
            .get(&url)
            .bearer_auth(&self.auth_token)
            .send()
            .await
            .context("failed to send fetch peers request")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("fetch peers request failed: {} - {}", status, text);
        }

        let payload: PeersResponse = resp
            .json()
            .await
            .context("failed to parse peers response")?;
        Ok(payload.peers)
    }

    /// Send heartbeat to control plane to stay marked as online
    /// This re-uses the /server/register endpoint which updates lastSeen
    pub async fn heartbeat(
        &self,
        public_key: &str,
        listen_port: u16,
        public_ip: Option<String>,
    ) -> Result<()> {
        let url = format!("{}/server/register", self.base_url);

        let mut meta = serde_json::Map::new();
        if let Ok(region) = std::env::var("VPN_REGION") {
            meta.insert("region".to_string(), serde_json::Value::String(region));
        }
        if let Ok(country) = std::env::var("VPN_COUNTRY") {
            meta.insert("country".to_string(), serde_json::Value::String(country));
        }
        if let Some(ip) = public_ip {
            meta.insert("publicIp".to_string(), serde_json::Value::String(ip));
        }

        let wg_endpoint = std::env::var("VPN_WG_ENDPOINT").ok();
        let wg_port = std::env::var("VPN_WG_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok());
        let ovpn_endpoint = std::env::var("VPN_OVPN_ENDPOINT").ok();
        let ovpn_port = std::env::var("VPN_OVPN_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok());
        let ovpn_ca_bundle = std::env::var("VPN_OVPN_CA_BUNDLE").ok();
        let ovpn_peer_fingerprint = std::env::var("VPN_OVPN_PEER_FINGERPRINT").ok();
        let ikev2_remote = std::env::var("VPN_IKEV2_REMOTE").ok();

        let req = RegisterRequest {
            id: self.server_id.clone(),
            public_key: public_key.to_string(),
            listen_port,
            metadata: if meta.is_empty() {
                None
            } else {
                Some(serde_json::Value::Object(meta))
            },
            wg_endpoint,
            wg_port,
            ovpn_endpoint,
            ovpn_port,
            ovpn_ca_bundle,
            ovpn_peer_fingerprint,
            ikev2_remote,
        };

        debug!(%url, "sending_heartbeat");

        let resp = self
            .client
            .post(&url)
            .bearer_auth(&self.auth_token)
            .json(&req)
            .send()
            .await
            .context("failed to send heartbeat request")?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!("heartbeat request failed: {} - {}", status, text);
        }

        debug!("heartbeat_sent_successfully");
        Ok(())
    }

    /// Detect public IP address by querying external service
    pub async fn detect_public_ip(&self) -> Option<String> {
        // Try multiple services for reliability
        let services = vec![
            "https://api.ipify.org",
            "https://ifconfig.me/ip",
            "https://icanhazip.com",
        ];

        for service in services {
            if let Ok(resp) = self.client.get(service).send().await {
                if let Ok(ip) = resp.text().await {
                    let ip = ip.trim();
                    // Validate that the response is actually an IP address
                    if let Ok(_addr) = ip.parse::<std::net::IpAddr>() {
                        debug!(ip, "detected_public_ip");
                        return Some(ip.to_string());
                    }
                }
            }
        }

        None
    }

    /// Detect geolocation (country, region) from public IP
    pub async fn detect_geolocation(&self, ip: &str) -> Option<(String, String)> {
        #[derive(serde::Deserialize)]
        #[allow(dead_code)]
        struct GeoResponse {
            success: Option<bool>,
            #[serde(rename = "country_code")]
            country_code: Option<String>,
            region: Option<String>,
            city: Option<String>,
        }

        // Validate IP address before embedding in URL
        if ip.parse::<std::net::IpAddr>().is_err() {
            debug!(ip, "invalid_ip_address_for_geolocation");
            return None;
        }

        // Use ipwho.is (free, HTTPS supported)
        let url = format!("https://ipwho.is/{}", ip);

        let timeout_duration = std::time::Duration::from_secs(5);
        let result = tokio::time::timeout(timeout_duration, async {
            self.client.get(&url).send().await
        })
        .await;

        match result {
            Ok(Ok(resp)) => {
                if let Ok(geo) = resp.json::<GeoResponse>().await {
                    if geo.success.unwrap_or(false) {
                        if let (Some(country), Some(region)) = (geo.country_code, geo.region) {
                            debug!(
                                country = country.as_str(),
                                region = region.as_str(),
                                "detected_geolocation"
                            );
                            return Some((country, region));
                        }
                    }
                }
            }
            Ok(Err(e)) => {
                debug!(error = ?e, "geolocation_api_request_failed");
            }
            Err(_) => {
                debug!("geolocation_api_timeout");
            }
        }

        None
    }
}

#[cfg(test)]
mod tests;

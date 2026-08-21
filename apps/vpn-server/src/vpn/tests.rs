use crate::vpn::{BackendStatus, PeerSpec, VpnBackend, VpnNode, VpnProtocol};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

/// Mock backend that records how many times apply_peers was called and can be
/// configured to succeed or fail. Used to verify apply_peers tries ALL backends.
struct MockBackend {
    proto: VpnProtocol,
    fail: bool,
    calls: Arc<AtomicUsize>,
}

impl VpnBackend for MockBackend {
    fn protocol(&self) -> VpnProtocol {
        self.proto
    }
    fn start(&self) -> anyhow::Result<()> {
        Ok(())
    }
    fn stop(&self) -> anyhow::Result<()> {
        Ok(())
    }
    fn status(&self) -> anyhow::Result<BackendStatus> {
        Ok(BackendStatus::default())
    }
    fn apply_peers(&self, _peers: &[PeerSpec]) -> anyhow::Result<()> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            Err(anyhow::anyhow!("mock failure"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn apply_peers_attempts_all_backends_even_when_one_fails() {
    let wg_calls = Arc::new(AtomicUsize::new(0));
    let ovpn_calls = Arc::new(AtomicUsize::new(0));
    let ike_calls = Arc::new(AtomicUsize::new(0));

    let node = VpnNode::from_backends(vec![
        // First backend FAILS — previously this aborted the whole apply.
        Arc::new(MockBackend {
            proto: VpnProtocol::WireGuard,
            fail: true,
            calls: wg_calls.clone(),
        }),
        Arc::new(MockBackend {
            proto: VpnProtocol::OpenVpn,
            fail: false,
            calls: ovpn_calls.clone(),
        }),
        Arc::new(MockBackend {
            proto: VpnProtocol::IkeV2,
            fail: false,
            calls: ike_calls.clone(),
        }),
    ]);

    let result = node.apply_peers(&[]);

    // Every backend must have been attempted despite the first one failing.
    assert_eq!(wg_calls.load(Ordering::SeqCst), 1);
    assert_eq!(ovpn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(ike_calls.load(Ordering::SeqCst), 1);
    // And the aggregate error is surfaced.
    assert!(result.is_err());
    let msg = format!("{:#}", result.unwrap_err());
    assert!(
        msg.contains("wireguard"),
        "error should name failing backend: {msg}"
    );
}

#[test]
fn apply_peers_all_success_returns_ok() {
    let calls = Arc::new(AtomicUsize::new(0));
    let node = VpnNode::from_backends(vec![Arc::new(MockBackend {
        proto: VpnProtocol::OpenVpn,
        fail: false,
        calls: calls.clone(),
    })]);
    assert!(node.apply_peers(&[]).is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn test_vpn_protocol_as_str() {
    assert_eq!(VpnProtocol::WireGuard.as_str(), "wireguard");
    assert_eq!(VpnProtocol::OpenVpn.as_str(), "openvpn");
    assert_eq!(VpnProtocol::IkeV2.as_str(), "ikev2");
}

#[test]
fn test_backend_status_default() {
    let status = BackendStatus::default();
    assert_eq!(status.active_sessions, 0);
    assert_eq!(status.egress_bytes, 0);
    assert_eq!(status.ingress_bytes, 0);
    assert!(!status.running);
}

#[test]
fn test_peer_spec_serialization() {
    let peer = PeerSpec {
        public_key: Some("test-key".to_string()),
        preshared_key: None,
        allowed_ips: vec!["10.8.0.10/32".to_string()],
        endpoint: Some("1.2.3.4:51820".to_string()),
        username: None,
        password: None,
    };

    let json = serde_json::to_string(&peer).unwrap();
    assert!(json.contains("test-key"));
    assert!(json.contains("10.8.0.10/32"));
}

#[test]
fn test_peer_spec_deserialization() {
    let json = r#"{
        "public_key": "test-key",
        "preshared_key": null,
        "allowed_ips": ["10.8.0.10/32"],
        "endpoint": "1.2.3.4:51820"
    }"#;

    let peer: PeerSpec = serde_json::from_str(json).unwrap();
    assert_eq!(peer.public_key, Some("test-key".to_string()));
    assert_eq!(peer.allowed_ips.len(), 1);
    assert_eq!(peer.allowed_ips[0], "10.8.0.10/32");
}

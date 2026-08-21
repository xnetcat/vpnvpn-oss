use crate::client::ControlPlaneClient;

#[test]
fn test_control_plane_client_new() {
    let client = ControlPlaneClient::new(
        "https://api.test.com".to_string(),
        "test-token".to_string(),
        "test-server-id".to_string(),
    );

    assert_eq!(client.base_url, "https://api.test.com");
    assert_eq!(client.auth_token, "test-token");
    assert_eq!(client.server_id, "test-server-id");
}

#[test]
fn test_base_url_trimming() {
    let client = ControlPlaneClient::new(
        "https://api.test.com/".to_string(),
        "test-token".to_string(),
        "test-server-id".to_string(),
    );

    // Should trim trailing slash
    assert_eq!(client.base_url, "https://api.test.com");
}

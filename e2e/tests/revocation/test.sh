#!/usr/bin/env bash
# Peer Revocation E2E Test
# 1. Register a WireGuard peer
# 2. Establish connection and verify connectivity
# 3. Revoke the peer via control plane
# 4. Wait for peer sync to remove the peer
# 5. Verify the peer can no longer communicate
set -euo pipefail

echo "[revoke-e2e] Generating WireGuard keys..."
PRIVATE_KEY=$(wg genkey)
PUBLIC_KEY=$(echo "$PRIVATE_KEY" | wg pubkey)
USER_ID="e2e-revoke-test-user"

echo "[revoke-e2e] Registering peer..."
curl -sf -X POST "$CONTROL_PLANE_URL/peers" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
        \"publicKey\": \"$PUBLIC_KEY\",
        \"userId\": \"$USER_ID\",
        \"allowedIps\": [\"10.8.0.20/32\"]
    }"

sleep 5

SERVER_PUB=$(curl -sf "$CONTROL_PLANE_URL/servers" -H "X-API-Key: $API_KEY" | jq -r '.[] | select(.id=="e2e-vpn-node") | .publicKey')

mkdir -p /etc/wireguard
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $PRIVATE_KEY
Address = 10.8.0.20/32

[Peer]
PublicKey = $SERVER_PUB
AllowedIPs = 10.8.0.0/24
Endpoint = vpn-node:51820
PersistentKeepalive = 15
EOF

echo "[revoke-e2e] Connecting..."
wg-quick up wg0

echo "[revoke-e2e] Verifying connectivity before revocation..."
ping -c 2 -W 5 10.8.0.1

echo "[revoke-e2e] Revoking peer..."
curl -sf -X POST "$CONTROL_PLANE_URL/peers/revoke-for-user" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"userId\": \"$USER_ID\"}"

echo "[revoke-e2e] Waiting for peer sync to remove peer..."
# Revocation propagates via the node's ~2s peer-sync loop, so the peer is not
# removed instantly. Poll until ping STARTS failing (peer gone), and only fail
# the test if traffic is still flowing after the deadline. This is a hard
# assertion: revocation that does not stop traffic is a test failure.
DEADLINE=30
revoked=0
for i in $(seq 1 "$DEADLINE"); do
    # Single short-timeout probe per second. Success here means the revoked
    # peer can still reach the gateway, which must not be the case once the
    # node has removed it.
    if ping -c 1 -W 1 10.8.0.1 >/dev/null 2>&1; then
        echo "[revoke-e2e] Ping still succeeds ${i}/${DEADLINE}s after revocation, waiting for peer sync..."
        sleep 1
    else
        echo "[revoke-e2e] Ping failed after ${i}s — peer appears revoked on the node"
        revoked=1
        break
    fi
done

if [ "$revoked" -ne 1 ]; then
    echo "[revoke-e2e] ERROR: peer still has connectivity ${DEADLINE}s after revocation — revocation did not take effect"
    wg show wg0 || true
    wg-quick down wg0 || true
    exit 1
fi

# Confirm the failure is stable (not a transient drop): traffic must stay dead.
echo "[revoke-e2e] Confirming connectivity stays severed..."
if ping -c 3 -W 3 10.8.0.1 >/dev/null 2>&1; then
    echo "[revoke-e2e] ERROR: connectivity recovered after revocation — peer was not removed"
    wg show wg0 || true
    wg-quick down wg0 || true
    exit 1
fi

wg-quick down wg0

echo "[revoke-e2e] Peer revocation E2E test PASSED"

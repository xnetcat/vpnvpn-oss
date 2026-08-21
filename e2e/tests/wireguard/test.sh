#!/usr/bin/env bash
# WireGuard E2E Test
# 1. Generate WireGuard keys
# 2. Register peer with control plane
# 3. Wait for peer sync
# 4. Establish WireGuard connection
# 5. Verify connectivity by pinging the VPN gateway
set -euo pipefail

echo "[wg-e2e] Generating WireGuard keys..."
PRIVATE_KEY=$(wg genkey)
PUBLIC_KEY=$(echo "$PRIVATE_KEY" | wg pubkey)

echo "[wg-e2e] Registering peer with control plane..."
curl -sf -X POST "$CONTROL_PLANE_URL/peers" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
        \"publicKey\": \"$PUBLIC_KEY\",
        \"userId\": \"e2e-wg-test-user\",
        \"allowedIps\": [\"10.8.0.10/32\"]
    }"

echo "[wg-e2e] Waiting for peer sync..."
sleep 5

echo "[wg-e2e] Getting server public key..."
# Fetch the node's WireGuard public key from the control plane (the node's
# /pubkey admin endpoint is auth-gated). The control-plane /servers response
# carries publicKey for the registered node.
SERVER_PUB=$(curl -sf "$CONTROL_PLANE_URL/servers" -H "X-API-Key: $API_KEY" | jq -r '.[] | select(.id=="e2e-vpn-node") | .publicKey')
echo "[wg-e2e] Server public key: $SERVER_PUB"

echo "[wg-e2e] Configuring WireGuard interface..."
mkdir -p /etc/wireguard
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $PRIVATE_KEY
Address = 10.8.0.10/32

[Peer]
PublicKey = $SERVER_PUB
AllowedIPs = 10.8.0.0/24
Endpoint = vpn-node:51820
PersistentKeepalive = 15
EOF

wg-quick up wg0

echo "[wg-e2e] Pinging VPN gateway (10.8.0.1)..."
ping -c 3 -W 5 10.8.0.1

echo "[wg-e2e] Verifying WireGuard status..."
wg show wg0

wg-quick down wg0

echo "[wg-e2e] WireGuard E2E test PASSED"

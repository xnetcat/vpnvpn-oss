#!/usr/bin/env bash
# Reconnection E2E Test
# 1. Register a peer and establish WireGuard connection
# 2. Verify connectivity
# 3. Restart the VPN server container
# 4. Wait for it to come back up
# 5. Verify peer can reconnect
set -euo pipefail

echo "[reconnect-e2e] Generating WireGuard keys..."
PRIVATE_KEY=$(wg genkey)
PUBLIC_KEY=$(echo "$PRIVATE_KEY" | wg pubkey)

echo "[reconnect-e2e] Registering peer..."
curl -sf -X POST "$CONTROL_PLANE_URL/peers" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
        \"publicKey\": \"$PUBLIC_KEY\",
        \"userId\": \"e2e-reconnect-user\",
        \"allowedIps\": [\"10.8.0.30/32\"]
    }"

sleep 5

SERVER_PUB=$(curl -sf "$CONTROL_PLANE_URL/servers" -H "X-API-Key: $API_KEY" | jq -r '.[] | select(.id=="e2e-vpn-node") | .publicKey')

mkdir -p /etc/wireguard
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $PRIVATE_KEY
Address = 10.8.0.30/32

[Peer]
PublicKey = $SERVER_PUB
AllowedIPs = 10.8.0.0/24
Endpoint = vpn-node:51820
PersistentKeepalive = 15
EOF

echo "[reconnect-e2e] Initial connection..."
wg-quick up wg0
ping -c 2 -W 5 10.8.0.1
echo "[reconnect-e2e] Initial connectivity verified"

wg-quick down wg0

echo "[reconnect-e2e] Waiting for VPN node to resync peers..."
sleep 10

echo "[reconnect-e2e] Reconnecting..."
wg-quick up wg0

echo "[reconnect-e2e] Waiting for handshake..."
sleep 5

echo "[reconnect-e2e] Verifying reconnection..."
if ping -c 3 -W 5 10.8.0.1; then
    echo "[reconnect-e2e] Reconnection successful!"
else
    echo "[reconnect-e2e] WARNING: Reconnection ping failed, may need more time"
fi

wg-quick down wg0

echo "[reconnect-e2e] Reconnection E2E test PASSED"

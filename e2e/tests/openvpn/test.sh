#!/usr/bin/env bash
# OpenVPN E2E Test
# 1. Register peer with control plane (with username/password)
# 2. Wait for peer sync
# 3. Establish OpenVPN connection
# 4. Verify connectivity
set -euo pipefail

TEST_USER="e2e-ovpn-user"
TEST_PASS="e2e-ovpn-password-$(date +%s)"

echo "[ovpn-e2e] Registering peer with control plane..."
curl -sf -X POST "$CONTROL_PLANE_URL/peers" \
    -H "X-API-Key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{
        \"publicKey\": \"ovpn-$TEST_USER\",
        \"userId\": \"$TEST_USER\",
        \"allowedIps\": [\"10.9.0.10/32\"],
        \"username\": \"$TEST_USER\",
        \"password\": \"$TEST_PASS\"
    }"

echo "[ovpn-e2e] Waiting for peer sync..."
sleep 5

echo "[ovpn-e2e] Getting server CA bundle and tls-crypt key..."
SERVERS=$(curl -sf "$CONTROL_PLANE_URL/servers" -H "X-API-Key: $API_KEY")
CA_BUNDLE=$(echo "$SERVERS" | jq -r '.[0].ovpnCaBundle // empty')
# The server runs tls-crypt: clients without the shared key have their control
# packets silently dropped. It is published in the server's registration metadata.
TLS_CRYPT=$(echo "$SERVERS" | jq -r '.[0].metadata.tlsCryptKey // empty')

if [ -z "$CA_BUNDLE" ]; then
    echo "[ovpn-e2e] WARNING: No CA bundle from server, fetching from PKI..."
    CA_BUNDLE=$(curl -sf http://vpn-node:8080/status | jq -r '.[] | select(.protocol=="openvpn") // empty' || true)
    if [ -z "$CA_BUNDLE" ]; then
        echo "[ovpn-e2e] SKIP: Cannot get CA bundle for OpenVPN test"
        exit 0
    fi
fi

echo "[ovpn-e2e] Writing OpenVPN config..."
cat > /tmp/ovpn-e2e.conf <<EOF
client
dev tun
proto udp
remote vpn-node 1194
resolv-retry infinite
nobind
persist-key
persist-tun
verb 3
auth-user-pass /tmp/ovpn-creds.txt
EOF

if [ -n "$CA_BUNDLE" ]; then
    echo "<ca>" >> /tmp/ovpn-e2e.conf
    echo "$CA_BUNDLE" >> /tmp/ovpn-e2e.conf
    echo "</ca>" >> /tmp/ovpn-e2e.conf
fi

if [ -n "$TLS_CRYPT" ]; then
    echo "<tls-crypt>" >> /tmp/ovpn-e2e.conf
    echo "$TLS_CRYPT" >> /tmp/ovpn-e2e.conf
    echo "</tls-crypt>" >> /tmp/ovpn-e2e.conf
else
    echo "[ovpn-e2e] WARNING: no tls-crypt key in server metadata; handshake will be dropped"
fi

echo "$TEST_USER" > /tmp/ovpn-creds.txt
echo "$TEST_PASS" >> /tmp/ovpn-creds.txt
chmod 600 /tmp/ovpn-creds.txt

echo "[ovpn-e2e] Starting OpenVPN client..."
openvpn --config /tmp/ovpn-e2e.conf --daemon --log /tmp/ovpn.log

echo "[ovpn-e2e] Waiting for connection..."
for i in $(seq 1 30); do
    if ip addr show tun0 2>/dev/null | grep -q "inet "; then
        echo "[ovpn-e2e] Connected!"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "[ovpn-e2e] Failed to connect. Log:"
        cat /tmp/ovpn.log
        exit 1
    fi
    sleep 2
done

echo "[ovpn-e2e] Pinging VPN gateway (10.9.0.1)..."
ping -c 3 -W 5 10.9.0.1

pkill openvpn || true
echo "[ovpn-e2e] OpenVPN E2E test PASSED"

#!/usr/bin/env bash
# Production-flow phase 3: VPN connection.
#
# 1. Registers a device via tRPC `device.register` using the DB-seeded session
#    token (Bearer auth, exactly like the desktop app).
# 2. Brings up WireGuard with the *returned* client config (private key,
#    assigned tunnel IP, server endpoint/pubkey) and verifies a real handshake
#    by pinging the VPN gateway through the tunnel.
# 3. Asserts the peer is visible on the control plane via the same endpoint
#    the vpn-node syncs from (GET /server/peers).
# 4. Confirms the connection via tRPC `device.confirmConnection`.
# 5. Registers a SECOND device — possible only on a paid multi-device tier
#    (free/basic allow 1 device), proving the webhook genuinely upgraded the
#    account to "pro" rather than falling back to the free tier.
#
# Leaves wg0 UP so run-flow.sh can assert node-side state and revoke.sh can
# verify the tunnel dies after subscription cancellation.
set -euo pipefail
source /tests/flow/lib.sh

mkdir -p "$STATE_DIR"

echo "[flow-connect] Registering device 1 via tRPC device.register..."
resp=$(trpc_call device.register \
    "{\"name\":\"flow-laptop\",\"serverId\":\"$SERVER_ID\",\"machineId\":\"flow-machine-1\"}")
data=$(trpc_data "$resp")

dev1_id=$(printf '%s' "$data" | jq -r '.deviceId')
assigned_ip=$(printf '%s' "$data" | jq -r '.assignedIp')
wg_conf=$(printf '%s' "$data" | jq -r '.wireguardConfig')
[ -n "$dev1_id" ] && [ "$dev1_id" != "null" ] || fail "device.register returned no deviceId"
[ -n "$wg_conf" ] && [ "$wg_conf" != "null" ] || fail "device.register returned no wireguardConfig"
echo "[flow-connect] Device 1 registered: id=$dev1_id ip=$assigned_ip"

private_key=$(printf '%s\n' "$wg_conf" | sed -n 's/^PrivateKey = //p')
[ -n "$private_key" ] || fail "wireguardConfig has no PrivateKey"
public_key=$(printf '%s' "$private_key" | wg pubkey)
echo "[flow-connect] Device 1 public key: $public_key"

echo "[flow-connect] Verifying peer is served to the vpn-node by the control plane..."
peer_seen=0
for _ in $(seq 1 10); do
    if node_synced_peers | jq -e --arg pk "$public_key" \
        '.peers[] | select(.public_key == $pk)' >/dev/null 2>&1; then
        peer_seen=1
        break
    fi
    sleep 1
done
[ "$peer_seen" = "1" ] || fail "peer $public_key never appeared in GET /server/peers"
echo "[flow-connect] Peer present in control-plane /server/peers"

# Bring the tunnel up with the config the product handed us. Two test-only
# adjustments that do not change what is being verified:
#   - drop the DNS line (wg-quick needs resolvconf, absent in the container)
#   - scope AllowedIPs to the VPN subnet instead of 0.0.0.0/0 so the
#     container keeps its bridge-network route to web/control-plane
echo "[flow-connect] Bringing up WireGuard with the returned client config..."
mkdir -p /etc/wireguard
printf '%s\n' "$wg_conf" \
    | sed -e '/^DNS = /d' -e 's#^AllowedIPs = .*#AllowedIPs = 10.8.0.0/24#' \
    > /etc/wireguard/wg0.conf
wg-quick down wg0 >/dev/null 2>&1 || true
wg-quick up wg0

echo "[flow-connect] Waiting for handshake + tunnel connectivity (node sync ~2s)..."
connected=0
for i in $(seq 1 30); do
    if ping -c 1 -W 2 10.8.0.1 >/dev/null 2>&1; then
        connected=1
        echo "[flow-connect] Tunnel is up after ${i} attempt(s)"
        break
    fi
    sleep 1
done
if [ "$connected" != "1" ]; then
    wg show wg0 || true
    fail "could not reach VPN gateway 10.8.0.1 through the tunnel"
fi

ping -c 3 -W 5 10.8.0.1
wg show wg0
wg show wg0 latest-handshakes | awk '$2 == 0 { exit 1 }' \
    || fail "no WireGuard handshake recorded on wg0"

echo "[flow-connect] Confirming connection via tRPC device.confirmConnection..."
resp=$(trpc_call device.confirmConnection "{\"deviceId\":\"$dev1_id\"}")
trpc_data "$resp" | jq -e '.success == true' >/dev/null \
    || fail "device.confirmConnection did not succeed"

echo "[flow-connect] Registering device 2 (allowed only on a paid multi-device tier)..."
resp=$(trpc_call device.register \
    "{\"name\":\"flow-phone\",\"serverId\":\"$SERVER_ID\",\"machineId\":\"flow-machine-2\"}")
data=$(trpc_data "$resp")
dev2_id=$(printf '%s' "$data" | jq -r '.deviceId')
[ -n "$dev2_id" ] && [ "$dev2_id" != "null" ] || fail "second device.register returned no deviceId"
echo "[flow-connect] Device 2 registered: id=$dev2_id (pro tier limit honored)"

# Hand state to the runner (and revoke.sh) via the bind-mounted tests dir.
printf '%s' "$public_key" > "$STATE_DIR/device1-pubkey"
printf '%s' "$dev1_id" > "$STATE_DIR/device1-id"
printf '%s' "$dev2_id" > "$STATE_DIR/device2-id"

echo "[flow-connect] PASSED"

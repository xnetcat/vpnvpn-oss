#!/usr/bin/env bash
# Production-flow phase 4: revocation.
#
# Simulates the subscription ending (signed `customer.subscription.deleted`
# webhook). The web app must revoke the user's peers on the control plane and
# the vpn-node's ~2s sync loop must then remove them, killing the live tunnel
# that connect.sh left up. Hard assertions:
#   - tunnel traffic stops within the deadline and STAYS dead
#   - the peer disappears from GET /server/peers (what the node syncs)
set -euo pipefail
source /tests/flow/lib.sh

public_key=$(cat "$STATE_DIR/device1-pubkey")
[ -n "$public_key" ] || fail "missing device1-pubkey state from connect.sh"

echo "[flow-revoke] Sanity: tunnel still alive before cancellation..."
ping -c 1 -W 5 10.8.0.1 >/dev/null 2>&1 || fail "tunnel already down before revocation"

echo "[flow-revoke] Cancelling subscription via signed Stripe webhook..."
send_subscription_webhook "customer.subscription.deleted" "canceled"

echo "[flow-revoke] Waiting for peer removal to sever the tunnel..."
DEADLINE=45
severed=0
for i in $(seq 1 "$DEADLINE"); do
    if ping -c 1 -W 1 10.8.0.1 >/dev/null 2>&1; then
        sleep 1
    else
        echo "[flow-revoke] Tunnel severed after ${i}s"
        severed=1
        break
    fi
done
if [ "$severed" != "1" ]; then
    wg show wg0 || true
    fail "tunnel still alive ${DEADLINE}s after subscription.deleted"
fi

echo "[flow-revoke] Confirming the cut is stable (not a transient drop)..."
if ping -c 3 -W 3 10.8.0.1 >/dev/null 2>&1; then
    fail "connectivity recovered after revocation — peer was not removed"
fi

echo "[flow-revoke] Verifying peer no longer served to the vpn-node..."
peers_json=$(node_synced_peers) || fail "could not fetch GET /server/peers"
if printf '%s' "$peers_json" | jq -e --arg pk "$public_key" \
    '.peers[] | select(.public_key == $pk)' >/dev/null 2>&1; then
    fail "revoked peer $public_key still present in GET /server/peers"
fi

wg-quick down wg0 || true
echo "[flow-revoke] PASSED"

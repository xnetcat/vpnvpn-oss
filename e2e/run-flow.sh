#!/usr/bin/env bash
# =============================================================================
# Production-Flow E2E Test: signup -> payment -> VPN connection (-> revocation)
#
# Exercises the real production pipeline from the OUTSIDE, across the actual
# service boundaries (no app code is mocked):
#
#   1. signup   — seeds a User (+ stripeCustomerId) and a NextAuth Session row
#                 in Postgres; the session token is the same DB-session Bearer
#                 seam the desktop app uses against tRPC.
#   2. payment  — POSTs a correctly HMAC-signed `customer.subscription.created`
#                 Stripe event (price -> tier "pro") to the web app's webhook;
#                 asserts a pro/active Subscription row is persisted.
#   3. connect  — calls tRPC `device.register` with the Bearer token, brings up
#                 WireGuard with the returned client config inside the
#                 privileged test-client, verifies a live handshake + ping to
#                 the VPN gateway, asserts the peer on the control plane AND on
#                 the vpn-node (`wg show`), then `device.confirmConnection`.
#                 A second device registration proves the paid tier's device
#                 limit (free/basic = 1 device) is actually in effect.
#   4. revoke   — POSTs a signed `customer.subscription.deleted` event; asserts
#                 the live tunnel is severed by the node's sync loop, the peer
#                 disappears from the control plane and the node, and excess
#                 devices are pruned to the free-tier limit.
#
# Usage:
#   bun run test:flow            # from the repo root
#   bash e2e/run-flow.sh         # equivalent
#   KEEP_STACK=1 bash e2e/run-flow.sh   # leave the stack up for debugging
#
# Requirements: Docker (with compose v2.24+ for the `!reset` overlay tag).
# Self-contained: no .env, no Stripe account, no host ports needed — the
# compose-flow.yaml overlay un-publishes the base file's host ports, so this
# can run alongside a local dev stack.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE=(docker compose -f compose-e2e.yaml -f compose-flow.yaml)

# Test identities/secrets — must match compose-flow.yaml (web env) and
# compose-e2e.yaml (control-plane env).
API_KEY="e2e-test-api-key"
NODE_TOKEN="e2e-test-token"
SERVER_ID="e2e-vpn-node"
STRIPE_WEBHOOK_SECRET="whsec_e2e_flow_test_secret"
STRIPE_PRICE_ID_PRO="price_e2e_pro"
FLOW_USER_ID="flow-user"
FLOW_USER_EMAIL="flow-user@e2e.test"
FLOW_CUSTOMER_ID="cus_e2e_flow"
FLOW_SUB_ID="sub_e2e_flow"
SESSION_TOKEN="flow-sess-$(openssl rand -hex 16 2>/dev/null || echo "$$-$RANDOM-$(date +%s)")"
STATE_DIR="$SCRIPT_DIR/tests/flow/.state"

step() { printf '\n=== %s ===\n' "$1"; }
die() { echo "ERROR: $1" >&2; exit 1; }

psql_q() { # run a SQL query, print trimmed scalar result
    "${COMPOSE[@]}" exec -T postgres \
        psql -v ON_ERROR_STOP=1 -U postgres -d vpnvpn -tA -c "$1" | tr -d '[:space:]'
}

assert_eq() { # $1 = label, $2 = actual, $3 = expected
    if [ "$2" != "$3" ]; then
        die "$1: expected '$3', got '$2'"
    fi
    echo "OK: $1 = $3"
}

client() { # run a flow phase script inside the test-client container
    "${COMPOSE[@]}" exec -T \
        -e WEB_URL="http://web:3000" \
        -e CONTROL_PLANE_URL="http://control-plane:4000" \
        -e API_KEY="$API_KEY" \
        -e NODE_TOKEN="$NODE_TOKEN" \
        -e SERVER_ID="$SERVER_ID" \
        -e SESSION_TOKEN="$SESSION_TOKEN" \
        -e STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" \
        -e STRIPE_PRICE_ID_PRO="$STRIPE_PRICE_ID_PRO" \
        -e FLOW_CUSTOMER_ID="$FLOW_CUSTOMER_ID" \
        -e FLOW_SUB_ID="$FLOW_SUB_ID" \
        -e STATE_DIR="/tests/flow/.state" \
        test-client bash "/tests/flow/$1"
}

cleanup() {
    status=$?
    echo ""
    if [ $status -ne 0 ]; then
        echo "=== FLOW TEST FAILED — recent web-app / vpn-node logs ==="
        "${COMPOSE[@]}" logs --tail 60 web 2>/dev/null || true
        "${COMPOSE[@]}" logs --tail 30 vpn-node 2>/dev/null || true
    fi
    if [ "${KEEP_STACK:-0}" = "1" ]; then
        echo "=== KEEP_STACK=1 — leaving the stack running ==="
        echo "Tear down with: (cd e2e && docker compose -f compose-e2e.yaml -f compose-flow.yaml down -v --remove-orphans)"
    else
        echo "=== Cleaning up ==="
        "${COMPOSE[@]}" down -v --remove-orphans 2>/dev/null || true
    fi
    rm -rf "$STATE_DIR"
    exit $status
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || die "docker is required"
docker info >/dev/null 2>&1 || die "Docker daemon is not running"
rm -rf "$STATE_DIR"

step "Building flow test environment (postgres, control-plane, vpn-node, web, test-client)"
"${COMPOSE[@]}" build

step "Starting services"
"${COMPOSE[@]}" up -d

step "Waiting for control plane"
for i in $(seq 1 60); do
    # control-plane image has no curl; probe over the compose net from vpn-node
    if "${COMPOSE[@]}" exec -T vpn-node curl -sf http://control-plane:4000/health >/dev/null 2>&1; then
        echo "Control plane is ready"
        break
    fi
    [ "$i" -eq 60 ] && { "${COMPOSE[@]}" logs control-plane; die "control plane never became ready"; }
    sleep 2
done

step "Waiting for vpn-node registration with control plane"
for i in $(seq 1 40); do
    if "${COMPOSE[@]}" exec -T vpn-node \
        curl -sf -H "X-API-Key: $API_KEY" http://control-plane:4000/servers 2>/dev/null \
        | grep -q "\"$SERVER_ID\""; then
        echo "VPN node registered"
        break
    fi
    [ "$i" -eq 40 ] && { "${COMPOSE[@]}" logs vpn-node; die "vpn-node never registered"; }
    sleep 2
done

step "Waiting for web app"
for i in $(seq 1 90); do
    if "${COMPOSE[@]}" exec -T test-client curl -sf -o /dev/null http://web:3000/ 2>/dev/null; then
        echo "Web app is ready"
        break
    fi
    [ "$i" -eq 90 ] && { "${COMPOSE[@]}" logs web; die "web app never became ready"; }
    sleep 2
done

# ---------------------------------------------------------------------------
step "PHASE 1: signup — seed user + DB session (desktop Bearer-token seam)"
# ---------------------------------------------------------------------------
"${COMPOSE[@]}" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U postgres -d vpnvpn <<SQL
INSERT INTO "User" (id, email, name, "stripeCustomerId", "updatedAt")
VALUES ('$FLOW_USER_ID', '$FLOW_USER_EMAIL', 'Flow Tester', '$FLOW_CUSTOMER_ID', NOW())
ON CONFLICT (id) DO UPDATE SET "stripeCustomerId" = EXCLUDED."stripeCustomerId";
INSERT INTO "Session" (id, "sessionToken", "userId", expires)
VALUES ('flow-session', '$SESSION_TOKEN', '$FLOW_USER_ID', NOW() + interval '1 hour')
ON CONFLICT (id) DO UPDATE
SET "sessionToken" = EXCLUDED."sessionToken", expires = EXCLUDED.expires;
SQL
echo "User + session seeded"
assert_eq "subscriptions before payment" \
    "$(psql_q "SELECT count(*) FROM \"Subscription\" WHERE \"userId\" = '$FLOW_USER_ID'")" "0"

# ---------------------------------------------------------------------------
step "PHASE 2: payment — signed Stripe webhook activates pro subscription"
# ---------------------------------------------------------------------------
client payment.sh
assert_eq "subscription tier|status" \
    "$(psql_q "SELECT tier || '|' || status FROM \"Subscription\" WHERE \"stripeSubscriptionId\" = '$FLOW_SUB_ID'")" \
    "pro|active"

# ---------------------------------------------------------------------------
step "PHASE 3: connect — tRPC device.register + live WireGuard handshake"
# ---------------------------------------------------------------------------
client connect.sh

DEVICE_PUBKEY="$(cat "$STATE_DIR/device1-pubkey")"
[ -n "$DEVICE_PUBKEY" ] || die "connect.sh did not record the device public key"

assert_eq "active peers on control plane" \
    "$(psql_q "SELECT count(*) FROM \"VpnPeer\" WHERE \"userId\" = '$FLOW_USER_ID' AND active")" "2"
assert_eq "confirmed (active) devices" \
    "$(psql_q "SELECT count(*) FROM \"Device\" WHERE \"userId\" = '$FLOW_USER_ID' AND status = 'active'")" "1"

echo "Checking the peer landed on the vpn-node itself (wg show)..."
node_has_peer=0
for _ in $(seq 1 10); do
    if "${COMPOSE[@]}" exec -T vpn-node wg show 2>/dev/null | grep -qF "$DEVICE_PUBKEY"; then
        node_has_peer=1
        break
    fi
    sleep 1
done
[ "$node_has_peer" = "1" ] || die "peer $DEVICE_PUBKEY never appeared in vpn-node 'wg show'"
echo "OK: peer is configured on the vpn-node WireGuard interface"

# ---------------------------------------------------------------------------
step "PHASE 4: revoke — subscription.deleted webhook severs the live tunnel"
# ---------------------------------------------------------------------------
client revoke.sh

assert_eq "subscription status after cancellation" \
    "$(psql_q "SELECT status FROM \"Subscription\" WHERE \"stripeSubscriptionId\" = '$FLOW_SUB_ID'")" \
    "canceled"
assert_eq "active peers after cancellation" \
    "$(psql_q "SELECT count(*) FROM \"VpnPeer\" WHERE \"userId\" = '$FLOW_USER_ID' AND active")" "0"
assert_eq "devices pruned to free-tier limit" \
    "$(psql_q "SELECT count(*) FROM \"Device\" WHERE \"userId\" = '$FLOW_USER_ID'")" "1"

echo "Checking the peer was removed from the vpn-node (wg show)..."
node_peer_gone=0
for _ in $(seq 1 15); do
    if ! "${COMPOSE[@]}" exec -T vpn-node wg show 2>/dev/null | grep -qF "$DEVICE_PUBKEY"; then
        node_peer_gone=1
        break
    fi
    sleep 1
done
[ "$node_peer_gone" = "1" ] || die "revoked peer $DEVICE_PUBKEY still present in vpn-node 'wg show'"
echo "OK: peer removed from the vpn-node WireGuard interface"

step "PRODUCTION FLOW TEST PASSED"
echo "signup -> payment (signed webhook) -> tRPC device.register -> control-plane"
echo "peer -> vpn-node sync -> WireGuard handshake -> revocation: all verified."

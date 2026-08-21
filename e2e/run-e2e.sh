#!/usr/bin/env bash
# =============================================================================
# E2E Test Runner
# Orchestrates Docker-based end-to-end VPN tests
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE_FILE="compose-e2e.yaml"
CONTROL_PLANE_URL="http://control-plane:4000"
API_KEY="e2e-test-api-key"
PASSED=0
FAILED=0
TOTAL=0

cleanup() {
    echo ""
    echo "=== Cleaning up ==="
    docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Building E2E test environment ==="
docker compose -f "$COMPOSE_FILE" build

echo "=== Starting services ==="
docker compose -f "$COMPOSE_FILE" up -d

echo "=== Waiting for services to be ready ==="
for i in $(seq 1 60); do
    # The control-plane image has no curl; probe it from vpn-node (which does) over the compose network.
    if docker compose -f "$COMPOSE_FILE" exec -T vpn-node curl -sf http://control-plane:4000/health >/dev/null 2>&1; then
        echo "Control plane is ready"
        break
    fi
    if [ "$i" -eq 60 ]; then
        echo "ERROR: Control plane did not become ready in time"
        docker compose -f "$COMPOSE_FILE" logs control-plane
        exit 1
    fi
    sleep 2
done

# Seed the test users that the peer-registration tests reference. VpnPeer.userId
# is a required foreign key to User, so POST /peers fails with a 400 unless the
# user already exists. The control-plane runs migrations before it answers
# /health (see index.ts), so the User table is present by the time we get here.
echo "=== Seeding E2E test users ==="
docker compose -f "$COMPOSE_FILE" exec -T postgres \
    psql -v ON_ERROR_STOP=1 -U postgres -d vpnvpn <<'SQL'
INSERT INTO "User" (id, "updatedAt") VALUES
    ('e2e-wg-test-user', NOW()),
    ('e2e-ovpn-user', NOW()),
    ('e2e-ikev2-user', NOW()),
    ('e2e-revoke-test-user', NOW()),
    ('e2e-reconnect-user', NOW())
ON CONFLICT (id) DO NOTHING;
SQL
echo "Test users seeded"

# Wait for VPN node admin server
for i in $(seq 1 30); do
    if docker compose -f "$COMPOSE_FILE" exec -T vpn-node curl -sf http://localhost:8080/health >/dev/null 2>&1; then
        echo "VPN node is ready"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "ERROR: VPN node did not become ready in time"
        docker compose -f "$COMPOSE_FILE" logs vpn-node
        exit 1
    fi
    sleep 2
done

# Wait for the VPN node to actually register with the control plane. The node's
# first registration attempt races control-plane startup and fails; it retries
# every 5s. Tests query /servers (for the CA bundle) and rely on peer sync, so
# they must not run until the server row exists.
echo "=== Waiting for VPN node to register with control plane ==="
for i in $(seq 1 40); do
    if docker compose -f "$COMPOSE_FILE" exec -T vpn-node \
        curl -sf -H "X-API-Key: $API_KEY" http://control-plane:4000/servers 2>/dev/null \
        | grep -q '"e2e-vpn-node"'; then
        echo "VPN node registered with control plane"
        break
    fi
    if [ "$i" -eq 40 ]; then
        echo "ERROR: VPN node did not register with control plane in time"
        docker compose -f "$COMPOSE_FILE" logs vpn-node
        exit 1
    fi
    sleep 2
done

run_test() {
    local test_name="$1"
    local test_script="$2"
    TOTAL=$((TOTAL + 1))

    echo ""
    echo "--- Running test: $test_name ---"
    if docker compose -f "$COMPOSE_FILE" exec -T \
        -e CONTROL_PLANE_URL="$CONTROL_PLANE_URL" \
        -e API_KEY="$API_KEY" \
        test-client bash "/tests/$test_script"; then
        echo "PASS: $test_name"
        PASSED=$((PASSED + 1))
    else
        echo "FAIL: $test_name"
        echo "--- test-client diagnostics ($test_name) ---"
        docker compose -f "$COMPOSE_FILE" exec -T test-client sh -c \
            'echo "[wg show]"; wg show 2>&1 || true; echo "[addr]"; ip -brief addr 2>&1 || true; echo "[route]"; ip route 2>&1 || true' \
            2>/dev/null || true
        FAILED=$((FAILED + 1))
    fi
}

echo ""
echo "=== Running E2E Tests ==="

run_test "WireGuard connectivity" "wireguard/test.sh"
run_test "OpenVPN connectivity" "openvpn/test.sh"
run_test "IKEv2 connectivity" "ikev2/test.sh"
run_test "Peer revocation" "revocation/test.sh"
run_test "Server reconnect" "reconnect/test.sh"

echo ""
echo "=== E2E Test Results ==="
echo "Total: $TOTAL  Passed: $PASSED  Failed: $FAILED"

if [ "$FAILED" -gt 0 ]; then
    echo ""
    echo "Dumping logs for failed tests..."
    docker compose -f "$COMPOSE_FILE" logs vpn-node
    exit 1
fi

echo "All tests passed!"

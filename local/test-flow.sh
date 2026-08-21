#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOCAL_DIR="$ROOT_DIR/local"

log() { echo -e "${GREEN}[TEST]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

cd "$LOCAL_DIR"

trap 'log "Tearing down docker stack"; docker compose down -v >/dev/null 2>&1 || true' EXIT

log "=== vpnVPN dockerized local stack ==="

# Ensure wg is available for key generation
if ! command -v wg >/dev/null 2>&1; then
  error "'wg' (wireguard-tools) must be installed to run this script."
fi

# Generate ephemeral WireGuard keys for the docker test client if not provided
if [ -z "$VPN_TEST_CLIENT_PRIVATE_KEY" ] || [ -z "$VPN_TEST_CLIENT_PUBLIC_KEY" ]; then
  log "Generating ephemeral WireGuard keys for vpn-test-client..."
  VPN_TEST_CLIENT_PRIVATE_KEY="$(wg genkey)"
  VPN_TEST_CLIENT_PUBLIC_KEY="$(printf "%s" "$VPN_TEST_CLIENT_PRIVATE_KEY" | wg pubkey)"
  export VPN_TEST_CLIENT_PRIVATE_KEY
  export VPN_TEST_CLIENT_PUBLIC_KEY
else
  log "Using VPN_TEST_CLIENT_* keys from environment."
fi

log "Building Docker images for core stack (web-app, control-plane, prometheus, vpn-node)..."
docker compose build web-app control-plane prometheus vpn-node

log "Bringing up core stack (postgres, control-plane, prometheus, web-app, vpn-node) in Docker..."
docker compose up -d postgres control-plane prometheus web-app vpn-node

log "Waiting for control-plane health on http://localhost:4000/health..."
until curl -sf http://localhost:4000/health >/dev/null 2>&1; do
  sleep 1
done
log "control-plane is healthy."

log "Waiting for vpn-node admin endpoint on http://localhost:9090/health..."
until curl -sf http://localhost:9090/health >/dev/null 2>&1; do
  sleep 1
done
log "vpn-node is healthy."

log "Running dockerized VPN test client (vpn-test-client)..."
if ! docker compose run --rm vpn-test-client; then
  error "Docker VPN connectivity test failed (vpn-test-client)."
fi

log "Docker VPN connectivity test passed (vpn-test-client)."
log "Running TypeScript local end-to-end checks..."
if ! (cd "$ROOT_DIR" && bun run test:local:e2e); then
  error "TypeScript local E2E tests failed."
fi

log "All local flow checks passed. Stack has been torn down."


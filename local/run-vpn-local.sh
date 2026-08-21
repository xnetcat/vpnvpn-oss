#!/bin/bash
set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[VPN]${NC} $1"
}

info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Ensure we are in the local directory
cd "$(dirname "$0")"

# Configuration
export API_URL="${API_URL:-http://localhost:8080}"
export VPN_TOKEN="${VPN_TOKEN:-dev-token}"
export LISTEN_UDP_PORT="${LISTEN_UDP_PORT:-51820}"
export ADMIN_PORT="${ADMIN_PORT:-9090}"
export RUST_LOG="${RUST_LOG:-info}"
export VPN_PROTOCOLS="${VPN_PROTOCOLS:-wireguard}"

log "VPN Server Local Runner"
info ""
info "Configuration:"
info "  API URL:       $API_URL"
info "  Token:         $VPN_TOKEN"
info "  UDP Port:      $LISTEN_UDP_PORT"
info "  Admin Port:    $ADMIN_PORT"
info "  Protocols:     $VPN_PROTOCOLS"
info ""

# Check if mock API is running
if ! curl -s "$API_URL/test/status" > /dev/null 2>&1; then
    error "Mock API is not running at $API_URL. Start it first with: cd mock-api && npm start"
fi

# Build VPN server
log "Building VPN server..."
cd ../vpn-server
if [ ! -f ./target/release/vpn-server ]; then
    cargo build --release
else
    log "Using existing release binary (run 'cargo build --release' to rebuild)"
fi

# Run doctor check
log "Running doctor check..."
sudo ./target/release/vpn-server doctor || error "Doctor check failed - ensure WireGuard is installed"

# Run server
log "Starting VPN server (requires sudo)..."
info "Press Ctrl+C to stop"
info ""

sudo -E ./target/release/vpn-server run \
    --api-url "$API_URL" \
    --token "$VPN_TOKEN" \
    --listen-port "$LISTEN_UDP_PORT" \
    --admin-port "$ADMIN_PORT"

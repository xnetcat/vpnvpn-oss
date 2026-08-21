#!/usr/bin/env bash
# =============================================================================
# VPN Node Setup Script
# =============================================================================
# Sets up a VPN node on a fresh Linux server.
# Installs Docker, configures NAT, and starts the VPN server container.
# Metrics are sent to the control plane (POST /metrics/vpn → Postgres).
#
# Usage: sudo -E bash setup-vpn-node.sh
#
# Required environment variables:
#   CONTROL_PLANE_URL   - Control plane API URL
#   VPN_TOKEN           - VPN node registration token
#
# Optional:
#   VPN_IMAGE           - Docker image (default: ghcr.io/xnetcat/vpnvpn/vpn-server:latest)
#   SERVER_ID           - Custom server ID (default: hostname)
#   ADMIN_API_TOKEN     - Bearer token enabling the node's gated admin endpoints
# =============================================================================

set -euo pipefail

: "${CONTROL_PLANE_URL:?CONTROL_PLANE_URL is required}"
: "${VPN_TOKEN:?VPN_TOKEN is required}"
VPN_IMAGE="${VPN_IMAGE:-ghcr.io/xnetcat/vpnvpn/vpn-server:latest}"
SERVER_ID="${SERVER_ID:-$(hostname)}"

echo "=== vpnVPN Node Setup ==="
echo "Control Plane: $CONTROL_PLANE_URL"
echo "Server ID: $SERVER_ID"
echo "Image: $VPN_IMAGE"

if ! command -v docker &>/dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
else
    echo "Docker already installed"
fi

echo "Enabling IP forwarding..."
sysctl -w net.ipv4.ip_forward=1
if ! grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf; then
    echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
fi

echo "Setting up NAT masquerading..."
DEFAULT_IFACE=$(ip route show default | awk '/default/ {print $5}' | head -1)
if [ -z "$DEFAULT_IFACE" ]; then
    DEFAULT_IFACE="eth0"
fi

iptables -t nat -C POSTROUTING -o "$DEFAULT_IFACE" -j MASQUERADE 2>/dev/null || \
    iptables -t nat -A POSTROUTING -o "$DEFAULT_IFACE" -j MASQUERADE

if command -v netfilter-persistent &>/dev/null; then
    netfilter-persistent save
elif command -v iptables-save &>/dev/null; then
    iptables-save > /etc/iptables.rules
fi

echo "Pulling VPN server image..."
docker pull "$VPN_IMAGE"

echo "Starting VPN server container..."
docker rm -f vpn-server 2>/dev/null || true

EXTRA_ENV_ARGS=()
if [ -n "${ADMIN_API_TOKEN:-}" ]; then
    echo "ADMIN_API_TOKEN set: node admin endpoints will be enabled"
    EXTRA_ENV_ARGS+=(-e ADMIN_API_TOKEN="$ADMIN_API_TOKEN")
fi

docker run -d \
    --name vpn-server \
    --restart unless-stopped \
    --network host \
    --cap-add NET_ADMIN \
    --device /dev/net/tun:/dev/net/tun \
    -e API_URL="$CONTROL_PLANE_URL" \
    -e VPN_TOKEN="$VPN_TOKEN" \
    -e SERVER_ID="$SERVER_ID" \
    -e METRICS_URL="${CONTROL_PLANE_URL}/metrics/vpn" \
    -e LISTEN_UDP_PORT=51820 \
    -e ADMIN_PORT=8080 \
    -e RUST_LOG=info \
    -e VPN_PROTOCOLS=wireguard,openvpn,ikev2 \
    ${EXTRA_ENV_ARGS[@]+"${EXTRA_ENV_ARGS[@]}" } \
    "$VPN_IMAGE"

echo ""
echo "=== Setup Complete ==="
echo "VPN server is running. Check status with:"
echo "  docker logs vpn-server"
echo "  curl http://localhost:8080/health"

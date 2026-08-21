#!/usr/bin/env bash
# Throughput benchmark (runs inside test-client). iperf3 server runs on vpn-node.
# Measures TCP throughput baseline (no tunnel) vs through each VPN protocol tunnel.
set -uo pipefail
CONTROL_PLANE_URL="${CONTROL_PLANE_URL:-http://control-plane:4000}"
API_KEY="${API_KEY:-e2e-test-api-key}"
DUR="${DUR:-10}"

bps() { # $1 = target ip/host -> Mbit/s (receiver side), or "FAIL"
  local out
  out=$(iperf3 -c "$1" -t "$DUR" -J 2>/dev/null) || { echo "FAIL"; return; }
  echo "$out" | jq -r '(.end.sum_received.bits_per_second // 0)/1000000 | floor'
}

echo "RESULT baseline_mbps=$(bps vpn-node)"

# ---------- WireGuard ----------
WGOK="no"; WGBPS="FAIL"
PRIV=$(wg genkey); PUB=$(echo "$PRIV" | wg pubkey)
curl -sf -X POST "$CONTROL_PLANE_URL/peers" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"publicKey\":\"$PUB\",\"userId\":\"bench-wg\",\"allowedIps\":[\"10.8.0.11/32\"]}" >/dev/null 2>&1
sleep 6
SPUB=$(curl -sf http://vpn-node:8080/pubkey | tr -d '"')
mkdir -p /etc/wireguard
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $PRIV
Address = 10.8.0.11/32
[Peer]
PublicKey = $SPUB
AllowedIPs = 10.8.0.0/24
Endpoint = vpn-node:51820
PersistentKeepalive = 15
EOF
if wg-quick up wg0 >/dev/null 2>&1 && ping -c 2 -W 5 10.8.0.1 >/dev/null 2>&1; then
  WGOK="yes"; WGBPS=$(bps 10.8.0.1)
fi
wg-quick down wg0 >/dev/null 2>&1 || true
echo "RESULT wireguard_connected=$WGOK wireguard_mbps=$WGBPS"

# ---------- OpenVPN ----------
OVOK="no"; OVBPS="FAIL"
OVUSER="bench-ovpn"; OVPASS="bench-ovpn-pass-$(date +%s)"
curl -sf -X POST "$CONTROL_PLANE_URL/peers" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"publicKey\":\"ovpn-$OVUSER\",\"userId\":\"$OVUSER\",\"allowedIps\":[\"10.9.0.11/32\"],\"username\":\"$OVUSER\",\"password\":\"$OVPASS\"}" >/dev/null 2>&1
sleep 5
CA=$(curl -sf "$CONTROL_PLANE_URL/servers" -H "X-API-Key: $API_KEY" | jq -r '.[0].ovpnCaBundle // empty')
cat > /tmp/ov.conf <<EOF
client
dev tun
proto udp
remote vpn-node 1194
resolv-retry infinite
nobind
persist-key
persist-tun
verb 1
auth-user-pass /tmp/ov.creds
EOF
[ -n "$CA" ] && { echo "<ca>"; echo "$CA"; echo "</ca>"; } >> /tmp/ov.conf
printf '%s\n%s\n' "$OVUSER" "$OVPASS" > /tmp/ov.creds; chmod 600 /tmp/ov.creds
openvpn --config /tmp/ov.conf --daemon --log /tmp/ov.log
for i in $(seq 1 30); do ip addr show tun0 2>/dev/null | grep -q "inet " && break; sleep 2; done
if ip addr show tun0 2>/dev/null | grep -q "inet " && ping -c 2 -W 5 10.9.0.1 >/dev/null 2>&1; then
  OVOK="yes"; OVBPS=$(bps 10.9.0.1)
fi
pkill openvpn >/dev/null 2>&1 || true; sleep 2
echo "RESULT openvpn_connected=$OVOK openvpn_mbps=$OVBPS"

# ---------- IKEv2 ----------
IKOK="no"; IKBPS="FAIL"
IKUSER="bench-ike"; IKPASS="bench-ike-pass-$(date +%s)"
curl -sf -X POST "$CONTROL_PLANE_URL/peers" -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d "{\"publicKey\":\"ikev2-$IKUSER\",\"userId\":\"$IKUSER\",\"allowedIps\":[\"10.9.0.21/32\"],\"username\":\"$IKUSER\",\"password\":\"$IKPASS\"}" >/dev/null 2>&1
sleep 5
mkdir -p /etc/swanctl/conf.d
cat > /etc/swanctl/conf.d/vpnvpn.conf <<EOF
connections {
  vpnvpn {
    remote_addrs = vpn-node
    vips = 0.0.0.0
    local  { auth = eap-mschapv2  eap_id = $IKUSER }
    remote { auth = pubkey }
    children { vpnvpn { remote_ts = 0.0.0.0/0  start_action = none } }
  }
}
secrets { eap-vpnvpn { id = $IKUSER  secret = "$IKPASS" } }
EOF
ipsec start >/dev/null 2>&1 || true; sleep 3
swanctl --load-all >/dev/null 2>&1 || true
if swanctl --initiate --child vpnvpn >/dev/null 2>&1; then
  sleep 2
  VIP=$(ip -4 addr show 2>/dev/null | grep -oE "10\.9\.0\.[0-9]+" | head -1)
  if ping -c 2 -W 5 10.9.0.1 >/dev/null 2>&1; then IKOK="yes"; IKBPS=$(bps 10.9.0.1); fi
  swanctl --terminate --ike vpnvpn >/dev/null 2>&1 || true
fi
ipsec stop >/dev/null 2>&1 || true
echo "RESULT ikev2_connected=$IKOK ikev2_mbps=$IKBPS"
echo "BENCH DONE"

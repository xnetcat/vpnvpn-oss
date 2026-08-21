#!/usr/bin/env bash
# Runs INSIDE a privileged client container on the VPN node.
# Measures TCP throughput (iperf3) for a no-tunnel baseline and through each
# VPN protocol tunnel (WireGuard, OpenVPN, IKEv2), plus a connectivity ping.
# Env: CONTROL_PLANE_URL, CP_API_KEY, USERID, PUBIP   (HOST defaults to docker gw)
set -uo pipefail
DUR="${DUR:-8}"
HOST="${HOST:-172.17.0.1}"          # host (docker0 gw) — WG/OpenVPN endpoints + baseline iperf3 server
PUBIP="${PUBIP:?}"                    # host public IP — IKEv2 endpoint (cert SAN match)

mbps() { local o; o=$(iperf3 -c "$1" -t "$DUR" -J 2>/dev/null) || { echo FAIL; return; }
         echo "$o" | jq -r '(.end.sum_received.bits_per_second//0)/1e6|floor'; }
reg()  { curl -s --max-time 15 -X POST "$CONTROL_PLANE_URL/peers" -H "x-api-key: $CP_API_KEY" \
              -H "Content-Type: application/json" -d "$1" -o /dev/null -w "%{http_code}"; }
ping_ok() { ping -c3 -W2 "$1" >/dev/null 2>&1 && echo OK || echo FAIL; }

SERVER_PUB=$(curl -s "http://$HOST:8080/pubkey" | tr -d '"')
CA=$(curl -s "$CONTROL_PLANE_URL/servers" -H "x-api-key: $CP_API_KEY" | jq -r '.[]|select(.id=="openclaw")|.ovpnCaBundle//empty')

echo "RESULT baseline mbps=$(mbps "$HOST")"

# ---------------- WireGuard ----------------
PRIV=$(wg genkey); PUB=$(printf '%s' "$PRIV" | wg pubkey)
RC=$(reg "{\"publicKey\":\"$PUB\",\"userId\":\"$USERID\",\"allowedIps\":[\"10.8.0.61/32\"]}"); sleep 6
mkdir -p /etc/wireguard
cat >/etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = $PRIV
Address = 10.8.0.61/32
[Peer]
PublicKey = $SERVER_PUB
AllowedIPs = 10.8.0.0/24
Endpoint = $HOST:51820
PersistentKeepalive = 15
EOF
WOK=no; WP=FAIL; WB=FAIL
if wg-quick up wg0 >/dev/null 2>&1; then WP=$(ping_ok 10.8.0.1); WB=$(mbps 10.8.0.1); WOK=yes; fi
wg-quick down wg0 >/dev/null 2>&1 || true
echo "RESULT wireguard reg=$RC connected=$WOK ping=$WP mbps=$WB"

# ---------------- OpenVPN ----------------
# NOTE: if the server uses tls-crypt, the client config also needs the server's
# tls-crypt key in a <tls-crypt>...</tls-crypt> block (not exposed via the API),
# otherwise the handshake is silently dropped. Supply it via $TLSCRYPT if needed.
OU=ovpn-bench; OP=ovpnpass-$$-$RANDOM
RC=$(reg "{\"publicKey\":\"ovpn-$OU\",\"userId\":\"$USERID\",\"allowedIps\":[\"10.9.0.61/32\"],\"username\":\"$OU\",\"password\":\"$OP\"}"); sleep 6
cat >/ov.conf <<EOF
client
dev tun
proto udp
remote $HOST 1194
nobind
persist-key
persist-tun
auth-user-pass /ov.creds
verb 1
EOF
[ -n "$CA" ] && { printf '<ca>\n%s\n</ca>\n' "$CA" >>/ov.conf; }
printf '%s\n%s\n' "$OU" "$OP" >/ov.creds; chmod 600 /ov.creds
OOK=no; OPi=FAIL; OB=FAIL
openvpn --config /ov.conf --daemon --log /ov.log
for i in $(seq 1 25); do ip a show tun0 2>/dev/null | grep -q "inet " && break; sleep 1; done
if ip a show tun0 2>/dev/null | grep -q "inet "; then OPi=$(ping_ok 10.9.0.1); OB=$(mbps 10.9.0.1); OOK=yes; fi
pkill openvpn 2>/dev/null || true; sleep 2
echo "RESULT openvpn reg=$RC connected=$OOK ping=$OPi mbps=$OB"
[ "$OOK" = no ] && echo "OV_LOG:" && tail -4 /ov.log 2>/dev/null

# ---------------- IKEv2 ----------------
IU=ike-bench; IP_=ikepass-$$-$RANDOM
RC=$(reg "{\"publicKey\":\"ikev2-$IU\",\"userId\":\"$USERID\",\"allowedIps\":[\"10.9.0.71/32\"],\"username\":\"$IU\",\"password\":\"$IP_\"}"); sleep 6
mkdir -p /etc/swanctl/x509ca /etc/swanctl/conf.d
[ -n "$CA" ] && printf '%s\n' "$CA" >/etc/swanctl/x509ca/ca.pem
cat >/etc/swanctl/conf.d/vpnvpn.conf <<EOF
connections {
  vpnvpn {
    remote_addrs = $PUBIP
    vips = 0.0.0.0
    local  { auth = eap-mschapv2  eap_id = $IU }
    remote { auth = pubkey }
    children { vpnvpn { remote_ts = 0.0.0.0/0  start_action = none } }
  }
}
secrets { eap-vpnvpn { id = $IU  secret = "$IP_" } }
EOF
IOK=no; IPi=FAIL; IB=FAIL
(/usr/lib/ipsec/charon >/charon.log 2>&1 &) ; sleep 4
swanctl --load-all >/dev/null 2>&1
if swanctl --initiate --child vpnvpn >/swanctl.log 2>&1; then
  sleep 2; IPi=$(ping_ok 10.9.0.1); IB=$(mbps 10.9.0.1); IOK=yes
  swanctl --terminate --ike vpnvpn >/dev/null 2>&1 || true
fi
echo "RESULT ikev2 reg=$RC connected=$IOK ping=$IPi mbps=$IB"
[ "$IOK" = no ] && echo "IKE_LOG:" && tail -5 /swanctl.log 2>/dev/null
echo "BENCH_DONE"

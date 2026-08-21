const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Load .env first
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

// Use DATABASE_URL from env, fallback to Docker default only if missing
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:password@localhost:5432/vpnvpn";

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });

function getControlPlaneConfig() {
  // Use standard env vars if available, fallback to local defaults
  const base =
    process.env.CONTROL_PLANE_API_URL ||
    process.env.LOCAL_CONTROL_PLANE_URL ||
    "http://localhost:4000";
  const apiKey =
    process.env.CONTROL_PLANE_API_KEY ||
    process.env.LOCAL_CONTROL_PLANE_API_KEY ||
    "dev-control-plane-key";
  return { base, apiKey };
}

async function fetchServers({ base, apiKey }) {
  const normalized = base.replace(/\/$/, "");
  const serverUrl = `${normalized}/servers`;
  const res = await fetch(serverUrl, { headers: { "x-api-key": apiKey } });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`/servers failed: ${res.status} ${res.statusText} ${body}`);
  }
  return JSON.parse(body);
}

async function pickServerOrSkip(kind) {
  const { base, apiKey } = getControlPlaneConfig();
  let servers;
  try {
    servers = await fetchServers({ base, apiKey });
  } catch (err) {
    throw new Error(
      `[${kind}] control-plane unreachable or unauthorized. Set CONTROL_PLANE_API_URL and CONTROL_PLANE_API_KEY. Error: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
  if (!Array.isArray(servers) || servers.length === 0) {
    console.warn(`[skip ${kind}] no servers returned from control-plane`);
    return null;
  }
  return servers;
}

function ensureKeyPair() {
  const priv = spawnSync("wg", ["genkey"], { encoding: "utf8" });
  if (priv.status !== 0 || !priv.stdout.trim()) {
    throw new Error(
      `failed to generate WireGuard private key: ${priv.stderr || priv.stdout}`
    );
  }
  const privKey = priv.stdout.trim();
  const pub = spawnSync("wg", ["pubkey"], { input: privKey, encoding: "utf8" });
  if (pub.status !== 0 || !pub.stdout.trim()) {
    throw new Error(
      `failed to derive WireGuard public key: ${pub.stderr || pub.stdout}`
    );
  }
  return { privKey, pubKey: pub.stdout.trim() };
}

describe("control-plane -> docker WG ping", () => {
  test("fetch server, register peer, ping google.com", async () => {
    const { base: controlPlaneBase, apiKey: controlPlaneApiKey } =
      getControlPlaneConfig();
    const base = controlPlaneBase.replace(/\/$/, "");

    const servers = await pickServerOrSkip("wireguard");
    if (!servers) return;

    // Sort servers by lastSeen desc (to avoid stale servers)
    servers.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

    const server =
      servers.find((s) => (s.wgEndpoint || s.publicIp) && s.publicKey) ||
      servers[0];
    if (!server || !server.publicKey) {
      throw new Error("no WireGuard-capable server found");
    }
    if (!server.wgEndpoint && !server.publicIp) {
      throw new Error("missing wg endpoint/publicIp");
    }

    const { privKey, pubKey } = ensureKeyPair();
    const clientAddress = process.env.VPN_CLIENT_ADDRESS || "10.8.0.2/32";

    // Use hardcoded test user ID from Docker Postgres
    // Ensure the user exists by inserting if not present (via docker exec)
    let TEST_USER_ID = "cmj1tev8400008zvh9cht8mec";
    const TEST_USER_EMAIL = "local-jest@vpnvpn.dev";
    const TEST_USER_NAME = "Local Jest User";

    try {
      await prisma.user.upsert({
        where: { email: TEST_USER_EMAIL },
        update: {},
        create: {
          id: TEST_USER_ID,
          email: TEST_USER_EMAIL,
          name: TEST_USER_NAME,
          role: "user",
        },
      });
      console.log("[test] Test user ensured in database via Prisma");
    } catch (e) {
      console.error("[test] Failed to ensure test user:", e);
      throw e;
    }

    // Verify user exists and get actual ID (in case it differs from hardcoded one)
    const user = await prisma.user.findUnique({
      where: { email: TEST_USER_EMAIL },
    });
    console.log(
      "[test] Verified user in DB:",
      user ? "FOUND" : "NOT FOUND",
      user
    );

    // Update TEST_USER_ID to the actual one in the DB
    if (user) {
      TEST_USER_ID = user.id;
    } else {
      throw new Error("User not found after upsert!");
    }

    const peerRequestBody = {
      publicKey: pubKey,
      userId: TEST_USER_ID,
      allowedIps: [clientAddress],
      serverId: server.id,
    };
    console.log(
      "[test] Using DATABASE_URL:",
      DATABASE_URL.replace(/:[^:@]+@/, ":***@")
    );

    console.log(
      `[test] Registering peer with body: ${JSON.stringify(peerRequestBody, null, 2)}`
    );
    const addPeerRes = await fetch(`${controlPlaneBase}/peers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": controlPlaneApiKey,
      },
      body: JSON.stringify(peerRequestBody),
    });
    const addPeerBody = await addPeerRes.text();
    if (!addPeerRes.ok) {
      await prisma.$disconnect();
      throw new Error(
        `/peers failed: ${addPeerRes.status} ${addPeerRes.statusText} ${addPeerBody}`
      );
    }

    // Wait for vpn-node to sync peers from control-plane (sync interval is 10 seconds)
    console.log("[test] Waiting 12s for vpn-node to sync peer...");
    await new Promise((resolve) => setTimeout(resolve, 12000));

    const endpointHost = server.wgEndpoint || server.publicIp;
    const endpointPort = server.wgPort || 51820;
    if (!endpointHost) {
      throw new Error("server missing endpoint");
    }

    const script = `
# Install dependencies for Alpine
apk update && apk add --no-cache bash wireguard-tools iproute2 curl iptables

set -euo pipefail
trap 'ip route del 0.0.0.0/0 dev wg-test 2>/dev/null || true; ip link del wg-test 2>/dev/null || true; rm -f /tmp/wg-privkey' EXIT

# Step 1: Get public IP BEFORE connecting to VPN
echo "[client] Getting public IP before VPN connection..."
BEFORE_IP=$(curl -sf --connect-timeout 10 https://api.ipify.org || curl -sf --connect-timeout 10 https://ifconfig.me/ip || echo "unknown")
echo "[client] Public IP before VPN: $BEFORE_IP"

# Step 2: Set up WireGuard VPN connection (using wg-test interface to avoid conflict with server's wg0)
echo "[client] Setting up WireGuard VPN..."
# Clean up any existing wg-test interface from previous runs
ip link del wg-test 2>/dev/null || true

# Resolve __GATEWAY__ endpoint if needed (for bridge mode testing)
if [ "${"$"}{VPN_SERVER_ENDPOINT}" = "__GATEWAY__" ]; then
  VPN_SERVER_ENDPOINT=$(ip route show | grep default | awk '{print $3}')
  echo "[client] Resolved __GATEWAY__ to $VPN_SERVER_ENDPOINT"
fi

ip link add wg-test type wireguard
printf "%s" "${"$"}{VPN_TEST_CLIENT_PRIVATE_KEY}" > /tmp/wg-privkey
wg set wg-test \\
  private-key /tmp/wg-privkey \\
  peer "${"$"}{VPN_SERVER_PUBLIC_KEY}" \\
  allowed-ips "${"$"}{VPN_ALLOWED_IPS:-0.0.0.0/0,::/0}" \\
  endpoint "${"$"}{VPN_SERVER_ENDPOINT}:${"$"}{VPN_SERVER_PORT:-51820}" \\
  persistent-keepalive "${"$"}{VPN_PERSISTENT_KEEPALIVE:-15}"

ip addr add "${"$"}{VPN_CLIENT_ADDRESS:-10.8.0.2/32}" dev wg-test
ip link set mtu 1280 dev wg-test
ip link set wg-test up

# Keep route to VPN server off-tunnel, route everything else through VPN
ip route add "${"$"}{VPN_SERVER_ENDPOINT}/32" dev eth0 2>/dev/null || true
ip route replace 0.0.0.0/0 dev wg-test

echo "nameserver 1.1.1.1" > /etc/resolv.conf

echo "[client] WireGuard interface info:"
wg show wg-test

# Step 3: Wait for handshake and verify connection
echo "[client] Waiting for VPN handshake..."
sleep 3

# Check if handshake succeeded by looking at transfer stats
WG_OUTPUT=$(wg show wg-test)
echo "[client] WireGuard status after handshake wait:"
echo "$WG_OUTPUT"

# Extract bytes received (should be > 0 if handshake succeeded)
BYTES_RECEIVED=$(echo "$WG_OUTPUT" | grep "transfer:" | awk '{print $2}' | sed 's/[^0-9]//g')
if [ -z "$BYTES_RECEIVED" ] || [ "$BYTES_RECEIVED" = "0" ]; then
  echo "[client] FAILED: VPN handshake did not complete (0 bytes received)"
  exit 1
fi
echo "[client] SUCCESS: VPN handshake completed ($BYTES_RECEIVED bytes received)"

# Try pinging the VPN server's internal IP (10.8.0.1) through the tunnel
# This bypasses Docker NAT limitations and verifies encrypted tunnel traffic
echo "[client] Testing VPN tunnel connectivity (ping 10.8.0.1)..."
if ping -c 3 10.8.0.1; then
  echo "[client] SUCCESS: VPN tunnel connectivity verified!"
  VPN_TUNNEL_WORKS="yes"
else
  echo "[client] WARNING: Cannot reach VPN server internal IP (10.8.0.1). This might be firewall blocking ICMP."
  VPN_TUNNEL_WORKS="partial"
  # Do not exit, try internet connectivity
fi

# Also try pinging 8.8.8.8 - internet forwarding must work
echo "[client] Testing VPN internet connectivity (curl Google)..."
if curl -s --max-time 5 http://www.google.com > /dev/null; then
  echo "[client] SUCCESS: Internet connectivity through VPN works!"
  INTERNET_VIA_VPN="yes"
else
  echo "[client] FAILED: Cannot reach www.google.com through VPN"
  INTERNET_VIA_VPN="no"
  exit 1
fi

# For local testing, just verify the VPN tunnel is established
echo ""
echo "=== VPN VERIFICATION RESULT ==="
echo "IP Before VPN: $BEFORE_IP"
echo "VPN Handshake: SUCCESS ($BYTES_RECEIVED bytes)"
echo "Internet via VPN: $INTERNET_VIA_VPN"
echo '{"before_ip":"'$BEFORE_IP'","bytes_received":"'$BYTES_RECEIVED'","internet_via_vpn":"'$INTERNET_VIA_VPN'","status":"success"}'
exit 0
`;

    // Use bridge network mode to avoid routing loops
    // The vpn-node runs with network_mode: host, so we access it via the bridge gateway if targeting localhost
    const useHostNetwork = false;

    const targetHost = server.wgEndpoint || server.publicIp;
    const isLocalTarget =
      targetHost === "127.0.0.1" || targetHost === "localhost";

    const effectiveEndpoint =
      isLocalTarget && !useHostNetwork ? "__GATEWAY__" : targetHost;

    const result = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--cap-add=NET_ADMIN",
        "--device",
        "/dev/net/tun",
        "--entrypoint",
        "/bin/sh",
        "-e",
        "VPN_ALLOWED_IPS",
        "-e",
        "VPN_PING_TARGET",
        "-e",
        "VPN_PERSISTENT_KEEPALIVE",
        "-e",
        "VPN_CLIENT_DNS",
        "-e",
        "VPN_CLIENT_ADDRESS",
        "-e",
        "VPN_TEST_CLIENT_PRIVATE_KEY",
        "-e",
        "VPN_SERVER_PUBLIC_KEY",
        "-e",
        "VPN_SERVER_ENDPOINT",
        "-e",
        "VPN_SERVER_PORT",
        "alpine:latest",
        "-c",
        script,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CONTROL_PLANE_API_KEY: controlPlaneApiKey,
          CONTROL_PLANE_API_URL: controlPlaneBase,
          VPN_TEST_CLIENT_PRIVATE_KEY: privKey,
          VPN_SERVER_PUBLIC_KEY: server.publicKey,
          VPN_SERVER_ENDPOINT: effectiveEndpoint,
          VPN_SERVER_PORT: String(endpointPort),
          VPN_ALLOWED_IPS: "0.0.0.0/0,::/0",
          VPN_PING_TARGET: "google.com",
          VPN_CLIENT_ADDRESS: clientAddress,
        },
        timeout: 60_000,
      }
    );

    if (result.status !== 0) {
      await prisma.$disconnect();
      throw new Error(
        `docker wg ping failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      );
    }
    await prisma.$disconnect();
  }, 120_000);
});

describe("openvpn metadata", () => {
  test("control-plane exposes ovpn bundle", async () => {
    const { base: controlPlaneBase, apiKey: controlPlaneApiKey } =
      getControlPlaneConfig();
    const servers = await pickServerOrSkip("openvpn");
    const server =
      servers.find(
        (s) => s.ovpnCaBundle || (s.metadata && s.metadata.ovpnCaBundle)
      ) || servers[0];

    console.log(
      "[test] OpenVPN server object:",
      JSON.stringify(server, null, 2)
    );

    if (
      !server ||
      (!server.ovpnCaBundle &&
        !(server.metadata && server.metadata.ovpnCaBundle))
    ) {
      throw new Error("missing openvpn metadata");
    }

    // (Ping check removed as Staging SG blocks ICMP)
  }, 120000);
});

describe("ikev2 metadata and ipsec smoke", () => {
  test("control-plane exposes ikev2Remote metadata", async () => {
    const { base: controlPlaneBase, apiKey: controlPlaneApiKey } =
      getControlPlaneConfig();
    const servers = await pickServerOrSkip("ikev2");
    const server =
      servers.find(
        (s) => s.ikev2Remote || (s.metadata && s.metadata.ikev2Remote)
      ) || servers[0];

    if (
      !server ||
      (!server.ikev2Remote &&
        (!server.metadata || !server.metadata.ikev2Remote))
    ) {
      console.error("Servers state:", JSON.stringify(servers, null, 2));
      throw new Error("No server found with ikev2Remote");
    }

    // Verify format (IP:Port)
    const remote = server.ikev2Remote || server.metadata.ikev2Remote;
    expect(remote).toMatch(/^[\d\.]+:500$/);
  }, 120000);
});

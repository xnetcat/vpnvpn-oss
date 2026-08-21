# Local Development Features

This document describes the dockerized VPN connectivity test for vpnVPN.

## 🎯 Overview

`./test-flow.sh` runs a **single, dockerized end-to-end VPN connectivity test**:

- Starts a `vpn-node` container (Rust VPN server with WireGuard).
- Starts a `vpn-test-client` container.
- The test client:
  - Fetches the server WireGuard public key via `http://vpn-node:9090/pubkey`.
  - Brings up its own `wg0` interface.
  - Pings `10.8.0.1` through the tunnel.
- The script exits non‑zero if VPN connectivity fails.

## 🚀 Quick Start

```bash
cd local
export VPN_TEST_CLIENT_PRIVATE_KEY="base64-private-key"
export VPN_TEST_CLIENT_PUBLIC_KEY="base64-public-key"
./test-flow.sh
```

If the command exits with status `0`, the dockerized VPN connectivity test passed.

## 🔧 Configuration

Required environment variables:

- `VPN_TEST_CLIENT_PRIVATE_KEY` – WireGuard client private key.
- `VPN_TEST_CLIENT_PUBLIC_KEY` – WireGuard client public key.

Generate keys with:

```bash
wg genkey | tee client.key | wg pubkey > client.pub
export VPN_TEST_CLIENT_PRIVATE_KEY="$(cat client.key)"
export VPN_TEST_CLIENT_PUBLIC_KEY="$(cat client.pub)"
```

## 🧩 How It Works

- `local/compose.yaml` defines:
  - `vpn-node` – runs `vpn-server` with WireGuard enabled and a static test peer.
  - `vpn-test-client` – minimal container that:
    - Waits for `vpn-node` admin health.
    - Reads server public key from `/pubkey`.
    - Writes `/etc/wireguard/wg0.conf`.
    - Runs `wg-quick up wg0` and `ping 10.8.0.1`.
- `vpn-server` exposes:
  - `/health` – health check.
  - `/status` – backend metrics.
  - `/pubkey` – WireGuard server public key used by the test client.

## 🐛 Troubleshooting

- **Test script fails immediately**:

  - Ensure Docker is running.
  - Ensure both `VPN_TEST_CLIENT_PRIVATE_KEY` and `VPN_TEST_CLIENT_PUBLIC_KEY` are set.

- **VPN test fails (non‑zero exit)**:

  Check container logs:

```bash
cd local
docker compose up --build vpn-node vpn-test-client
```

Look at the output around WireGuard bring‑up and `ping` results.

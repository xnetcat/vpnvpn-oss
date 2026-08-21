# Deployment Guide

This guide details the CI/CD pipelines and manual deployment procedures for vpnVPN.

## CI/CD Pipelines (GitHub Actions)

### 1. Backend Deployment (`deploy-backend.yml`)

**Triggers:**

- Push to `main` or `staging` (when `apps/vpn-server/**` changes).
- Manual `workflow_dispatch`.

**Workflow:**

1. Builds VPN server Docker image.
2. Pushes to GHCR (`ghcr.io/xnetcat/vpnvpn/vpn-server`).

The control plane auto-deploys via Railway when code is pushed to main/staging.

### 2. Desktop Build (`desktop-build.yml`)

**Triggers:**

- Push to `main` or `staging` affecting `apps/desktop`.
- Manual `workflow_dispatch`.

**Workflow:**

1. Matrix builds for macOS (arm64/x64), Linux x64, Windows x64.
2. Builds Tauri app with signing.
3. Uploads artifacts to GitHub Releases.

### 3. E2E Tests (`e2e.yml`)

**Triggers:**

- Push to `main` or `staging` and PRs.

**Workflow:**

1. Runs Rust unit tests (`cargo test`).
2. Runs TypeScript tests (`bun run test`).
3. Runs Docker-based E2E test suite (`e2e/run-e2e.sh`).

### 4. CI Checks (`ci.yml`)

**Triggers:**

- Push to `main` or `staging` and PRs.

**Workflow:**

- Runs `lint`, `test`, and `build` for the entire monorepo.

---

## Control Plane Deployment (Railway)

The control plane deploys automatically via Railway's GitHub integration.

### Setup

1. Create a Railway project and link it to the GitHub repository.
2. Configure the service to use `services/control-plane/Dockerfile`.
3. Set environment variables:
   - `DATABASE_URL` - PostgreSQL connection string (Neon)
   - `CONTROL_PLANE_API_KEY` - API key for web app auth
   - `CONTROL_PLANE_BOOTSTRAP_TOKEN` - Initial VPN node token
   - `PORT` - 4000
4. (Optional) Configure a custom domain (e.g. `api.vpnvpn.dev`) → control-plane service — requires a paid Railway plan.

The `railway.toml` at the project root configures build settings and health checks.

---

## VPN Node Deployment (Manual)

VPN nodes are deployed manually on cloud VMs (any provider).

### Quick Setup

```bash
# Set required environment variables
export CONTROL_PLANE_URL="https://vpnvpn-control-plane-staging.up.railway.app"
export VPN_TOKEN="your-vpn-node-token"

# Run the setup script
sudo -E bash scripts/setup-vpn-node.sh
```

### What the Script Does

1. Installs Docker.
2. Enables IP forwarding and configures NAT masquerading.
3. Pulls and runs the VPN server container with host networking.

### Manual VPN Server

```bash
docker pull ghcr.io/xnetcat/vpnvpn/vpn-server:latest

docker run -d \
    --name vpn-server \
    --restart unless-stopped \
    --network host \
    --cap-add NET_ADMIN \
    --device /dev/net/tun:/dev/net/tun \
    -e API_URL="https://vpnvpn-control-plane-staging.up.railway.app" \
    -e VPN_TOKEN="your-token" \
    -e SERVER_ID="$(hostname)" \
    -e METRICS_URL="https://vpnvpn-control-plane-staging.up.railway.app/metrics/vpn" \
    -e VPN_PROTOCOLS=wireguard,openvpn,ikev2 \
    ghcr.io/xnetcat/vpnvpn/vpn-server:latest
```

### Verify

```bash
curl http://localhost:8080/health
curl http://localhost:8080/metrics
```

---

## Branching Strategy

- **`main`**: Production branch. Deploys to `vpnvpn.dev`. Protected branch.
- **`staging`**: Staging branch. Deploys to `staging.vpnvpn.dev`. Used for integration testing.
- **Feature Branches**: Created from `staging` or `main`. PRs trigger CI checks.

# Architecture Overview

vpnVPN is a Bun/Turborepo monorepo with a TypeScript/Postgres control plane and Rust VPN data plane.

## Apps

### `apps/web`

Next.js 15 SaaS frontend hosted on Vercel.

- tRPC for type-safe API calls
- NextAuth.js for authentication (GitHub, Google, Email)
- Stripe for subscriptions
- Resend for transactional emails
- Prisma + PostgreSQL for data persistence

### `apps/desktop`

Tauri desktop client with a privileged Rust daemon for VPN management.

**Architecture:**

```
┌─────────────────┐   IPC (JSON-RPC)   ┌──────────────────┐
│   Tauri GUI     │ ◄───────────────► │  Daemon (Rust)   │
│ (unprivileged)  │   Unix Socket      │  (privileged)    │
└─────────────────┘                    └──────────────────┘
        │                                      │
        │ React + Vite                         │ VPN Backends
        ▼                                      ▼
┌─────────────────┐                    ┌──────────────────┐
│   Web UI        │                    │ wg-quick/openvpn │
│                 │                    │ strongSwan/IKEv2 │
└─────────────────┘                    └──────────────────┘
```

**Key Features:**

- React + Vite frontend bundled into Tauri native app
- Privileged daemon handles VPN operations (requires root/admin)
- IPC via Unix socket (`/var/run/vpnvpn-daemon.sock` production, `/tmp/vpnvpn-daemon.sock` dev)
- Deep link support for `vpnvpn://` protocol
- Supports WireGuard, OpenVPN, and IKEv2 protocols
- Built for macOS, Linux, and Windows

See `apps/desktop/DEVELOPMENT.md` for daemon development details.

### `apps/vpn-server`

Rust VPN node binary supporting WireGuard, OpenVPN, and IKEv2.

- Generates and persists WireGuard server keys
- Shared PKI for OpenVPN and IKEv2 certificates
- Registers with control plane via `POST /server/register`
- Periodically fetches peers via `GET /server/peers`
- Applies peers to WireGuard/OpenVPN/IKEv2 backends
- Exposes admin API (`/health`, `/metrics`, `/status`, `/pubkey`) on `ADMIN_PORT`
- IKEv2 uses EAP-MSCHAPv2 for username/password auth
- OpenVPN uses tls-crypt and hashed credentials
- WireGuard supports PersistentKeepalive, MTU 1420, IPv6

## Services

### `services/control-plane`

Bun + Fastify HTTP API backed by Postgres via `@vpnvpn/db`.

**Deployment:** Railway (auto-deploys from GitHub).

**Endpoints:**

| Endpoint                      | Description                                          |
| ----------------------------- | ---------------------------------------------------- |
| `POST /server/register`       | VPN node self-registration (bearer token auth)       |
| `GET /server/peers`           | Fetch peers assigned to a server (bearer token auth) |
| `GET /servers`                | List all servers with metrics (API key auth)         |
| `DELETE /servers/:id`         | Delete a VPN server (API key auth)                   |
| `POST /peers`                 | Create/update a user peer (API key auth)             |
| `POST /peers/revoke-for-user` | Revoke all peers for a user (API key auth)           |
| `DELETE /peers/:publicKey`    | Revoke a specific peer (API key auth)                |
| `GET /tokens`                 | List all VPN node tokens (API key auth)              |
| `POST /tokens`                | Create a new token (API key auth)                    |
| `DELETE /tokens/:id`          | Revoke a token by id (API key auth)                  |
| `POST /admin/tokens`          | Alias of `POST /tokens` (API key auth)               |
| `DELETE /admin/tokens/:id`    | Alias of `DELETE /tokens/:id` (API key auth)         |
| `POST /metrics/vpn`           | Ingest VPN server metrics (Bearer node token)        |
| `GET /metrics/targets`        | Prometheus http_sd target list (API key via `x-api-key` or `Authorization: Bearer`) |

**Security:** Bearer tokens for VPN nodes, `x-api-key` header for web app calls.

## Shared Database

### `packages/db`

Prisma schema and client for:

- **SaaS data:** users, sessions, accounts, subscriptions, devices, notification preferences
- **Control plane:** VpnServer, VpnPeer, VpnToken, VpnMetric

Uses `DATABASE_URL` (Neon in production, Postgres in local Docker).

## Observability

There are two complementary metrics paths:

**1. Application metrics (control plane + dashboard).** VPN nodes periodically POST
metrics (CPU, memory, active peers) to the control plane's `POST /metrics/vpn`
endpoint. These are stored in the `VpnMetric` table in PostgreSQL (Neon/Railway).
The web dashboard's `analytics.*` tRPC router queries this table for real-time
server status, protocol distribution, and usage trends.

**2. Prometheus + Grafana stack (deployed).** Each VPN node exposes a
Prometheus-format `/metrics` endpoint on its admin port. A Prometheus instance
(`infra/prometheus/`, deployed to Railway) scrapes the fleet, auto-discovering
nodes through the control plane's `GET /metrics/targets` HTTP service-discovery
(http_sd) endpoint — nodes appear and disappear as they register, with a static
target list supported as a fallback. Grafana visualizes the scraped data.

For local development the same stack is wired into `local/compose.yaml`:
Prometheus on `:9091` and Grafana on `:3001` (with an auto-provisioned dashboard
under `local/grafana/provisioning/`).

## Frontend Integration

The web app uses tRPC routers to:

- Manage devices, subscriptions, and admin actions
- Call the control-plane service via `lib/controlPlane.ts` using `CONTROL_PLANE_API_URL` + `CONTROL_PLANE_API_KEY`

### Device Registration Flow

1. User clicks "Add Device" in the dashboard
2. Server generates a WireGuard keypair
3. Device record is stored in Postgres
4. Control-plane service is called to create the peer
5. Client config is rendered for download/QR code

## Deployment

### Web App

Deployed to Vercel with environment variables configured in the Vercel dashboard.

### Control Plane (Railway)

Deployed as a Docker container on Railway:

- Auto-deploys from GitHub on push to main/staging
- `railway.toml` configures the build and health check
- Public URL: `https://vpnvpn-control-plane-staging.up.railway.app` (custom domain optional; requires a paid Railway plan)
- Environment variables: `DATABASE_URL`, `CONTROL_PLANE_API_KEY`, `CONTROL_PLANE_BOOTSTRAP_TOKEN`, `PORT`

### VPN Server

Docker images pushed to GHCR (`ghcr.io/xnetcat/vpnvpn/vpn-server`).

VPN nodes are deployed manually on cloud VMs:

- Use `scripts/setup-vpn-node.sh` to provision a new node
- Each node runs the VPN server container with host networking
- Nodes self-register with the control plane
- Metrics POSTed to control plane and stored in Postgres

### Desktop App

Built and distributed via GitHub Releases:

- Multi-platform builds (macOS, Linux, Windows)
- Automated builds via GitHub Actions
- Download links on web app landing page

## Data Flow

```
┌────────────────────────────────────────────────────────────────────────┐
│                              User                                        │
└────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌──────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌───────────┐   ┌───────────┐   ┌───────────┐
            │  Web App  │   │  Desktop  │   │ WireGuard │
            │ (Vercel)  │   │  (Tauri)  │   │  Client   │
            └───────────┘   └───────────┘   └───────────┘
                    │               │               │
                    └──────────────┼───────────────┘
                                    │
                            ┌───────▼───────┐
                            │   Control     │
                            │   Plane       │
                            │  (Railway)    │
                            └───────┬───────┘
                                    │
                            ┌───────▼───────┐
                            │   PostgreSQL  │
                            │    (Neon)     │
                            └───────────────┘
                                    ▲
                                    │
                            ┌───────┴───────┐
                            │  VPN Servers  │
                            │  (Manual VMs) │
                            └───────────────┘
```

## Security Model

### Authentication Layers

1. **Web App:** NextAuth.js with OAuth providers and magic links
2. **Control Plane (Web):** API key in `x-api-key` header
3. **Control Plane (VPN):** Bearer token for node registration
4. **VPN Protocols:**
   - WireGuard: public key + optional PSK encryption
   - OpenVPN: tls-crypt + hashed username/password auth
   - IKEv2: EAP-MSCHAPv2 over pubkey-authenticated tunnel

### Data Protection

- No traffic logging on VPN nodes
- Minimal metadata collection (session counts, public keys)
- End-to-end encryption for all VPN traffic
- TLS for all API communication
- OpenVPN credentials stored as SHA-256 hashes

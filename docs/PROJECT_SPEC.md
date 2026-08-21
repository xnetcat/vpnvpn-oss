# vpnVPN — Project Documentation and Specification

## 1. Executive Summary

vpnVPN is a privacy-first, verified-data-flow VPN SaaS platform. It lets customers subscribe to encrypted VPN access, choose exit locations, and manage their devices, while operators manage a global fleet of VPN nodes across EC2, VPS, or bare metal.

Key pillars:

- **Privacy & Security:** No traffic logging, strong modern ciphers (WireGuard, OpenVPN, IKEv2), end-to-end TLS on control APIs, and a minimal-metadata model.
- **Universal Deployment:** Node agent (`vpn-server`) runs as a binary or Docker container on Linux, macOS, and Windows hosts.
- **Full SaaS Frontend:** Production-grade Next.js app on Vercel for marketing, signup, billing, user dashboards, and admin operations.
- **Verifiable Data Flow:** All cross-service communication is explicit, documented, and testable end-to-end.

## 2. System Architecture

### 2.1 Frontend App (`apps/web`)

Full-stack Next.js SaaS application hosted on **Vercel**.

- **Roles**
  - Public: landing, pricing, docs, signup/login.
  - User: dashboard to view subscription status, manage devices, download configs/QR codes, pick servers/regions.
  - Admin: secure panel to monitor the fleet, manage users and peers, issue/revoke node tokens.
- **SaaS Capabilities**
  - **Authentication:** NextAuth.js with GitHub, Google, and email (magic link).
  - **Billing:** Stripe subscriptions (checkout, portal, webhooks) for multi-tier plans.
  - **Notifications:** Transactional email via Resend.
  - **Access Control:** RBAC and subscription gating for paid endpoints.
- **Tech Stack**
  - Next.js App Router, React, TypeScript, Tailwind CSS, tRPC, Prisma + PostgreSQL, Stripe.

### 2.2 Control Plane (`services/control-plane`)

Bun/Fastify HTTP API backed by PostgreSQL via Prisma.

- **Responsibilities**
  - **Server Registry:** VPN nodes self-register and can be listed.
  - **Peer Management:** Stores and serves allowed peers to nodes.
  - **Token Management:** Issue and revoke node registration tokens.
- **Endpoints**
  - `POST /server/register` — Node registration (bearer token auth).
  - `GET /server/peers` — Peer list for a server (bearer token auth).
  - `GET /servers` — List all servers (API key auth).
  - `POST /peers` — Create/update peer (API key auth).
  - `POST /peers/revoke-for-user` — Revoke all peers for a user (API key auth).
  - `DELETE /peers/:publicKey` — Revoke specific peer (API key auth).
  - `POST /metrics/vpn` — Ingest vpn-server metrics (CPU, memory, active peers, region); persisted to PostgreSQL for dashboard views.
  - `GET /metrics/targets` — Prometheus HTTP service-discovery endpoint listing online nodes as scrape targets (API key auth via `x-api-key` or `Authorization: Bearer`).

### 2.3 VPN Node Agent (`apps/vpn-server`)

Rust binary (and Docker image) that runs on host machines.

- **Protocols**
  - WireGuard (primary, high-performance).
  - OpenVPN (compatibility).
  - IKEv2/IPsec (enterprise and OS-native support).
- **Capabilities**
  - **Self-Registration:** On startup, calls `POST /server/register` with WireGuard public key, listen ports, and host metadata.
  - **Sync Loop:** Periodically calls `GET /server/peers` and applies peers to all enabled backends.
  - **Health & Metrics:** Publishes aggregate metrics to the control plane (`POST /metrics/vpn`) and exposes a Prometheus-format `/metrics` endpoint on its admin port.
  - **Admin API:** Exposes `/health`, `/metrics`, `/status`, `/pubkey` endpoints.
- **Configuration**
  - Primary via CLI flags and environment variables.

## 3. Privacy, Security & Data Model

### 3.1 Privacy Guarantees

- **No Traffic Logging:** VPN protocols are configured with logging disabled.
- **Minimal Metadata:** Only aggregate session counts, bytes in/out, and device public keys are stored.
- **Encryption:**
  - WireGuard: ChaCha20-Poly1305.
  - OpenVPN: AES-256-GCM.
  - IKEv2: strongSwan with modern proposals.
  - All control APIs served over TLS.

### 3.2 Logical Data Model

- **User (Postgres):** `id`, `email`, `name`, `stripeCustomerId`, timestamps.
- **Subscription (Postgres):** `stripeSubscriptionId`, `status`, `priceId`, `tier`, `currentPeriodEnd`.
- **Device (Postgres):** UI-level entity with `name`, `publicKey`, `serverId`.
- **VpnPeer (Postgres):** Network-level entity with `publicKey`, `userId`, `allowedIps`, `serverId`.
- **VpnServer (Postgres):** `id`, `status`, `lastSeen`, `metadata`.
- **VpnToken (Postgres):** Node registration tokens with `label`, `usageCount`, `active`.
- **VpnMetric (Postgres):** Time-series metrics per server.

### 3.3 VPN Server Control Loop

1. **Startup:** Parse CLI args, run diagnostics, generate/load WireGuard keys.
2. **Register:** Call `POST /server/register` with node identity and public key.
3. **Sync Loop:** Periodically fetch peers from control plane and apply to backends.
4. **Metrics:** Report health and session counts to the control plane (`POST /metrics/vpn`).

## 4. Infrastructure

There is no Pulumi/AWS provisioning. The platform is deployed across managed
hosts plus a small self-hosted monitoring stack.

### 4.1 Managed Deployments

- **Control Plane:** Runs on **Railway** as a Docker container (`railway.toml` at
  the repo root points at `services/control-plane/Dockerfile`). Auto-deploys from
  GitHub on push to main/staging; health checked at `/health`.
- **VPN Server:** Docker images published to **GHCR**
  (`ghcr.io/xnetcat/vpnvpn/vpn-server`). Nodes are provisioned manually on cloud
  VMs via `scripts/setup-vpn-node.sh` and self-register with the control plane.
- **Web App:** Auto-deploys to **Vercel**.
- **Database:** PostgreSQL (Neon in production, local Postgres in development).

### 4.2 Monitoring Stack (Prometheus + Grafana)

- A Prometheus image lives under `infra/prometheus/` (Dockerfile + `railway.toml`)
  and deploys to Railway. It auto-discovers VPN nodes through the control plane's
  `GET /metrics/targets` HTTP service-discovery endpoint, scraping each node's
  Prometheus-format `/metrics` endpoint. A static target list is supported as a
  fallback.
- Grafana visualizes the scraped metrics.
- For local development, Prometheus and Grafana are wired into
  `local/compose.yaml` (Prometheus on `:9091`, Grafana on `:3001` with an
  auto-provisioned dashboard).

## 5. End-to-End Data Flow

```mermaid
sequenceDiagram
    participant U as User (Browser)
    participant F as Web App (Next.js)
    participant DB as Postgres
    participant S as Stripe
    participant CP as Control Plane
    participant VPN as VPN Node
    participant WG as WireGuard

    Note over U, S: 1. User Subscription Flow
    U->>F: Sign Up / Login (SSO)
    U->>F: Purchase Subscription
    F->>S: Create Checkout Session
    S-->>U: Redirect to Payment
    U->>S: Complete Payment
    S->>F: Webhook (subscription.created)
    F->>DB: Update User (active=true)
    F->>U: Email Notification (Welcome)

    Note over U, VPN: 2. Peer Provisioning Flow
    U->>F: Dashboard -> "Add Device"
    F->>F: Generate Client Keypair
    F->>CP: POST /peers { publicKey, userId }
    CP->>DB: Store Peer
    F-->>U: Download .conf / QR Code

    Note over VPN, CP: 3. VPN Node Registration & Sync
    VPN->>VPN: Startup (CLI Args)
    VPN->>CP: POST /server/register { id, publicKey }
    CP->>DB: Update Server Status (Online)

    loop Every 30s
        VPN->>CP: GET /server/peers
        CP->>DB: Fetch Allowed Peers
        CP-->>VPN: List [ { pubKey, allowedIP } ... ]
        VPN->>WG: Apply Diff
    end

    Note over VPN, CP: 4. Monitoring & Usage
    loop Every 1m
        VPN->>WG: Collect Stats
        VPN->>CP: POST /metrics/vpn { stats }
        CP->>DB: Update Metrics
    end

    Note over U, WG: 5. Connection
    U->>WG: Connect (UDP 51820)
    WG->>WG: Handshake
    WG-->>U: Traffic Flowing
```

## 6. Local Development

Local development uses Docker Compose (`local/compose.yaml`) with real components:

- `web-app` in dev mode
- `control-plane` service with Postgres (metrics ingested via `POST /metrics/vpn`)
- `vpn-node` container with `NET_ADMIN` capability
- `prometheus` and `grafana` for monitoring

All integration tests exercise real HTTP APIs; no mock implementations.

See `docs/CONFIGURATION.md` (and `local/README.md`) for setup instructions.

## 7. Operational Runbooks

### Adding a Node

1. Provision a host with required VPN binaries.
2. Generate or retrieve a node token from the admin panel.
3. Run `vpn-server` with `--api-url` and `--token`.
4. The node self-registers and starts receiving peers.

### Revoking a User or Device

1. Cancel the user's Stripe subscription or mark the account as banned.
2. Stripe webhook updates subscription state.
3. Control plane marks peers as inactive.
4. VPN nodes remove revoked peers on next sync.

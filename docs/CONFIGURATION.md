# Configuration & Setup Guide

This guide covers the configuration for **Local**, **Staging**, and **Production** environments.

## Environments

| Environment    | Domain               | Branch    | Database                | API URL                 |
| :------------- | :------------------- | :-------- | :---------------------- | :---------------------- |
| **Local**      | `localhost:3000`     | N/A       | Local Docker Postgres   | `http://localhost:4000` |
| **Staging**    | `staging.vpnvpn.dev` | `staging` | Neon Staging            | `https://vpnvpn-control-plane-staging.up.railway.app` |
| **Production** | `vpnvpn.dev`         | `main`    | Neon Production         | `https://vpnvpn-control-plane-staging.up.railway.app` |

---

## 1. Environment Variables

### Web App (`apps/web`)

| Variable                | Description                | Local Default           |
| :---------------------- | :------------------------- | :---------------------- |
| `NEXT_PUBLIC_API_URL`   | Control Plane API URL      | `http://localhost:4000` |
| `NEXTAUTH_URL`          | App URL                    | `http://localhost:3000` |
| `NEXTAUTH_SECRET`       | Session encryption key     | `development-secret...` |
| `DATABASE_URL`          | Postgres connection string | `postgresql://...`      |
| `STRIPE_SECRET_KEY`     | Stripe Secret Key          | `sk_test_...`           |
| `STRIPE_WEBHOOK_SECRET` | Stripe Webhook Secret      | `whsec_...`             |
| `RESEND_API_KEY`        | Resend API Key             | `re_...`                |
| `CONTROL_PLANE_API_KEY` | Internal API Auth Key      | `local-dev-key`         |
| `GITHUB_ID` / `SECRET`  | GitHub OAuth               | Test App Credentials    |
| `GOOGLE_ID` / `SECRET`  | Google OAuth               | Test App Credentials    |

### Control Plane (`services/control-plane`)

| Variable                         | Description                         |
| :------------------------------- | :---------------------------------- |
| `DATABASE_URL`                   | Postgres connection string          |
| `CONTROL_PLANE_API_KEY`          | API Key for internal auth           |
| `CONTROL_PLANE_BOOTSTRAP_TOKEN`  | Bootstrap token for VPN nodes       |
| `PORT`                           | HTTP port (default: 4000)           |

### VPN Nodes (`apps/vpn-server`)

| Variable         | Description                             |
| :--------------- | :-------------------------------------- |
| `API_URL`        | Control Plane API URL                   |
| `VPN_TOKEN`      | Authentication Token                    |
| `SERVER_ID`      | Unique server identifier                |
| `METRICS_URL`    | Metrics endpoint (control plane URL)    |
| `VPN_PROTOCOLS`  | Enabled protocols (wireguard,openvpn,ikev2) |
| `LISTEN_UDP_PORT`| WireGuard listen port (default: 51820)  |
| `ADMIN_PORT`     | Admin API port (default: 8080)          |

---

## 2. Secrets Management

### Vercel (Web App)

- **Production/Staging:** Set variables in Vercel Project Settings.
- **Local:** Use `.env.local` (do not commit!).

### Railway (Control Plane)

Set environment variables in the Railway dashboard:

- `DATABASE_URL`
- `CONTROL_PLANE_API_KEY`
- `CONTROL_PLANE_BOOTSTRAP_TOKEN`
- `PORT`

---

## 3. Local Development Setup

### Prerequisites

- Bun 1.1+
- Docker & Docker Compose
- Rust toolchain

### Quick Start

1.  **Install Dependencies:**

    ```bash
    bun install
    ```

2.  **Environment Setup:**
    Copy `env.example` to `.env` and fill in values.

3.  **Run Full Stack:**
    ```bash
    bun run dev
    ```
    This starts Postgres, Control Plane, VPN Node, and Web App via Docker Compose.

### Manual Service Run

- **Web:** `cd apps/web && bun run dev`
- **Control Plane:** `cd services/control-plane && bun run dev`
- **VPN Server:** `cd apps/vpn-server && cargo run -- run`

---

## 4. Staging & Production Setup

### Control Plane (Railway)

1. Create a Railway project linked to GitHub.
2. Set service root to use `services/control-plane/Dockerfile`.
3. Configure environment variables (see Section 1).
4. (Optional) Add a custom domain (e.g. `api.vpnvpn.dev`) — requires a paid Railway plan; the default `*.up.railway.app` domain works out of the box.

### VPN Nodes

Use `scripts/setup-vpn-node.sh` to provision nodes on any cloud provider.
See `docs/DEPLOYMENT.md` for details.

### Vercel Configuration

1. Import project from GitHub.
2. Configure Environment Variables (see Section 1).
3. Deploy `main` (Prod) or `staging` (Staging).

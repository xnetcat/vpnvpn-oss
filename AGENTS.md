# AGENTS.md

## Setup commands

- **Frontend & Desktop:**
  - Install deps (monorepo): `bun install`
  - Start full local stack + desktop app: `bun run dev` (Docker: web, control-plane, vpn-server + local Tauri desktop, Stripe listener)
  - Start web app only: `cd apps/web && bun run dev`
  - Start desktop app only: `cd apps/desktop && bun run dev`
  - Run tests: `bun run test` or `cd apps/web && bun run test`
  - Lint: `bun run lint` or `cd apps/web && bun run lint`
- **Control Plane:**
  - Dev: `cd services/control-plane && bun run dev`
  - Deploy: Push to main/staging (Railway auto-deploys)
- **VPN Server (Rust):**
  - Build: `cd apps/vpn-server && cargo build`
  - Run: `cd apps/vpn-server && cargo run -- --help`
  - Test: `cd apps/vpn-server && cargo test`
- **E2E Tests:**
  - Run: `cd e2e && bash run-e2e.sh`

## Deployment

- **Frontend:**
  - Hosted on **Vercel**.
  - Environment variables configured in Vercel Dashboard.
  - Database (Postgres/Neon) connection string required.
- **Backend (Control Plane):**
  - Implemented as a Bun/TypeScript HTTP service in `services/control-plane`.
  - Backed by Postgres via the shared Prisma schema in `packages/db`.
  - Deployed to Railway as a Docker container (auto-deploys from GitHub).
  - Includes metrics ingestion endpoint (`POST /metrics/vpn`).
- **Data Plane (VPN Nodes):**
  - Infrastructure-agnostic (any cloud VM, VPS, etc.).
  - Deployed via Docker using `scripts/setup-vpn-node.sh`.
  - Images stored on GHCR (`ghcr.io/xnetcat/vpnvpn/vpn-server`).
- **Desktop App:**
  - Built via GitHub Actions.
  - Uploaded to GitHub Releases.

## Code style

- **General:**
  - Use latest stable versions of all packages.
  - Prefer `bun` for Node.js/TypeScript package management.
  - No secrets in code (use environment variables).
- **Frontend (Next.js):**
  - **Directory:** `apps/web/`
  - TypeScript strict mode enabled.
  - React Server Components (RSC) by default.
  - Use `lucide-react` for icons.
  - Tailwind CSS for styling (sorted classes).
  - **SaaS Features:**
    - **Auth:** NextAuth.js (SSO: Google, GitHub; Email: Magic Link).
    - **Billing:** Stripe (Multi-tier Subscriptions: Basic, Pro, Enterprise; Webhooks).
    - **Notifications:** Resend for transactional emails (welcome, subscription changes, device alerts).
- **Rust (VPN Server):**
  - **Directory:** `apps/vpn-server/`
  - `clippy` must pass.
  - `tracing` for structured logging.
  - No PII logging.
  - Use `clap` for CLI arguments.

## Feature Specifications

### SaaS Frontend (`apps/web`)

- **Authentication:** NextAuth.js.
- **Billing:** Stripe Subscriptions (Monthly/Yearly).
- **Dashboard:**
  - User: Subscription status, "Add Device" (generate config), Usage graphs.
  - Admin: Server fleet status, User management.
- **Deployment:** Vercel.

### Control Plane API

- **Architecture:** Railway (Docker).
- **Endpoints:**
  - `POST /server/register`: Node self-registration.
  - `GET /server/peers`: Sync allowed peers.
  - `POST /metrics/vpn`: Metrics ingestion.
- **Security:** Bearer tokens (VPN nodes) and API key (web app); rate limiting on public endpoints.
- **Note:** Stripe billing webhooks are handled by the web app (`apps/web/app/api/webhooks/stripe`), not the control plane; on subscription changes the web app calls the control plane's `POST /peers/revoke-for-user`.

### VPN Server

- **Core:** Rust binary.
- **Networking:** WireGuard, OpenVPN, IKEv2.
- **Privacy:** No traffic logging.
- **Operation:** Autonomous sync loop with Control Plane.

## Testing instructions

- **Frontend:** `cd apps/web && bun run test` (Vitest).
- **Rust:** `cd apps/vpn-server && cargo test`.
- **E2E:** `cd e2e && bash run-e2e.sh` (Docker-based protocol connectivity tests).
- **Integration:** `bun run test:local` to verify full system flow using the local Docker Compose stack.

## Development Workflow

1.  Check `docs/TODO.md` for tasks.
2.  Edit files in the appropriate directory.
3.  Run linters/tests.
4.  Commit changes.

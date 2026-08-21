# vpnVPN

Public source snapshot of vpnVPN — a privacy-first VPN SaaS platform.

**Live demo:** https://vpn-vpn-web.vercel.app

Modern monorepo for a VPN SaaS, built with Bun + Turborepo, Next.js, Rust, and an in-house control plane. Control plane deploys to Railway, VPN server images to GHCR, desktop apps to GitHub Releases.

### High-Level Architecture

- **Apps**
  - `apps/web`: Next.js 15 SaaS frontend (Vercel) with tRPC, Stripe, NextAuth, Prisma.
  - `apps/desktop`: Tauri desktop app with a privileged Rust daemon for VPN management. Supports WireGuard, OpenVPN, and IKEv2.
  - `apps/vpn-server`: Rust VPN node agent supporting WireGuard, OpenVPN, and IKEv2 with control-plane integration.
- **Services**
  - `services/control-plane`: Bun/Fastify HTTP API for servers, peers, tokens, metrics, and registration. Deployed to Railway.
- **Shared**
  - `packages/db`: Shared Prisma/Postgres client and schema (Neon in prod, Postgres in dev).

### Quick Start (Monorepo)

```bash
git clone https://github.com/xnetcat/vpnvpn-oss.git
cd vpnvpn-oss

# Install dependencies with Bun
bun install

# Start the full local stack (Postgres + control-plane + vpn-node + web)
# plus the Tauri desktop shell and Stripe listener:
bun run dev

# Or run apps/services individually with Turbo:
bun run dev:turbo      # turbo run dev --parallel
```

See `docs/ARCHITECTURE.md` for a deeper architecture overview.

### Deployment

- **Control Plane:** Auto-deploys via Railway on push to main/staging.
- **VPN Server:** Docker images pushed to GHCR via GitHub Actions. Nodes provisioned manually with `scripts/setup-vpn-node.sh`.
- **Desktop App:** Built via GitHub Actions and uploaded to GitHub Releases.
- **Web App:** Auto-deploys via Vercel.

See `docs/DEPLOYMENT.md` for detailed deployment documentation.

### Tests & CI

- Unit/integration tests live under each app/service (Vitest for TS, `cargo test` for Rust).
- E2E tests in `e2e/` run Docker-based connectivity tests for all VPN protocols.
- Turbo tasks:
  - `bun run lint` → `turbo run lint`
  - `bun run test` → `turbo run test`
  - `bash e2e/run-e2e.sh` → full E2E test suite

See `docs/DEPLOYMENT.md` for the GitHub Actions workflow details.

## License

MIT © 2026 Jakub Kot

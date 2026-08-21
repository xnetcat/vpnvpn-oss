# Task Board & Roadmap

**Status Legend:**

- [ ] Pending
- [/] In Progress
- [x] Completed

---

## Completed Features

### SaaS Frontend (`apps/web`)

- [x] Next.js 15 with App Router and tRPC v11
- [x] NextAuth.js authentication (GitHub, Google, Email magic link)
- [x] Stripe subscriptions with multi-tier pricing (Basic, Pro, Enterprise)
- [x] Resend email notifications
- [x] Device management with tier-based limits
- [x] Admin panel (token management, fleet monitoring)
- [x] Dashboard with real metrics from control plane

### Control Plane (`services/control-plane`)

- [x] Bun/Fastify HTTP API
- [x] Postgres database via Prisma
- [x] Server registration and peer sync endpoints
- [x] Token-based VPN node authentication
- [x] Metrics ingestion endpoint (`POST /metrics/vpn`)
- [x] Railway deployment

### VPN Server (`apps/vpn-server`)

- [x] Rust binary with WireGuard, OpenVPN, IKEv2 support
- [x] Self-registration with control plane
- [x] Peer sync loop, admin API, metrics reporting

### Desktop App (`apps/desktop`)

- [x] Tauri desktop shell with React frontend
- [x] Privileged Rust daemon for VPN management
- [x] Multi-platform builds (macOS, Linux, Windows)

### Infrastructure & CI

- [x] GHCR for VPN server Docker images
- [x] GitHub Releases for desktop app distribution
- [x] Prometheus + Grafana monitoring stack
- [x] E2E test infrastructure for WireGuard, OpenVPN, IKEv2

See `docs/ARCHITECTURE.md` and `docs/DEPLOYMENT.md` for details.

### Environment Variables

See `env.example` for required configuration.

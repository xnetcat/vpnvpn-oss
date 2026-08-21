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
- [x] Resend email notifications (welcome, subscription, device alerts)
- [x] Device management with tier-based limits
- [x] Server selection and status display
- [x] Admin panel (token management, fleet monitoring, server provisioning)
- [x] Dashboard with real metrics from control plane
- [x] Desktop download links served from the release bucket
      (`<DESKTOP_BUCKET_URL>/releases/<ENVIRONMENT>`; CI also publishes GitHub
      Releases as a build archive)
- [x] Advanced usage analytics dashboard
- [x] Terms of Service and Privacy Policy pages (`/terms`, `/privacy`), linked from footer and auth pages
- [x] Free tier with dashboard access (1 device); 4-tier pricing page (Free, Basic, Pro, Enterprise)
- [x] Device-limit enforcement on subscription downgrade (revokes newest devices beyond the new limit)
- [x] Notification preferences enforced in email sending (auth/billing-critical mail always sends)
- [x] Rate limiting on sensitive tRPC mutations (checkout, portal, device register/configs, desktop code)
- [x] Custom 404/500 error pages
- [x] Optional yearly billing (env-gated Stripe yearly price IDs; monthly-only when unset)

### Control Plane (`services/control-plane`)

- [x] Bun/Fastify HTTP API
- [x] Postgres database via Prisma
- [x] Server registration and peer sync endpoints
- [x] Token-based VPN node authentication
- [x] API key authentication for web app calls
- [x] Metrics ingestion endpoint (`POST /metrics/vpn`)
- [x] Railway deployment (Docker, auto-deploy from GitHub)

### VPN Server (`apps/vpn-server`)

- [x] Rust binary with WireGuard, OpenVPN, IKEv2 support
- [x] Self-registration with control plane
- [x] Peer sync loop
- [x] Admin API endpoints
- [x] Metrics reporting
- [x] Shared PKI for OpenVPN and IKEv2
- [x] IKEv2 EAP-MSCHAPv2 authentication
- [x] IKEv2 peer management (apply_peers)
- [x] OpenVPN tls-crypt support
- [x] OpenVPN hashed credential verification
- [x] OpenVPN dropped privileges (nobody/nogroup)
- [x] WireGuard PersistentKeepalive
- [x] WireGuard MTU 1420
- [x] WireGuard IPv6 support

### Desktop App (`apps/desktop`)

- [x] Tauri desktop shell with React frontend
- [x] Environment-specific builds (staging/production)
- [x] Deep link support (vpnvpn:// protocol)
- [x] Multi-platform builds (macOS, Linux, Windows)

### Infrastructure

- [x] Railway deployment for control plane
- [x] GHCR for VPN server Docker images
- [x] GitHub Releases for desktop app distribution
- [x] Manual VPN node provisioning script
- [x] Prometheus + Grafana monitoring stack (`infra/prometheus/`, `local/compose.yaml`) with control-plane http_sd auto-discovery (`GET /metrics/targets`)

### CI/CD (`.github/workflows`)

- [x] CI workflow (lint, test, build)
- [x] VPN server build and push to GHCR
- [x] Desktop build and GitHub Releases upload
- [x] E2E test workflow

### Testing

- [x] E2E test infrastructure (Docker-based)
- [x] WireGuard connectivity E2E test
- [x] OpenVPN connectivity E2E test
- [x] IKEv2 connectivity E2E test
- [x] Peer revocation E2E test
- [x] Reconnection E2E test

### Documentation

- [x] Architecture overview (`docs/ARCHITECTURE.md`)
- [x] Deployment guide (`docs/DEPLOYMENT.md`)
- [x] Configuration guide (`docs/CONFIGURATION.md`)
- [x] API documentation (`docs/API.md`)

---

## Pending Tasks

### Testing & Validation

- [x] Control plane unit tests (registration, peer CRUD, tokens, metrics, auth, rate limiting)
- [x] VPN server unit tests (config generation, status parsing, PKI)
- [x] End-to-end production flow test (signup -> payment -> VPN connection) —
  `bun run test:flow` (`e2e/run-flow.sh`): seeds a user + DB session, activates
  a Pro subscription via a signed synthetic Stripe webhook, registers devices
  over tRPC (Bearer auth), establishes a real WireGuard tunnel, and verifies
  revocation severs traffic and prunes devices to the free-tier limit.

### Known Caveats

- Desktop Windows support: compiles and bundles green in CI (the
  `desktop-build.yml` Windows matrix leg and `windows-check` passed on main),
  and `desktop-ci.yml` now runs `cargo test` + `cargo clippy -D warnings` for
  the daemon plus a `src-tauri` check on `windows-latest` for every push/PR
  touching `apps/desktop/**`. Still pending: manual smoke test of the installed
  app (service install, named-pipe IPC, rasdial IKEv2) on a real Windows
  machine before release.

---

## Quick Reference

### API Endpoints

#### Control Plane (`services/control-plane`)

| Endpoint                 | Method | Auth         | Description              |
| ------------------------ | ------ | ------------ | ------------------------ |
| `/health`                | GET    | None         | Health check             |
| `/server/register`       | POST   | Bearer token | VPN node registration    |
| `/server/peers`          | GET    | Bearer token | Fetch peers for a server |
| `/servers`               | GET    | API key      | List all servers         |
| `/servers/:id`           | DELETE | API key      | Delete a server          |
| `/peers`                 | POST   | API key      | Create/update peer       |
| `/peers/revoke-for-user` | POST   | API key      | Revoke user's peers      |
| `/peers/:publicKey`      | DELETE | API key      | Revoke specific peer     |
| `/tokens`                | GET    | API key      | List all tokens          |
| `/tokens`                | POST   | API key      | Create new token         |
| `/admin/tokens`          | POST   | API key      | Alias of `POST /tokens`  |
| `/tokens/:id`            | DELETE | API key      | Revoke a token by id     |
| `/admin/tokens/:id`      | DELETE | API key      | Alias of `DELETE /tokens/:id` |
| `/metrics/vpn`           | POST   | Bearer token | Ingest VPN metrics (node token; rate limited) |
| `/metrics/targets`       | GET    | API key¹     | Prometheus http_sd target list |

¹ `GET /metrics/targets` accepts the API key via either `x-api-key` or `Authorization: Bearer <key>`.

### Environment Variables

See `env.example` for required configuration.

### Deployment Commands

```bash
# Local development
bun run dev

# Build VPN server image
cd apps/vpn-server && docker build -t vpn-server .

# Run E2E tests
cd e2e && bash run-e2e.sh

# Provision a new VPN node
sudo -E bash scripts/setup-vpn-node.sh
```

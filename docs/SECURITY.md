# Security

This document describes vpnVPN's security model and the operational actions
required to keep it secure.

## ⚠️ Secret rotation (required action)

Application secrets live in `.env` / `.env.local` for local development. These
files are **git-ignored and were never committed**, but they are real
credentials sitting on disk. Treat any machine that has held them as a place the
secrets may have leaked (backups, shared hosts, tooling, archives).

**Rotate these now if there's any chance they were exposed, and again before
going to production:**

| Secret | Where to rotate |
| --- | --- |
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | Neon dashboard → reset the role password |
| `STRIPE_SECRET_KEY` | Stripe dashboard → API keys → roll (confirm it is a **test** key for dev) |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard → Webhooks → roll signing secret |
| `NEXTAUTH_SECRET` | regenerate (`openssl rand -base64 32`) — invalidates existing sessions |
| `RESEND_API_KEY` | Resend dashboard → API keys |
| `GITHUB_SECRET` / `GOOGLE_CLIENT_SECRET` | provider OAuth app settings |
| `CONTROL_PLANE_API_KEY` | regenerate and update both the web app and control-plane env |
| VPN node tokens | recreate via the admin panel; old tokens are revocable |

Never paste real secrets into code, issues, or chat. For production, use the
platform secret stores (Vercel/Railway env, not files).

## Authentication & trust boundaries

- **Web app ↔ control plane:** `x-api-key` header, compared in **constant time**
  (`services/control-plane/src/server.ts`).
- **VPN nodes ↔ control plane:** `Authorization: Bearer <token>`. Node tokens
  are stored **only as a SHA-256 hash** (`VpnToken.tokenHash`); the raw value is
  shown once at creation and is unrecoverable. Lookups are by hash, so a database
  read never yields a usable token.
- **Metrics ingestion (`POST /metrics/vpn`)** now **requires a node bearer
  token** (previously open) — preventing metric spoofing and unbounded writes.
- **Shared fleet tokens:** `POST /metrics/vpn` and `POST /server/register`
  authenticate the node token but do **not** bind it to a specific `serverId`,
  so any valid fleet token can write any server's rows. This is an accepted
  trade-off of the shared-token fleet model (one token can provision many
  nodes); compromising it requires a leaked token, which is revocable.
  Per-server token binding is a possible future hardening.
- **tRPC** procedures are scoped (`publicProcedure` / `protectedProcedure` /
  `paidProcedure` / `adminProcedure`); device operations re-check ownership.
- **Stripe webhook** verifies the signature (`constructEvent`) before trusting
  any event.

## Data protection

- VPN node tokens and the control-plane API key are never logged or returned in
  list endpoints (only a non-sensitive `tokenPrefix` is shown).
- Device tunnel IPs are allocated transactionally with a
  `UNIQUE(serverId, assignedIp)` constraint — no silent IP collisions.
- Metrics are pruned on a retention window (`METRICS_RETENTION_DAYS`, default 30)
  so the table cannot grow without bound.

## Scaling note

The control plane currently uses an **in-memory** rate-limit store, so it must
run as a **single replica** (`railway.toml` pins `numReplicas = 1`). To scale
horizontally, set `RATE_LIMIT_REDIS_URL` and install `ioredis`; the limiter then
shares counters across replicas.

## Reporting

Report suspected vulnerabilities privately to the maintainer rather than opening
a public issue.

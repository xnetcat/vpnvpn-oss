web-app (Next.js SaaS frontend)

Production-ready SaaS application for vpnVPN with multi-tier pricing, device management, and admin panel.

Features

- **tRPC Backend**: End-to-end type-safe API with automatic validation and caching
- **Multi-Tier Pricing**: Basic ($5), Pro ($12), Enterprise ($29) with different device limits
- **Authentication**: NextAuth.js with GitHub, Google, and Email (magic link) providers
- **Stripe Integration**: Subscription management, checkout, billing portal, and webhooks
- **Email Notifications**: Resend for transactional emails (welcome, subscription, security alerts)
- **Device Management**: Add, view, revoke devices with server selection
- **Admin Panel**: Token management, server provisioning, fleet monitoring
- **Control Plane Integration**: Real-time server metrics and peer management
- **Tech Stack**: Next.js App Router, tRPC, React Query, TypeScript (strict), TailwindCSS, Prisma, PostgreSQL

Environment variables (see `env.example` at the repo root for local dev)

- Database & auth:
  - `DATABASE_URL`
  - `NEXTAUTH_URL`
  - `NEXTAUTH_SECRET`
- OAuth:
  - `GITHUB_ID`, `GITHUB_SECRET`
  - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- Email (magic link):
  - `EMAIL_SERVER`
  - `EMAIL_FROM`
- Stripe:
  - `STRIPE_SECRET_KEY`
  - `STRIPE_WEBHOOK_SECRET`
  - `STRIPE_PRICE_ID_BASIC`
  - `STRIPE_PRICE_ID_PRO`
  - `STRIPE_PRICE_ID_ENTERPRISE`
- Resend (Email):
  - `RESEND_API_KEY`
- Control plane (server-side):
  - `CONTROL_PLANE_API_URL` (base URL for control-plane calls; the control plane runs on Railway)
  - `CONTROL_PLANE_API_KEY` (shared web→control-plane API key)
- Desktop:
  - `DESKTOP_BUCKET_URL` (base URL of the desktop release bucket)

Local development

1. From repo root:
   ```bash
   bun install
   bun run dev        # Docker: full stack (web, control-plane, vpn-server)
   ```
2. Or run just the web app:
   ```bash
   cd apps/web
   bun run dev
   ```

To test Stripe webhooks locally:

1. Install Stripe CLI and login.
2. Run `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
3. Complete checkout from `/pricing` and verify account access to `/dashboard`.

Vercel setup

- Create a Vercel project pointing to `apps/web`.
- Build command: `bun run build`
- Install command: `bun install`
- Output directory: `.next`
- Configure all environment variables above in the Vercel dashboard (no `.env` committed).
- For domains:
  - **Production**: set `NEXTAUTH_URL="https://vpnvpn.dev"`
  - **Staging/Preview**: set `NEXTAUTH_URL="https://staging.vpnvpn.dev"`

# vpnVPN — Project Documentation and Specification

## 1. Executive Summary

vpnVPN is a privacy-first, verified-data-flow VPN SaaS platform. It lets customers subscribe to encrypted VPN access, choose exit locations, and manage their devices, while operators manage a global fleet of VPN nodes across EC2, VPS, or bare metal.

Key pillars:

- **Privacy & Security:** No traffic logging, strong modern ciphers (WireGuard, OpenVPN, IKEv2), end-to-end TLS on control APIs, and a minimal-metadata model.
- **Universal Deployment:** Node agent (`vpn-server`) runs as a binary or Docker container on Linux, macOS, and Windows hosts.
- **Full SaaS Frontend:** Production-grade Next.js app on Vercel for marketing, signup, billing, user dashboards, and admin operations.
- **Verifiable Data Flow:** All cross-service communication is explicit, documented, and testable end-to-end.

The remainder of this spec covers architecture, data model, infrastructure (Vercel frontend; control plane was on Railway and is now self-hosted / local), monitoring, E2E data flow, local development, and operational runbooks. See also `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, and `docs/OPERATIONS.md`.

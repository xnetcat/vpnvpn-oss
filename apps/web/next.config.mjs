/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // We run `next start` in Docker, so we keep the default output instead of standalone.
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        // Apply security headers to every route. Stripe Checkout/portal flows
        // are top-level navigations, so frame-ancestors/X-Frame-Options do not
        // affect them. We intentionally do NOT set a script-src CSP — Next.js
        // relies on inline bootstrap scripts and a strict policy would require
        // nonce plumbing; a frame-ancestors-only CSP is the safe subset.
        source: "/(.*)",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;

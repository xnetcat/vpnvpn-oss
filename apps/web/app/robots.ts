import type { MetadataRoute } from "next";
import { WEB_ENV } from "@/env";

// Rendered at request time: env vars are injected at runtime (Docker/Railway),
// so the base URL is not available during `next build` (see env.ts).
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = WEB_ENV.NEXTAUTH_URL || "https://vpnvpn.dev";

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Session-gated app shell and API surfaces — nothing to index there.
      disallow: [
        "/dashboard",
        "/admin",
        "/api",
        "/account",
        "/devices",
        "/servers",
      ],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}

import type { MetadataRoute } from "next";
import { WEB_ENV } from "@/env";

// Rendered at request time: env vars are injected at runtime (Docker/Railway),
// so the base URL is not available during `next build` (see env.ts).
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = WEB_ENV.NEXTAUTH_URL || "https://vpnvpn.dev";

  // Public marketing pages only — the dashboard/admin/auth surfaces are
  // session-gated and excluded via robots.ts.
  const routes = ["/", "/pricing", "/terms", "/privacy", "/transparency"];

  return routes.map((route) => ({
    url: `${base}${route === "/" ? "" : route}`,
    lastModified: new Date(),
    changeFrequency: route === "/" ? "weekly" : "monthly",
    priority: route === "/" ? 1 : 0.6,
  }));
}

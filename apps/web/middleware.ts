import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const protectedPrefixes = [
  "/dashboard",
  "/servers",
  "/account",
  "/devices",
  "/admin",
];

// Limit host-based rewrites to our own domains so we don't accidentally
// rewrite for arbitrary hostnames. Supports both production and staging:
// - vpnvpn.dev
// - *.vpnvpn.dev (e.g. admin.vpnvpn.dev, admin.staging.vpnvpn.dev)
function isOurHost(host: string): boolean {
  if (!host) return false;
  if (host.startsWith("localhost:") || host.startsWith("127.0.0.1:")) {
    return true;
  }
  if (host === "vpnvpn.dev") return true;
  if (host.endsWith(".vpnvpn.dev")) return true;
  return false;
}

function rewriteForSubdomains(req: NextRequest): NextResponse | null {
  const url = req.nextUrl.clone();
  const host = req.headers.get("host")?.toLowerCase() ?? "";
  const pathname = url.pathname || "/";

  if (!isOurHost(host)) {
    return null;
  }

  // dashboard.vpnvpn.dev / dashboard.staging.vpnvpn.dev -> /dashboard
  if (host.startsWith("dashboard.") && pathname === "/") {
    url.pathname = "/dashboard";
    return NextResponse.rewrite(url);
  }

  // admin.vpnvpn.dev / admin.staging.vpnvpn.dev -> /admin
  if (host.startsWith("admin.") && pathname === "/") {
    url.pathname = "/admin";
    return NextResponse.rewrite(url);
  }

  // app.vpnvpn.dev / app.staging.vpnvpn.dev -> /dashboard (legacy desktop host)
  if (host.startsWith("app.") && pathname === "/") {
    url.pathname = "/dashboard";
    return NextResponse.rewrite(url);
  }

  return null;
}

export function middleware(req: NextRequest) {
  const rewritten = rewriteForSubdomains(req);
  if (rewritten) {
    // Add pathname and search params headers for rewritten requests
    rewritten.headers.set("x-pathname", req.nextUrl.pathname);
    rewritten.headers.set("x-search", req.nextUrl.search);
    return rewritten;
  }

  const { pathname } = req.nextUrl;

  // Add pathname and search params headers so server components can access them
  const response = NextResponse.next();
  response.headers.set("x-pathname", pathname);
  response.headers.set("x-search", req.nextUrl.search);

  const isProtected = protectedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  if (!isProtected) return response;

  const hasSession =
    req.cookies.has("__Secure-next-auth.session-token") ||
    req.cookies.has("next-auth.session-token");

  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.set("redirected", "1");
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  // Run middleware for all app routes (excluding Next internals and static
  // assets — icon.png is the app-router favicon, opengraph-image the OG card,
  // shield-icon.png the email logo) so we can implement host-based routing
  // while enforcing auth only on protectedPaths.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.png|opengraph-image|sitemap.xml|robots.txt|shield-icon.png).*)",
  ],
};

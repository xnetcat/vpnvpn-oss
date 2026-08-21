import { NextResponse } from "next/server";
import { prisma } from "@vpnvpn/db";

// BACKWARDS-COMPAT SHIM.
//
// Historically this route handled BOTH desktop (Bearer-token) sign-out and was
// (incorrectly) POSTed to by the web header. As a static route it shadows
// NextAuth's /api/auth/[...nextauth] catch-all, so it could NEVER clear the web
// JWT cookie — web users saw raw JSON and stayed signed in.
//
// Web sign-out now goes through NextAuth's own endpoint via next-auth's
// signOut() (see components/SiteHeader.tsx, AccountDataControls.tsx). The
// canonical desktop sign-out endpoint is /api/desktop/signout.
//
// We keep this path alive ONLY to remain backwards-compatible with already
// shipped desktop builds that still POST a Bearer token here
// (apps/desktop/src/lib/hooks.ts). Bearer requests delete the DB session.
// Because this static file shadows the NextAuth catch-all for this exact path,
// it can never clear the web JWT cookie itself, so non-Bearer (web) callers —
// which no longer exist in our own app — are simply sent home; real web
// sign-out is performed client-side via next-auth signOut().

const allowedOrigins = [
  "http://localhost:5173", // Vite dev server
  "tauri://localhost", // Tauri production build
];

function getCorsHeaders(req: Request) {
  const origin = req.headers.get("Origin") || "";
  const allowedOrigin = allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  };
}

export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(req) });
}

export async function POST(req: Request) {
  const corsHeaders = getCorsHeaders(req);

  try {
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      // Desktop Bearer sign-out: delete the DB session backing this token.
      await prisma.session.deleteMany({
        where: { sessionToken: token },
      });

      return NextResponse.json({ success: true }, { headers: corsHeaders });
    }

    // Non-Bearer (web) requests: nothing to clear here. Send the caller home.
    // Real web sign-out happens client-side via next-auth signOut().
    return NextResponse.redirect(new URL("/", req.url), {
      status: 303,
      headers: corsHeaders,
    });
  } catch (error) {
    console.error("[signout] Error:", error);
    return NextResponse.json(
      { error: "Failed to sign out" },
      { status: 500, headers: corsHeaders },
    );
  }
}

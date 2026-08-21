import { NextResponse } from "next/server";
import { prisma } from "@vpnvpn/db";

// Desktop (Bearer-token) sign-out. The Tauri app holds a database session token
// and calls this endpoint to delete that session server-side. This lives under
// /api/desktop/* so it does NOT shadow NextAuth's /api/auth/* catch-all, which
// owns cookie-based web sign-out.

// Allowed origins for CORS (desktop app)
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

// Handle preflight requests
export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(req) });
}

export async function POST(req: Request) {
  const corsHeaders = getCorsHeaders(req);

  try {
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      // Delete the database session backing this Bearer token.
      await prisma.session.deleteMany({
        where: { sessionToken: token },
      });
    }

    // Idempotent: always report success even if no matching session existed.
    return NextResponse.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    console.error("[desktop/signout] Error:", error);
    return NextResponse.json(
      { error: "Failed to sign out" },
      { status: 500, headers: corsHeaders },
    );
  }
}

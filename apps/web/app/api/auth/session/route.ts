import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@vpnvpn/db";
import { authOptions } from "@/lib/auth";

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  };
}

// Handle preflight requests
export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(req) });
}

export async function GET(req: Request) {
  const corsHeaders = getCorsHeaders(req);

  try {
    // First check for Authorization header (desktop app)
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      // Look up the session in the database
      const session = await prisma.session.findUnique({
        where: { sessionToken: token },
        include: { user: true },
      });

      if (session && session.expires > new Date()) {
        return NextResponse.json(
          {
            user: {
              id: session.user.id,
              email: session.user.email,
              name: session.user.name,
              image: session.user.image,
            },
            expires: session.expires.toISOString(),
          },
          { headers: corsHeaders },
        );
      }

      // Invalid or expired token
      return NextResponse.json(
        { user: null },
        { status: 401, headers: corsHeaders },
      );
    }

    // Fall back to NextAuth session (cookie-based, for web app)
    const session = await getServerSession(authOptions);

    if (session?.user) {
      return NextResponse.json(
        {
          user: {
            id: (session.user as any).id,
            email: session.user.email,
            name: session.user.name,
            image: session.user.image,
          },
          expires: (session as any).expires,
        },
        { headers: corsHeaders },
      );
    }

    return NextResponse.json({ user: null }, { headers: corsHeaders });
  } catch (error) {
    console.error("[session] Error:", error);
    return NextResponse.json(
      { user: null, error: "Failed to check session" },
      { status: 500, headers: corsHeaders },
    );
  }
}

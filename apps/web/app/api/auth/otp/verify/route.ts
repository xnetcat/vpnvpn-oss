import { NextResponse } from "next/server";
import { prisma } from "@vpnvpn/db";
import { randomBytes } from "crypto";
import { consumeRateLimit } from "@/lib/rateLimit";

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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
  };
}

// Handle preflight requests
export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: getCorsHeaders(req) });
}

// Per-code brute-force lockout: a code becomes invalid once it accumulates this
// many failed verification attempts, even if otherwise correct/unexpired. This
// is DB-backed (DesktopLoginCode.attempts) so it cannot be bypassed by hitting
// a different serverless instance.
const MAX_CODE_ATTEMPTS = 5;

// Best-effort IP rate limiting via the shared store (in-memory by default,
// Redis-backed across instances when REDIS_URL is set — see lib/rateLimit.ts).
// Secondary defence layer only: the authoritative brute-force protection is
// the DB-backed per-code attempt counter above.
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const IP_RATE_LIMIT_MAX_ATTEMPTS = 20; // 20 verify attempts per minute per IP

async function isIpRateLimited(ip: string): Promise<boolean> {
  return !(await consumeRateLimit(
    `otp.verify:ip:${ip}`,
    IP_RATE_LIMIT_MAX_ATTEMPTS,
    RATE_LIMIT_WINDOW,
  ));
}

// Generate a secure session token
function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

export async function POST(req: Request) {
  const corsHeaders = getCorsHeaders(req);

  try {
    const body = await req.json();
    const { email, code } = body;

    if (!email || typeof email !== "string") {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    if (!code || typeof code !== "string" || code.length !== 6) {
      return NextResponse.json(
        { error: "Invalid code format" },
        { status: 400, headers: corsHeaders },
      );
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Best-effort IP rate limit (secondary defence). The authoritative
    // brute-force protection is the per-code attempt counter below.
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
    if (await isIpRateLimited(ip)) {
      return NextResponse.json(
        { error: "Too many verification attempts. Please wait a minute." },
        { status: 429, headers: corsHeaders },
      );
    }

    // Find the active candidate code for this email (most recent unexpired,
    // unconsumed one) so we can attribute a failed attempt even when the
    // submitted code doesn't match.
    const candidate = await prisma.desktopLoginCode.findFirst({
      where: {
        email: normalizedEmail,
        expiresAt: { gt: new Date() },
        consumedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });

    // No candidate, or the candidate is already locked out, or the submitted
    // code doesn't match → reject. On a genuine mismatch against an unlocked
    // candidate, increment its attempt counter (brute-force lockout).
    if (!candidate || candidate.attempts >= MAX_CODE_ATTEMPTS) {
      return NextResponse.json(
        { error: "Invalid or expired code" },
        { status: 401, headers: corsHeaders },
      );
    }

    if (candidate.code !== code) {
      await prisma.desktopLoginCode.update({
        where: { id: candidate.id },
        data: { attempts: { increment: 1 } },
      });
      return NextResponse.json(
        { error: "Invalid or expired code" },
        { status: 401, headers: corsHeaders },
      );
    }

    const otpEntry = candidate;

    // Mark the code as consumed
    await prisma.desktopLoginCode.update({
      where: { id: otpEntry.id },
      data: { consumedAt: new Date() },
    });

    // Find or create the user
    let user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          emailVerified: new Date(),
        },
      });
    } else if (!user.emailVerified) {
      // Mark email as verified if not already
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: new Date() },
      });
    }

    // Create a session for the user
    const sessionToken = generateSessionToken();
    const sessionExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    await prisma.session.create({
      data: {
        sessionToken,
        userId: user.id,
        expires: sessionExpiry,
      },
    });

    // NOTE: we deliberately do NOT set a session cookie here. NextAuth runs
    // with the JWT session strategy, so a raw database session token under the
    // NextAuth cookie name can never be decoded by getServerSession — it would
    // only trick the middleware's cookie-presence check into a redirect
    // dead-end. The desktop app authenticates with the returned Bearer token.

    // Return the session token for the desktop app to store
    return NextResponse.json(
      {
        success: true,
        sessionToken, // Desktop app can store this for API calls
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    console.error("[otp/verify] Error:", error);
    return NextResponse.json(
      { error: "Failed to verify code" },
      { status: 500, headers: corsHeaders },
    );
  }
}

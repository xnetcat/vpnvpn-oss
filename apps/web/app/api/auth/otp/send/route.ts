import { NextResponse } from "next/server";
import { prisma } from "@vpnvpn/db";
import { randomInt } from "node:crypto";
import { sendEmail } from "@/lib/email";
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

const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 3; // 3 codes per minute per email

// Best-effort IP rate limiting via the shared store (in-memory by default,
// Redis-backed across instances when REDIS_URL is set — see lib/rateLimit.ts).
// This is a secondary defence layer; the authoritative limit is DB-backed
// (see isEmailRateLimited) so it works across serverless instances and cannot
// be bypassed by instance hopping.
async function isIpRateLimited(ip: string): Promise<boolean> {
  return !(await consumeRateLimit(
    `otp.send:ip:${ip}`,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW,
  ));
}

// DB-backed per-email rate limit: count codes created for this email inside the
// window. Works across serverless instances unlike an in-memory Map.
async function isEmailRateLimited(email: string): Promise<boolean> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW);
  const recent = await prisma.desktopLoginCode.count({
    where: { email, createdAt: { gte: since } },
  });
  return recent >= RATE_LIMIT_MAX_REQUESTS;
}

// Generate a cryptographically-secure 6-digit numeric code, preserving leading
// zeros.
function generateOtpCode(): string {
  return String(randomInt(100000, 1000000));
}

export async function POST(req: Request) {
  const corsHeaders = getCorsHeaders(req);

  try {
    const body = await req.json();
    const { email } = body;

    if (!email || typeof email !== "string") {
      return NextResponse.json(
        { error: "Email is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return NextResponse.json(
        { error: "Invalid email format" },
        { status: 400, headers: corsHeaders },
      );
    }

    // Best-effort IP rate limit (shared store, secondary defence)
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown";
    if (await isIpRateLimited(ip)) {
      return NextResponse.json(
        {
          error: "Too many requests. Please wait a minute before trying again.",
        },
        { status: 429, headers: corsHeaders },
      );
    }

    // Authoritative DB-backed rate limit by email (works across instances)
    if (await isEmailRateLimited(normalizedEmail)) {
      return NextResponse.json(
        {
          error: "Too many requests. Please wait a minute before trying again.",
        },
        { status: 429, headers: corsHeaders },
      );
    }

    // Generate OTP code
    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Invalidate previous codes for this email
    await prisma.desktopLoginCode.updateMany({
      where: { email: normalizedEmail, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    // Store the code in the database
    await prisma.desktopLoginCode.create({
      data: {
        email: normalizedEmail,
        code,
        url: "desktop-otp", // Marker for OTP-based auth
        expiresAt,
      },
    });

    // Send the email
    await sendEmail({
      to: normalizedEmail,
      template: "otp_code",
      data: {
        code,
        expiresMinutes: 10,
      },
    });

    return NextResponse.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    console.error("[otp/send] Error:", error);
    return NextResponse.json(
      { error: "Failed to send verification code" },
      { status: 500, headers: corsHeaders },
    );
  }
}

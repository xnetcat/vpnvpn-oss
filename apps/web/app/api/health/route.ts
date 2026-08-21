import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { WEB_ENV } from "@/env";

// Use Node.js runtime to enable database checks
export const runtime = "nodejs";

interface HealthCheck {
  status: "ok" | "error" | "skipped";
  latencyMs?: number;
  error?: string;
}

export async function GET() {
  const checks: Record<string, HealthCheck> = {};

  // Database connectivity check
  const dbStart = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
  } catch (err) {
    checks.database = {
      status: "error",
      latencyMs: Date.now() - dbStart,
      error: err instanceof Error ? err.message : "Unknown database error",
    };
  }

  // Control Plane reachability check (optional)
  const controlPlaneUrl = WEB_ENV.CONTROL_PLANE_API_URL;
  if (controlPlaneUrl) {
    const cpStart = Date.now();
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(`${controlPlaneUrl}/health`, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        checks.controlPlane = { status: "ok", latencyMs: Date.now() - cpStart };
      } else {
        checks.controlPlane = {
          status: "error",
          latencyMs: Date.now() - cpStart,
          error: `HTTP ${response.status}`,
        };
      }
    } catch (err) {
      checks.controlPlane = {
        status: "error",
        latencyMs: Date.now() - cpStart,
        error: err instanceof Error ? err.message : "Connection failed",
      };
    }
  } else {
    checks.controlPlane = { status: "skipped" };
  }

  // Determine overall status
  // Database is critical, control plane is non-critical
  const dbFailed = checks.database.status === "error";
  const cpFailed = checks.controlPlane.status === "error";

  let overallStatus: "healthy" | "degraded" | "unhealthy";
  if (dbFailed) {
    overallStatus = "unhealthy";
  } else if (cpFailed) {
    overallStatus = "degraded";
  } else {
    overallStatus = "healthy";
  }

  const response = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    service: "web",
    checks,
  };

  return NextResponse.json(response, {
    status: overallStatus === "unhealthy" ? 503 : 200,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function HEAD() {
  // For HEAD requests, do a quick database check
  try {
    await prisma.$queryRaw`SELECT 1`;
    return new NextResponse(null, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new NextResponse(null, {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}

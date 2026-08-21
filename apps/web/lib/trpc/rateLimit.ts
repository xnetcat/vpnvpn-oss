import { TRPCError } from "@trpc/server";
import { t } from "./init";
import { consumeRateLimit } from "@/lib/rateLimit";

// Re-export the test helper so tests can reset state via this module too.
export { __resetRateLimits, checkRateLimit } from "@/lib/rateLimit";

function identityFromCtx(ctx: {
  userId?: string;
  session?: { user?: { id?: string } | null } | null;
  req?: Request;
}): string {
  const userId =
    ctx.userId ?? (ctx.session?.user as { id?: string } | undefined)?.id;
  if (userId) return `user:${userId}`;

  // Fall back to client IP for public procedures.
  const ip =
    ctx.req?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return `ip:${ip}`;
}

/**
 * tRPC middleware factory that rate-limits by userId (or client IP for public
 * procedures). `name` namespaces the bucket so different procedures don't share
 * a budget. Limits are generous (default 10/min) — abuse protection, not a hard
 * quota. In-memory by default; Redis-backed across instances when REDIS_URL is
 * set — see lib/rateLimit.ts.
 */
export function rateLimit(opts: {
  name: string;
  limit: number;
  windowMs?: number;
}) {
  const windowMs = opts.windowMs ?? 60_000; // default: per minute
  return t.middleware(async ({ ctx, next }) => {
    const identity = identityFromCtx(ctx as never);
    const key = `${opts.name}:${identity}`;
    if (!(await consumeRateLimit(key, opts.limit, windowMs))) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Too many requests. Please slow down and try again shortly.",
      });
    }
    return next();
  });
}

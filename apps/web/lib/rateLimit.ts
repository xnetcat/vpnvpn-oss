// Rate limiter used for abuse protection on sensitive tRPC mutations and the
// OTP routes' IP limits (see lib/trpc/rateLimit.ts for the middleware).
//
// This is intentionally simple: limits are generous and the goal is to blunt
// scripted abuse, not add UX friction.
//
// Store selection: by default state lives in this process's memory (sliding
// window), which is correct only for a single-instance deployment. When
// REDIS_URL is set, `consumeRateLimit` shares fixed-window counters across
// instances via Redis (same `ioredis` client as the control plane's optional
// rate-limit store) and fails open to the in-memory store on Redis errors.
// The OTP routes additionally pair this with an authoritative DB-backed limit.

import { WEB_ENV } from "@/env";

type Bucket = { timestamps: number[] };

// Keyed by `${name}:${identity}`. A periodic sweep keeps it from growing
// unbounded for one-off identities.
const buckets = new Map<string, Bucket>();

let lastSweep = Date.now();

function sweep(now: number, windowMs: number) {
  // Sweep at most once per window to bound overhead.
  if (now - lastSweep < windowMs) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < windowMs);
    if (bucket.timestamps.length === 0) buckets.delete(key);
  }
}

/**
 * Record a hit for `key` and return whether it is within `limit` per
 * `windowMs`.
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  sweep(now, windowMs);

  const bucket = buckets.get(key) ?? { timestamps: [] };
  // Drop timestamps outside the window.
  bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < windowMs);

  if (bucket.timestamps.length >= limit) {
    buckets.set(key, bucket);
    return false;
  }

  bucket.timestamps.push(now);
  buckets.set(key, bucket);
  return true;
}

// Test-only helper to reset state between cases.
export function __resetRateLimits() {
  buckets.clear();
  lastSweep = Date.now();
}

// ---------------------------------------------------------------------------
// Optional Redis-backed store
// ---------------------------------------------------------------------------

// Minimal structural client type so tests can stub it and callers don't depend
// on ioredis types (the import is lazy and only happens when REDIS_URL is set).
export type RateLimitRedis = {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
};

// undefined = not resolved yet; null = resolved to "no Redis" (in-memory).
let redisClient: RateLimitRedis | null | undefined;

async function getRedis(): Promise<RateLimitRedis | null> {
  if (redisClient !== undefined) return redisClient;

  const url = WEB_ENV.REDIS_URL;
  if (!url) {
    redisClient = null;
    return null;
  }

  try {
    // Same client as the control plane's optional rate-limit store.
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url) as unknown as RateLimitRedis;
    // ioredis emits 'error' events (e.g. connection loss); without a listener
    // they surface as unhandled errors. We log and rely on the per-call
    // fail-open fallback below.
    client.on?.("error", (err) => {
      console.error("[rateLimit] Redis connection error", err);
    });
    redisClient = client;
  } catch (err) {
    console.error(
      "[rateLimit] REDIS_URL is set but ioredis could not be loaded; falling back to in-memory rate limiting (NOT safe across replicas)",
      err,
    );
    redisClient = null;
  }
  return redisClient;
}

/**
 * Record a hit for `key` and return whether it is within `limit` per
 * `windowMs` — like `checkRateLimit`, but distributed when REDIS_URL is set.
 *
 * Redis path: atomic fixed-window INCR; the first hit arms a PEXPIRE for the
 * window. On any Redis error we fail open to the in-memory store so a Redis
 * outage can never block auth or billing flows.
 */
export async function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): Promise<boolean> {
  const redis = await getRedis();
  if (redis) {
    try {
      const redisKey = `ratelimit:${key}`;
      const count = await redis.incr(redisKey);
      if (count === 1) {
        await redis.pexpire(redisKey, windowMs);
      }
      return count <= limit;
    } catch (err) {
      console.error("[rateLimit] Redis error; falling back to in-memory", {
        key,
        err,
      });
    }
  }
  return checkRateLimit(key, limit, windowMs);
}

// Test-only: inject a stub client (or `null` to force in-memory, `undefined`
// to re-resolve from the environment on next use).
export function __setRateLimitRedisForTests(
  client: RateLimitRedis | null | undefined,
) {
  redisClient = client;
}

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  consumeRateLimit,
  __resetRateLimits,
  __setRateLimitRedisForTests,
  type RateLimitRedis,
} from "@/lib/rateLimit";

// Stub implementing the minimal client surface consumeRateLimit uses, with
// call recording so we can assert the INCR + PEXPIRE pattern. No live Redis.
function makeStubRedis() {
  const counters = new Map<string, number>();
  const expirations: Array<{ key: string; ms: number }> = [];
  const client: RateLimitRedis = {
    async incr(key: string) {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    async pexpire(key: string, ms: number) {
      expirations.push({ key, ms });
      return 1;
    },
  };
  return { client, counters, expirations };
}

describe("consumeRateLimit (pluggable store)", () => {
  beforeEach(() => {
    __resetRateLimits();
  });

  afterEach(() => {
    // Force re-resolution from the environment (no REDIS_URL in tests →
    // in-memory) so the stub never leaks into other cases.
    __setRateLimitRedisForTests(undefined);
  });

  it("falls back to the in-memory sliding window when Redis is not configured", async () => {
    __setRateLimitRedisForTests(null);

    for (let i = 0; i < 3; i++) {
      expect(await consumeRateLimit("mem-key", 3, 60_000)).toBe(true);
    }
    expect(await consumeRateLimit("mem-key", 3, 60_000)).toBe(false);
  });

  it("uses Redis (INCR + PEXPIRE, namespaced key) when a client is available", async () => {
    const { client, counters, expirations } = makeStubRedis();
    __setRateLimitRedisForTests(client);

    for (let i = 0; i < 3; i++) {
      expect(await consumeRateLimit("redis-key", 3, 60_000)).toBe(true);
    }
    // 4th hit in the window is blocked.
    expect(await consumeRateLimit("redis-key", 3, 60_000)).toBe(false);

    // Counter lives under the namespaced key…
    expect(counters.get("ratelimit:redis-key")).toBe(4);
    // …and the expiry was armed exactly once, on the first hit.
    expect(expirations).toEqual([{ key: "ratelimit:redis-key", ms: 60_000 }]);
  });

  it("tracks separate budgets per key on the Redis path", async () => {
    const { client } = makeStubRedis();
    __setRateLimitRedisForTests(client);

    for (let i = 0; i < 2; i++) {
      await consumeRateLimit("a", 2, 60_000);
    }
    expect(await consumeRateLimit("a", 2, 60_000)).toBe(false);
    expect(await consumeRateLimit("b", 2, 60_000)).toBe(true);
  });

  it("fails open to the in-memory store when Redis errors", async () => {
    const failing: RateLimitRedis = {
      async incr() {
        throw new Error("connection lost");
      },
      async pexpire() {
        throw new Error("connection lost");
      },
    };
    __setRateLimitRedisForTests(failing);

    // Requests are not blocked by the outage — the in-memory window takes over
    // and still enforces the limit.
    for (let i = 0; i < 2; i++) {
      expect(await consumeRateLimit("fallback-key", 2, 60_000)).toBe(true);
    }
    expect(await consumeRateLimit("fallback-key", 2, 60_000)).toBe(false);
  });
});

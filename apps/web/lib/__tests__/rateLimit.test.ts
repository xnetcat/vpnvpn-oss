import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, __resetRateLimits } from "@/lib/rateLimit";

describe("checkRateLimit (sliding window)", () => {
  beforeEach(() => {
    __resetRateLimits();
  });

  it("allows up to the limit then blocks within the window", () => {
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit("k", 10, 60_000, now)).toBe(true);
    }
    // 11th within the same window is blocked.
    expect(checkRateLimit("k", 10, 60_000, now)).toBe(false);
  });

  it("allows again after the window slides past old hits", () => {
    const start = 2_000_000;
    for (let i = 0; i < 10; i++) {
      checkRateLimit("k2", 10, 60_000, start);
    }
    expect(checkRateLimit("k2", 10, 60_000, start)).toBe(false);
    // 61s later, the original hits have aged out.
    expect(checkRateLimit("k2", 10, 60_000, start + 61_000)).toBe(true);
  });

  it("tracks separate budgets per key", () => {
    const now = 3_000_000;
    for (let i = 0; i < 10; i++) {
      checkRateLimit("a", 10, 60_000, now);
    }
    expect(checkRateLimit("a", 10, 60_000, now)).toBe(false);
    // Different key is unaffected.
    expect(checkRateLimit("b", 10, 60_000, now)).toBe(true);
  });
});

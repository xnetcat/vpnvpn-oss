import { describe, it, expect, vi, beforeEach } from "vitest";
import { createContext } from "../init";
import { appRouter } from "../routers/_app";
import { computeUsageDeltas } from "../routers/analytics";
import type { Session } from "next-auth";

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

describe("Analytics Router — userUsage (per-user usage history)", () => {
  const mockSession: Session = {
    user: { id: "user123", email: "test@test.com", name: "Test User" } as any,
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const mockPrisma = {
    device: { findMany: vi.fn() },
    peerMetric: { findMany: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function caller(session: Session | null = mockSession) {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue(session);
    const ctx = await createContext();
    ctx.prisma = mockPrisma as any;
    ctx.session = session;
    return appRouter.createCaller(ctx);
  }

  it("rejects unauthenticated callers", async () => {
    const c = await caller(null);
    await expect(c.analytics.userUsage()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("returns an empty 30-day series when the user has no devices", async () => {
    mockPrisma.device.findMany.mockResolvedValue([]);
    const c = await caller();
    const res = await c.analytics.userUsage();

    expect(res.devices).toEqual([]);
    expect(res.series).toHaveLength(30);
    expect(res.series.every((d) => d.rxBytes === 0 && d.txBytes === 0)).toBe(
      true,
    );
    expect(res.totalBytes).toBe(0);
    expect(mockPrisma.peerMetric.findMany).not.toHaveBeenCalled();
  });

  it("aggregates reset-aware deltas into per-device totals and a daily series", async () => {
    const now = Date.now();
    const t = (hoursAgo: number) => new Date(now - hoursAgo * 60 * 60 * 1000);

    mockPrisma.device.findMany.mockResolvedValue([
      { id: "dev1", name: "Laptop", publicKey: "pk1" },
      { id: "dev2", name: "Phone", publicKey: "pk2" },
    ]);

    // dev1 reports over WireGuard (publicKey); dev2 over OpenVPN/IKEv2
    // (username = device id). Counters are cumulative; the dev1 stream resets
    // between the 2nd and 3rd sample (daemon restart).
    mockPrisma.peerMetric.findMany.mockResolvedValue([
      // dev1 (WG): first sample contributes 0
      { serverId: "s1", publicKey: "pk1", username: null, rxBytes: 100n, txBytes: 200n, timestamp: t(5) },
      // +50 rx / +60 tx
      { serverId: "s1", publicKey: "pk1", username: null, rxBytes: 150n, txBytes: 260n, timestamp: t(4) },
      // counter went BACKWARDS => reset; delta = current value (+20 / +30)
      { serverId: "s1", publicKey: "pk1", username: null, rxBytes: 20n, txBytes: 30n, timestamp: t(3) },
      // dev2 (username): first sample contributes 0
      { serverId: "s1", publicKey: null, username: "dev2", rxBytes: 1000n, txBytes: 1000n, timestamp: t(2) },
      // +200 rx / +500 tx
      { serverId: "s1", publicKey: null, username: "dev2", rxBytes: 1200n, txBytes: 1500n, timestamp: t(1) },
    ]);

    const c = await caller();
    const res = await c.analytics.userUsage();

    // Query scoped to the caller's device identities and the 30-day window.
    const arg = mockPrisma.peerMetric.findMany.mock.calls[0][0];
    expect(arg.where.OR).toEqual([
      { publicKey: { in: ["pk1", "pk2"] } },
      { username: { in: ["dev1", "dev2"] } },
    ]);
    expect(arg.where.timestamp.gte).toBeInstanceOf(Date);

    const dev1 = res.devices.find((d) => d.deviceId === "dev1");
    const dev2 = res.devices.find((d) => d.deviceId === "dev2");
    expect(dev1).toMatchObject({
      name: "Laptop",
      rxBytes: 70, // 50 + 20 (reset-aware)
      txBytes: 90, // 60 + 30
      totalBytes: 160,
    });
    expect(dev2).toMatchObject({
      name: "Phone",
      rxBytes: 200,
      txBytes: 500,
      totalBytes: 700,
    });

    expect(res.totalRxBytes).toBe(270);
    expect(res.totalTxBytes).toBe(590);
    expect(res.totalBytes).toBe(860);

    // The daily series carries all deltas and spans exactly 30 days.
    expect(res.series).toHaveLength(30);
    const seriesRx = res.series.reduce((sum, d) => sum + d.rxBytes, 0);
    const seriesTx = res.series.reduce((sum, d) => sum + d.txBytes, 0);
    expect(seriesRx).toBe(270);
    expect(seriesTx).toBe(590);
  });

  it("is available to regular users (no admin role required)", async () => {
    mockPrisma.device.findMany.mockResolvedValue([]);
    // protectedProcedure never queries the user's role — a plain session is
    // enough. (adminProcedure would call prisma.user.findUnique, which the
    // mock does not even define.)
    const c = await caller({
      user: { id: "user123", email: "user@user.com" } as any,
      expires: mockSession.expires,
    });
    await expect(c.analytics.userUsage()).resolves.toBeDefined();
  });

  describe("computeUsageDeltas (reset-aware counter math)", () => {
    const base = {
      serverId: "s1",
      publicKey: "pk1",
      username: null as string | null,
    };

    it("computes consecutive deltas and treats a counter drop as a reset", () => {
      const deltas = computeUsageDeltas([
        { ...base, rxBytes: 10n, txBytes: 10n, timestamp: new Date(1000) },
        { ...base, rxBytes: 25n, txBytes: 40n, timestamp: new Date(2000) },
        // reset: current < previous => delta is the current value
        { ...base, rxBytes: 5n, txBytes: 7n, timestamp: new Date(3000) },
      ]);
      expect(deltas).toHaveLength(2);
      expect(deltas[0]).toMatchObject({ rxBytes: 15, txBytes: 30 });
      expect(deltas[1]).toMatchObject({ rxBytes: 5, txBytes: 7 });
    });

    it("keeps streams separate per server and identity", () => {
      const deltas = computeUsageDeltas([
        { ...base, rxBytes: 100n, txBytes: 0n, timestamp: new Date(1000) },
        // Same publicKey but different server: separate stream, first sample.
        { ...base, serverId: "s2", rxBytes: 50n, txBytes: 0n, timestamp: new Date(2000) },
        { ...base, rxBytes: 110n, txBytes: 0n, timestamp: new Date(3000) },
      ]);
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ rxBytes: 10, txBytes: 0 });
    });

    it("skips identity-less samples", () => {
      const deltas = computeUsageDeltas([
        { serverId: "s1", publicKey: null, username: null, rxBytes: 1n, txBytes: 1n, timestamp: new Date(1000) },
        { serverId: "s1", publicKey: null, username: null, rxBytes: 9n, txBytes: 9n, timestamp: new Date(2000) },
      ]);
      expect(deltas).toEqual([]);
    });
  });
});

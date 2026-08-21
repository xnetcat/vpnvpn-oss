import { describe, it, expect, vi, beforeEach } from "vitest";
import { createContext } from "../init";
import { appRouter } from "../routers/_app";

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

describe("Transparency Router (public, unauthenticated)", () => {
  const now = Date.now();
  const recent = new Date(now - 60 * 1000); // 1 min ago -> online window
  const stale = new Date(now - 10 * 60 * 1000); // 10 min ago -> offline window

  const mockPrisma = {
    vpnServer: { findMany: vi.fn() },
    vpnMetric: { findMany: vi.fn() },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Build a caller with NO authenticated session to prove these procedures are
  // reachable without login (they are publicProcedure).
  async function publicCaller() {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue(null);
    const ctx = await createContext();
    ctx.prisma = mockPrisma as any;
    ctx.session = null;
    return appRouter.createCaller(ctx);
  }

  it("overview aggregates health, load and sessions without auth", async () => {
    mockPrisma.vpnServer.findMany.mockResolvedValue([
      {
        lastSeen: recent,
        metadata: { region: "eu" },
        metrics: [
          {
            cpu: 10,
            memory: 0.2,
            activePeers: 5,
            egressBytes: 1000,
            ingressBytes: 500,
            region: "eu",
          },
        ],
      },
      {
        lastSeen: recent,
        metadata: { region: "us" },
        metrics: [
          {
            cpu: 95,
            memory: 0.5,
            activePeers: 2,
            egressBytes: 2000,
            ingressBytes: 1000,
            region: "us",
          },
        ],
      },
      {
        lastSeen: stale,
        metadata: { region: "eu" },
        metrics: [
          {
            cpu: 0,
            memory: 0,
            activePeers: 9,
            egressBytes: 9999,
            ingressBytes: 9999,
            region: "eu",
          },
        ],
      },
    ]);

    const caller = await publicCaller();
    const o = await caller.transparency.overview();

    expect(o.totalServers).toBe(3);
    expect(o.online).toBe(1); // cpu 10 / mem 0.2 -> healthy
    expect(o.degraded).toBe(1); // cpu 95 -> degraded
    expect(o.offline).toBe(1); // stale heartbeat
    expect(o.activeSessions).toBe(7); // 5 + 2; offline node excluded
    expect(o.regions).toBe(2);
    expect(o.avgCpu).toBeCloseTo((10 + 95) / 2);
    // Throughput summed from online nodes only (offline 9999s excluded).
    expect(o.totalEgressBytes).toBe(3000);
    expect(o.totalIngressBytes).toBe(1500);
    expect(o.totalTransferredBytes).toBe(4500);
  });

  it("regions groups servers, counts online nodes and current sessions", async () => {
    mockPrisma.vpnServer.findMany.mockResolvedValue([
      {
        lastSeen: recent,
        metadata: { region: "eu" },
        metrics: [{ activePeers: 5, region: "eu" }],
      },
      {
        lastSeen: stale,
        metadata: { region: "eu" },
        metrics: [{ activePeers: 3, region: "eu" }],
      },
    ]);

    const caller = await publicCaller();
    const r = await caller.transparency.regions();

    expect(r).toHaveLength(1);
    expect(r[0].region).toBe("eu");
    expect(r[0].servers).toBe(2);
    expect(r[0].online).toBe(1);
    expect(r[0].sessions).toBe(5); // offline server contributes 0
  });

  it("history buckets samples into the same time window", async () => {
    const t = new Date(now - 30 * 60 * 1000);
    mockPrisma.vpnMetric.findMany.mockResolvedValue([
      { timestamp: t, activePeers: 4, cpu: 20, memory: 0.3 },
      { timestamp: t, activePeers: 6, cpu: 40, memory: 0.5 },
    ]);

    const caller = await publicCaller();
    const h = await caller.transparency.history({ period: "24h" });

    expect(h).toHaveLength(1);
    expect(h[0].sessions).toBe(10);
    expect(h[0].avgCpu).toBeCloseTo(30);
    expect(h[0].avgMemory).toBeCloseTo(0.4);
  });

  it("does not expose any user-identifying fields", async () => {
    mockPrisma.vpnServer.findMany.mockResolvedValue([
      {
        lastSeen: recent,
        metadata: { region: "eu" },
        metrics: [{ cpu: 10, memory: 0.2, activePeers: 1, region: "eu" }],
      },
    ]);

    const caller = await publicCaller();
    const o = await caller.transparency.overview();
    const serialized = JSON.stringify(o);

    expect(serialized).not.toMatch(/email/i);
    expect(serialized).not.toMatch(/publicKey/i);
    expect(serialized).not.toMatch(/userId/i);
  });
});

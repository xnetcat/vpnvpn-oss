import { z } from "zod";
import { router, publicProcedure } from "../init";

// Public, UNAUTHENTICATED transparency metrics for the public dashboard.
//
// This router intentionally exposes ONLY aggregated, non-identifying fleet
// data: server counts, health, load (CPU/memory), active session counts and
// per-region distribution. It must NEVER return user data, e-mail addresses,
// peer public keys, or any per-user information — that is what keeps it safe to
// serve without authentication. (Contrast with `analyticsRouter`, which is
// admin-only and returns PII such as e-mails.)

// A server is considered offline once it has not sent a heartbeat for longer
// than this window (matches the control-plane / analytics offline threshold).
const OFFLINE_AFTER_MS = 5 * 60 * 1000;

export const transparencyRouter = router({
  // Current fleet snapshot: server health, aggregate load and active sessions.
  overview: publicProcedure.query(async ({ ctx }) => {
    const servers = await ctx.prisma.vpnServer.findMany({
      include: {
        metrics: { orderBy: { timestamp: "desc" }, take: 1 },
      },
    });

    const now = Date.now();
    let online = 0;
    let offline = 0;
    let degraded = 0;
    let activeSessions = 0;
    let cpuSum = 0;
    let cpuCount = 0;
    let memSum = 0;
    let memCount = 0;
    let egressTotal = 0;
    let ingressTotal = 0;
    const regions = new Set<string>();

    for (const server of servers) {
      const lastSeen = server.lastSeen?.getTime() ?? 0;
      const metric = server.metrics[0];
      const isOffline = now - lastSeen > OFFLINE_AFTER_MS;

      if (isOffline) {
        offline += 1;
      } else {
        const cpu = metric?.cpu ?? 0;
        const memory = metric?.memory ?? 0;
        if (cpu > 90 || memory > 0.9) {
          degraded += 1;
        } else {
          online += 1;
        }
        activeSessions += metric?.activePeers ?? 0;
        if (metric?.cpu != null) {
          cpuSum += metric.cpu;
          cpuCount += 1;
        }
        if (metric?.memory != null) {
          memSum += metric.memory;
          memCount += 1;
        }
        egressTotal += metric?.egressBytes ?? 0;
        ingressTotal += metric?.ingressBytes ?? 0;
      }

      const metadata = (server.metadata as Record<string, unknown>) || {};
      const region = (metadata.region as string) || metric?.region || null;
      if (region) regions.add(region);
    }

    return {
      totalServers: servers.length,
      online,
      degraded,
      offline,
      activeSessions,
      regions: regions.size,
      avgCpu: cpuCount > 0 ? cpuSum / cpuCount : null,
      avgMemory: memCount > 0 ? memSum / memCount : null,
      totalEgressBytes: egressTotal,
      totalIngressBytes: ingressTotal,
      totalTransferredBytes: egressTotal + ingressTotal,
      generatedAt: new Date().toISOString(),
    };
  }),

  // Per-region distribution: server counts and current sessions by region.
  regions: publicProcedure.query(async ({ ctx }) => {
    const servers = await ctx.prisma.vpnServer.findMany({
      include: {
        metrics: { orderBy: { timestamp: "desc" }, take: 1 },
      },
    });

    const now = Date.now();
    const byRegion = new Map<
      string,
      { region: string; servers: number; online: number; sessions: number }
    >();

    for (const server of servers) {
      const metadata = (server.metadata as Record<string, unknown>) || {};
      const metric = server.metrics[0];
      const region =
        (metadata.region as string) || metric?.region || "Unknown";
      const isOnline =
        now - (server.lastSeen?.getTime() ?? 0) <= OFFLINE_AFTER_MS;
      const sessions = isOnline ? (metric?.activePeers ?? 0) : 0;

      const existing = byRegion.get(region);
      if (existing) {
        existing.servers += 1;
        if (isOnline) existing.online += 1;
        existing.sessions += sessions;
      } else {
        byRegion.set(region, {
          region,
          servers: 1,
          online: isOnline ? 1 : 0,
          sessions,
        });
      }
    }

    return Array.from(byRegion.values()).sort((a, b) =>
      a.region.localeCompare(b.region),
    );
  }),

  // Historical fleet load (avg CPU/memory and total sessions) over a window.
  history: publicProcedure
    .input(
      z.object({
        period: z.enum(["24h", "7d", "30d"]).default("24h"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const now = new Date();
      let startDate: Date;
      let intervalMinutes: number;

      switch (input.period) {
        case "24h":
          startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
          intervalMinutes = 60;
          break;
        case "7d":
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          intervalMinutes = 360;
          break;
        case "30d":
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          intervalMinutes = 1440;
          break;
      }

      const metrics = await ctx.prisma.vpnMetric.findMany({
        where: { timestamp: { gte: startDate } },
        orderBy: { timestamp: "asc" },
        select: {
          timestamp: true,
          activePeers: true,
          cpu: true,
          memory: true,
        },
      });

      const buckets = new Map<
        string,
        {
          timestamp: Date;
          sessions: number;
          cpu: number;
          memory: number;
          count: number;
        }
      >();

      for (const m of metrics) {
        const bucketTime = new Date(
          Math.floor(m.timestamp.getTime() / (intervalMinutes * 60 * 1000)) *
            intervalMinutes *
            60 *
            1000,
        );
        const key = bucketTime.toISOString();

        const existing = buckets.get(key);
        if (existing) {
          existing.sessions += m.activePeers ?? 0;
          existing.cpu += m.cpu ?? 0;
          existing.memory += m.memory ?? 0;
          existing.count += 1;
        } else {
          buckets.set(key, {
            timestamp: bucketTime,
            sessions: m.activePeers ?? 0,
            cpu: m.cpu ?? 0,
            memory: m.memory ?? 0,
            count: 1,
          });
        }
      }

      return Array.from(buckets.values())
        .map((b) => ({
          timestamp: b.timestamp.toISOString(),
          sessions: b.sessions,
          avgCpu: b.count > 0 ? b.cpu / b.count : 0,
          avgMemory: b.count > 0 ? b.memory / b.count : 0,
        }))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }),
});

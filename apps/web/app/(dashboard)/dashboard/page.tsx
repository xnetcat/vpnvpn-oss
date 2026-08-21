import { requireUser } from "@/lib/requirePaidUser";
import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getTierConfig } from "@/lib/tiers";
import { Server, Smartphone, Activity, Sparkles, BarChart3 } from "lucide-react";
import { createContext } from "@/lib/trpc/init";
import { appRouter } from "@/lib/trpc/routers/_app";
import UsageChart, { formatBytes } from "@/components/UsageChart";

async function getDashboardData(userId: string) {
  const [devices, subscription, serversMetrics, latestDevice, usage] =
    await Promise.all([
      prisma.device.count({ where: { userId } }),
      prisma.subscription.findFirst({
        where: {
          userId,
          status: { in: ["active", "trialing"] },
        },
      }),
      fetchServerMetrics(),
      prisma.device.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      }),
      fetchUserUsage(),
    ]);

  return {
    devices,
    subscription,
    servers: serversMetrics,
    latestDevice,
    usage,
  };
}

async function fetchUserUsage() {
  try {
    const ctx = await createContext();
    const caller = appRouter.createCaller(ctx);
    return await caller.analytics.userUsage();
  } catch (err) {
    console.error("Failed to fetch usage history", err);
    return null;
  }
}

async function fetchServerMetrics() {
  try {
    const ctx = await createContext();
    const caller = appRouter.createCaller(ctx);
    const servers = await caller.servers.list();

    const total = servers.length;
    const online = servers.filter(
      (s: (typeof servers)[number]) => s.status === "online",
    ).length;
    const totalSessions = servers.reduce(
      (sum: number, s: (typeof servers)[number]) => sum + (s.sessions || 0),
      0,
    );

    return { total, online, totalSessions };
  } catch (err) {
    console.error("Failed to fetch server metrics", err);
    return { total: 0, online: 0, totalSessions: 0 };
  }
}

export default async function DashboardPage() {
  const gate = await requireUser();
  if (!gate.ok) {
    redirect("/api/auth/signin");
  }

  const { devices, subscription, servers, latestDevice, usage } =
    await getDashboardData(gate.userId);
  const tierConfig = getTierConfig(gate.tier);
  const isFreeTier = gate.tier === "free";

  return (
    <main className="mx-auto max-w-6xl p-6 text-slate-50">
      <div className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">Dashboard</h1>
          <p className="mt-1 text-sm text-slate-400">
            {tierConfig.name} Plan • {devices} / {tierConfig.deviceLimit}{" "}
            devices
          </p>
        </div>
        <div className="max-w-md rounded-md border border-slate-800 bg-slate-900/80 px-4 py-3 text-sm text-slate-300 shadow-sm shadow-slate-900/40">
          <div className="text-xs font-semibold uppercase tracking-wide text-emerald-400">
            Device provisioning
          </div>
          <p className="mt-1">
            Add and register devices from the vpnVPN desktop app. Manual device
            creation in the web dashboard is disabled.
          </p>
        </div>
      </div>

      {/* Key Metrics */}
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-400">
              Your Devices
            </div>
            <Smartphone className="h-5 w-5 text-emerald-400" />
          </div>
          <div className="text-3xl font-bold text-slate-50">{devices}</div>
          <p className="mt-1 text-xs text-slate-400">
            of {tierConfig.deviceLimit} allowed
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-400">
              Available Servers
            </div>
            <Server className="h-5 w-5 text-emerald-400" />
          </div>
          <div className="text-3xl font-bold text-slate-50">
            {servers.online}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {servers.total} total servers
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-400">
              Active Sessions
            </div>
            <Activity className="h-5 w-5 text-sky-400" />
          </div>
          <div className="text-3xl font-bold text-slate-50">
            {servers.totalSessions}
          </div>
          <p className="mt-1 text-xs text-slate-400">across all servers</p>
        </div>
      </div>

      {/* Usage history (last 30 days) */}
      {usage && (
        <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
          <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-emerald-400" />
              <h2 className="text-lg font-semibold text-slate-50">Usage</h2>
            </div>
            <p className="text-sm text-slate-400">
              <span className="font-semibold text-slate-100">
                {formatBytes(usage.totalBytes)}
              </span>{" "}
              transferred in the last {usage.windowDays} days
              {/* Counters are from the server's perspective: tx = sent to the
                  device (download), rx = received from it (upload). */}
              <span className="ml-2 text-xs text-slate-500">
                ↓ {formatBytes(usage.totalTxBytes)} · ↑{" "}
                {formatBytes(usage.totalRxBytes)}
              </span>
            </p>
          </div>
          <UsageChart series={usage.series} />
        </div>
      )}

      {/* Free tier upgrade prompt */}
      {isFreeTier && (
        <div className="mb-6 flex flex-col gap-4 rounded-lg border border-emerald-600/50 bg-emerald-500/10 p-6 shadow-sm shadow-emerald-900/30 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-emerald-300" />
            <div>
              <h2 className="text-sm font-semibold text-emerald-100">
                You&apos;re on the Free plan
              </h2>
              <p className="mt-1 text-xs text-emerald-50/80">
                Free includes 1 device with access to all servers. Upgrade for
                more devices and priority support.
              </p>
            </div>
          </div>
          <Link
            href="/pricing"
            className="inline-flex shrink-0 items-center justify-center rounded-md bg-emerald-400 px-4 py-2 text-xs font-semibold text-slate-950 shadow-md shadow-emerald-500/40 transition hover:bg-emerald-300"
          >
            View plans
          </Link>
        </div>
      )}

      {/* Subscription Status */}
      {subscription && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
          <h2 className="mb-4 text-lg font-semibold text-slate-50">
            Subscription Status
          </h2>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <div>
              <div className="mb-1 text-sm text-slate-400">Plan</div>
              <div className="font-medium text-slate-50">{tierConfig.name}</div>
            </div>
            <div>
              <div className="mb-1 text-sm text-slate-400">Status</div>
              <div className="font-medium capitalize text-slate-50">
                {subscription.status}
              </div>
            </div>
            <div>
              <div className="mb-1 text-sm text-slate-400">Renews</div>
              <div className="font-medium text-slate-50">
                {subscription.currentPeriodEnd
                  ? new Date(subscription.currentPeriodEnd).toLocaleDateString()
                  : "—"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Current VPN */}
      {latestDevice && (
        <div className="mt-6 rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
          <h2 className="mb-2 text-lg font-semibold text-slate-50">
            Current VPN configuration
          </h2>
          <p className="text-sm text-slate-400">
            Latest device:{" "}
            <span className="font-medium text-slate-100">
              {latestDevice.name}
            </span>{" "}
            {latestDevice.serverId
              ? `connected via server ${latestDevice.serverId}`
              : "(auto-selected server)"}
            . Each device keeps its own credentials and tunnel IP, up to your
            plan&apos;s device limit. Removing a device revokes only that
            device&apos;s access.
          </p>
        </div>
      )}
    </main>
  );
}

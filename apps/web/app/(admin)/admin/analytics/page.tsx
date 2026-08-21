import { requireAdmin } from "@/lib/requireAdmin";
import { redirect } from "next/navigation";
import { createContext } from "@/lib/trpc/init";
import { appRouter } from "@/lib/trpc/routers/_app";
import {
  Users,
  CreditCard,
  Smartphone,
  Server,
  TrendingUp,
  Globe,
  Activity,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";

type AnalyticsPageProps = {
  searchParams?: Promise<{ period?: string }>;
};

export default async function AnalyticsPage({
  searchParams,
}: AnalyticsPageProps) {
  const gate = await requireAdmin();
  if (!gate.ok) {
    redirect(gate.reason === "unauthenticated" ? "/api/auth/signin" : "/");
  }

  const ctx = await createContext();
  const caller = appRouter.createCaller(ctx);

  const resolvedParams = (await searchParams) || {};
  const period = (resolvedParams.period as "24h" | "7d" | "30d") || "24h";

  const [
    summary,
    historicalMetrics,
    geoDistribution,
    serverHealth,
    recentActivity,
  ] = await Promise.all([
    caller.analytics.summary(),
    caller.analytics.historicalMetrics({ period }),
    caller.analytics.geoDistribution(),
    caller.analytics.serverHealth(),
    caller.analytics.recentActivity(),
  ]);

  const peakSessions =
    historicalMetrics.length > 0
      ? Math.max(...historicalMetrics.map((m) => m.sessions))
      : 0;

  const avgCpu =
    historicalMetrics.length > 0
      ? historicalMetrics.reduce((sum, m) => sum + m.avgCpu, 0) /
        historicalMetrics.length
      : 0;

  return (
    <main className="mx-auto max-w-7xl p-6 text-slate-50">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">
            Analytics Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Usage metrics, trends, and system health
          </p>
        </div>
        <Link
          href="/admin"
          className="rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-slate-800"
        >
          Back to Admin
        </Link>
      </div>

      {/* Period Selector */}
      <div className="mb-6">
        <form className="inline-flex gap-2 rounded-lg border border-slate-800 bg-slate-900/80 p-1">
          {(["24h", "7d", "30d"] as const).map((p) => (
            <button
              key={p}
              type="submit"
              name="period"
              value={p}
              className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                period === p
                  ? "bg-emerald-500 text-slate-950"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-50"
              }`}
            >
              {p === "24h" ? "24 Hours" : p === "7d" ? "7 Days" : "30 Days"}
            </button>
          ))}
        </form>
      </div>

      {/* Key Metrics */}
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-400">
              Total Users
            </div>
            <Users className="h-5 w-5 text-emerald-400" />
          </div>
          <div className="text-3xl font-bold text-slate-50">
            {summary.totalUsers.toLocaleString()}
          </div>
          <p className="mt-1 text-xs text-emerald-400">
            +{summary.recentSignups} this week
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-400">
              Active Subscriptions
            </div>
            <CreditCard className="h-5 w-5 text-sky-400" />
          </div>
          <div className="text-3xl font-bold text-slate-50">
            {summary.activeSubscriptions.toLocaleString()}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {summary.totalUsers > 0
              ? (
                  (summary.activeSubscriptions / summary.totalUsers) *
                  100
                ).toFixed(1)
              : 0}
            % conversion
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-400">
              Registered Devices
            </div>
            <Smartphone className="h-5 w-5 text-violet-400" />
          </div>
          <div className="text-3xl font-bold text-slate-50">
            {summary.totalDevices.toLocaleString()}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {summary.activeSubscriptions > 0
              ? (summary.totalDevices / summary.activeSubscriptions).toFixed(1)
              : 0}{" "}
            avg per user
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-slate-400">
              Peak Sessions
            </div>
            <TrendingUp className="h-5 w-5 text-orange-400" />
          </div>
          <div className="text-3xl font-bold text-slate-50">{peakSessions}</div>
          <p className="mt-1 text-xs text-slate-400">in selected period</p>
        </div>
      </div>

      {/* Tier Breakdown & Server Health */}
      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Tier Breakdown */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-slate-50">
            Subscription Tiers
          </h2>
          <div className="space-y-4">
            {["basic", "pro", "enterprise"].map((tier) => {
              const count = summary.tierBreakdown[tier] || 0;
              const percentage =
                summary.activeSubscriptions > 0
                  ? (count / summary.activeSubscriptions) * 100
                  : 0;
              const colors = {
                basic: "bg-slate-500",
                pro: "bg-emerald-500",
                enterprise: "bg-violet-500",
              };
              return (
                <div key={tier}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="capitalize text-slate-300">{tier}</span>
                    <span className="text-slate-400">
                      {count} ({percentage.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className={`h-full ${colors[tier as keyof typeof colors]}`}
                      style={{ width: `${percentage}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Server Health */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-slate-50">
            Server Health
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-emerald-500/10 p-4">
              <div className="mb-1 flex items-center gap-2">
                <Server className="h-4 w-4 text-emerald-400" />
                <span className="text-sm text-slate-400">Online</span>
              </div>
              <div className="text-2xl font-bold text-emerald-400">
                {serverHealth.online}
              </div>
            </div>
            <div className="rounded-lg bg-orange-500/10 p-4">
              <div className="mb-1 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-orange-400" />
                <span className="text-sm text-slate-400">Degraded</span>
              </div>
              <div className="text-2xl font-bold text-orange-400">
                {serverHealth.degraded}
              </div>
            </div>
            <div className="rounded-lg bg-red-500/10 p-4">
              <div className="mb-1 flex items-center gap-2">
                <Activity className="h-4 w-4 text-red-400" />
                <span className="text-sm text-slate-400">Offline</span>
              </div>
              <div className="text-2xl font-bold text-red-400">
                {serverHealth.offline}
              </div>
            </div>
            <div className="rounded-lg bg-slate-800 p-4">
              <div className="mb-1 flex items-center gap-2">
                <Globe className="h-4 w-4 text-slate-400" />
                <span className="text-sm text-slate-400">Total</span>
              </div>
              <div className="text-2xl font-bold text-slate-50">
                {serverHealth.total}
              </div>
            </div>
          </div>
          <div className="mt-4 text-sm text-slate-400">
            Avg CPU: {avgCpu.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Historical Chart (simplified bar representation) */}
      <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-slate-50">
          Session History
        </h2>
        {historicalMetrics.length > 0 ? (
          <div className="flex h-40 items-end gap-1">
            {historicalMetrics.slice(-24).map((m, i) => {
              const height =
                peakSessions > 0 ? (m.sessions / peakSessions) * 100 : 0;
              return (
                <div
                  key={i}
                  className="group relative flex-1 rounded-t bg-emerald-500/80 transition-colors hover:bg-emerald-400"
                  style={{ height: `${Math.max(height, 2)}%` }}
                >
                  <div className="absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-slate-200 group-hover:block">
                    {m.sessions} sessions
                    <br />
                    {new Date(m.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-slate-400">
            No historical data available for this period
          </p>
        )}
        <div className="mt-2 flex justify-between text-xs text-slate-500">
          <span>
            {historicalMetrics.length > 0
              ? new Date(historicalMetrics[0]?.timestamp).toLocaleDateString()
              : ""}
          </span>
          <span>
            {historicalMetrics.length > 0
              ? new Date(
                  historicalMetrics[historicalMetrics.length - 1]?.timestamp,
                ).toLocaleDateString()
              : ""}
          </span>
        </div>
      </div>

      {/* Geographic Distribution */}
      <div className="mb-8 rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-slate-50">
          Geographic Distribution
        </h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-800">
            <thead>
              <tr>
                <th className="px-4 py-2 text-left text-sm font-medium text-slate-400">
                  Region
                </th>
                <th className="px-4 py-2 text-left text-sm font-medium text-slate-400">
                  Servers
                </th>
                <th className="px-4 py-2 text-left text-sm font-medium text-slate-400">
                  Active Sessions
                </th>
                <th className="px-4 py-2 text-left text-sm font-medium text-slate-400">
                  Load
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {geoDistribution.map((geo) => (
                <tr key={geo.region} className="hover:bg-slate-800/50">
                  <td className="px-4 py-3 text-sm font-medium text-slate-200">
                    {geo.region}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-300">
                    {geo.servers}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-300">
                    {geo.sessions}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full bg-emerald-500"
                          style={{
                            width: `${Math.min((geo.sessions / (geo.servers * 100)) * 100, 100)}%`,
                          }}
                        />
                      </div>
                      <span className="text-xs text-slate-400">
                        {geo.servers > 0
                          ? Math.round(geo.sessions / geo.servers)
                          : 0}
                        /server
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
              {geoDistribution.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-sm text-slate-400"
                  >
                    No regional data available
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Recent Devices */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-slate-50">
            Recent Device Registrations
          </h2>
          <div className="space-y-3">
            {recentActivity.recentDevices.map((device) => (
              <div
                key={device.id}
                className="flex items-center justify-between rounded-lg bg-slate-800/50 px-4 py-3"
              >
                <div>
                  <div className="text-sm font-medium text-slate-200">
                    {device.name}
                  </div>
                  <div className="text-xs text-slate-400">{device.email}</div>
                </div>
                <div className="text-xs text-slate-500">
                  {new Date(device.createdAt).toLocaleDateString()}
                </div>
              </div>
            ))}
            {recentActivity.recentDevices.length === 0 && (
              <p className="py-4 text-center text-sm text-slate-400">
                No recent device registrations
              </p>
            )}
          </div>
        </div>

        {/* Recent Subscriptions */}
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm">
          <h2 className="mb-4 text-lg font-semibold text-slate-50">
            Recent Subscriptions
          </h2>
          <div className="space-y-3">
            {recentActivity.recentSubscriptions.map((sub) => (
              <div
                key={sub.id}
                className="flex items-center justify-between rounded-lg bg-slate-800/50 px-4 py-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium capitalize text-slate-200">
                      {sub.tier}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        sub.status === "active"
                          ? "bg-emerald-500/20 text-emerald-400"
                          : "bg-slate-700 text-slate-400"
                      }`}
                    >
                      {sub.status}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">{sub.email}</div>
                </div>
                <div className="text-xs text-slate-500">
                  {new Date(sub.createdAt).toLocaleDateString()}
                </div>
              </div>
            ))}
            {recentActivity.recentSubscriptions.length === 0 && (
              <p className="py-4 text-center text-sm text-slate-400">
                No recent subscriptions
              </p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

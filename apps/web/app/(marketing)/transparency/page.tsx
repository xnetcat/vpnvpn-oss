import type { Metadata } from "next";
import { createContext } from "@/lib/trpc/init";
import { appRouter } from "@/lib/trpc/routers/_app";

// The dashboard reads live fleet state from the database on every request, so
// it must never be statically pre-rendered at build time (no DB there).
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Transparency — vpnVPN",
  description:
    "Public, real-time view of the vpnVPN fleet: server load, health and active sessions. No traffic is logged.",
};

function pct(value: number | null, scale: 1 | 100): string {
  if (value === null) return "—";
  const v = scale === 100 ? value : value * 100;
  return `${Math.round(v)}%`;
}

function loadTone(percent: number): string {
  if (percent >= 90) return "bg-rose-400";
  if (percent >= 70) return "bg-amber-400";
  return "bg-emerald-400";
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default async function TransparencyPage() {
  const ctx = await createContext();
  const caller = appRouter.createCaller(ctx);

  const [overview, regions, history] = await Promise.all([
    caller.transparency.overview(),
    caller.transparency.regions(),
    caller.transparency.history({ period: "24h" }),
  ]);

  const hasFleet = overview.totalServers > 0;
  const maxSessions = Math.max(1, ...history.map((h) => h.sessions));
  const avgCpuPct = overview.avgCpu ?? 0;
  const avgMemPct = (overview.avgMemory ?? 0) * 100;

  const stats: { label: string; value: string; sub: string }[] = [
    {
      label: "Online servers",
      value: hasFleet ? `${overview.online + overview.degraded}` : "—",
      sub: `of ${overview.totalServers} total`,
    },
    {
      label: "Active sessions",
      value: hasFleet ? `${overview.activeSessions}` : "—",
      sub: "current across the fleet",
    },
    {
      label: "Avg. CPU load",
      value: pct(overview.avgCpu, 100),
      sub: "across online nodes",
    },
    {
      label: "Avg. memory",
      value: pct(overview.avgMemory, 1),
      sub: "across online nodes",
    },
    {
      label: "Regions",
      value: hasFleet ? `${overview.regions}` : "—",
      sub: "geographic coverage",
    },
    {
      label: "Data served",
      value: hasFleet ? formatBytes(overview.totalTransferredBytes) : "—",
      sub: "egress + ingress",
    },
  ];

  return (
    <main className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-slate-950 via-slate-950 to-slate-950" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(16,185,129,0.16),transparent_35%),radial-gradient(circle_at_85%_10%,rgba(56,189,248,0.14),transparent_30%)]" />

      <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-14 sm:px-6 lg:px-8">
        {/* Header */}
        <section className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-200">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
            Live fleet metrics
          </div>
          <h1 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
            Transparency dashboard
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-slate-200/80 sm:text-base">
            A public, real-time view of the vpnVPN fleet — server load, health
            and active sessions, aggregated across all regions. We publish
            operational health, never your activity:{" "}
            <span className="font-medium text-emerald-200">
              no traffic content or destination addresses are logged
            </span>
            . Figures below contain no user-identifying data.
          </p>
        </section>

        {/* Stat cards */}
        <section className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {stats.map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-slate-800 bg-slate-900/60 p-4"
            >
              <div className="text-[11px] uppercase tracking-wide text-slate-500">
                {s.label}
              </div>
              <div className="mt-1 text-2xl font-semibold text-white">
                {s.value}
              </div>
              <div className="mt-0.5 text-[11px] text-slate-500">{s.sub}</div>
            </div>
          ))}
        </section>

        {/* Fleet health */}
        <section className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-white">Fleet health</h2>
          {hasFleet ? (
            <>
              <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-slate-800">
                <div
                  className="bg-emerald-400"
                  style={{
                    width: `${(overview.online / overview.totalServers) * 100}%`,
                  }}
                />
                <div
                  className="bg-amber-400"
                  style={{
                    width: `${(overview.degraded / overview.totalServers) * 100}%`,
                  }}
                />
                <div
                  className="bg-rose-500"
                  style={{
                    width: `${(overview.offline / overview.totalServers) * 100}%`,
                  }}
                />
              </div>
              <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-300">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  Online {overview.online}
                </span>
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  Degraded {overview.degraded}
                </span>
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                  Offline {overview.offline}
                </span>
              </div>
            </>
          ) : (
            <p className="mt-3 text-xs text-slate-400">
              No servers are reporting yet. Metrics will appear as soon as a
              node registers with the control plane.
            </p>
          )}
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          {/* Sessions over last 24h */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">
                Active sessions — last 24h
              </h2>
              <span className="text-[11px] text-slate-500">hourly</span>
            </div>
            {history.length > 0 ? (
              <div className="mt-5 flex h-40 items-end gap-1">
                {history.map((h) => {
                  const heightPct = (h.sessions / maxSessions) * 100;
                  const cpuTone = loadTone(h.avgCpu);
                  const label = new Date(h.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                  });
                  return (
                    <div
                      key={h.timestamp}
                      className="group flex flex-1 flex-col items-center justify-end"
                      title={`${label}: ${h.sessions} sessions, CPU ${Math.round(h.avgCpu)}%`}
                    >
                      <div
                        className={`w-full rounded-t ${cpuTone} opacity-80 transition group-hover:opacity-100`}
                        style={{ height: `${Math.max(2, heightPct)}%` }}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-3 text-xs text-slate-400">
                No samples in this window yet.
              </p>
            )}
            <p className="mt-3 text-[11px] text-slate-500">
              Bar height = active sessions; colour reflects average CPU load
              (green &lt; 70%, amber &lt; 90%, red ≥ 90%).
            </p>
          </section>

          {/* Per-region distribution */}
          <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
            <h2 className="text-sm font-semibold text-white">
              By region
            </h2>
            <div className="mt-4 overflow-hidden rounded-lg border border-slate-800">
              <table className="min-w-full divide-y divide-slate-800 text-xs">
                <thead className="bg-slate-900/80 text-[11px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Region</th>
                    <th className="px-3 py-2 text-right">Online</th>
                    <th className="px-3 py-2 text-right">Sessions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-900/60">
                  {regions.length > 0 ? (
                    regions.map((r) => (
                      <tr key={r.region}>
                        <td className="px-3 py-1.5 text-slate-100">
                          {r.region}
                        </td>
                        <td className="px-3 py-1.5 text-right text-slate-300">
                          {r.online}/{r.servers}
                        </td>
                        <td className="px-3 py-1.5 text-right text-slate-100">
                          {r.sessions}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        className="px-3 py-2 text-center text-slate-500"
                        colSpan={3}
                      >
                        No regions reporting yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
                <div className="text-[11px] text-slate-400">Avg. CPU</div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className={loadTone(avgCpuPct)}
                    style={{ width: `${Math.min(100, avgCpuPct)}%`, height: "100%" }}
                  />
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
                <div className="text-[11px] text-slate-400">Avg. memory</div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className={loadTone(avgMemPct)}
                    style={{ width: `${Math.min(100, avgMemPct)}%`, height: "100%" }}
                  />
                </div>
              </div>
            </div>
          </section>
        </div>

        <p className="mt-6 text-center text-[11px] text-slate-500">
          Updated {new Date(overview.generatedAt).toLocaleString()} · Aggregated
          from the control plane · Contains no user-identifying data.
        </p>
      </div>
    </main>
  );
}

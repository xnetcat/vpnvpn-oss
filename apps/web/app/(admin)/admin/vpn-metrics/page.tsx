import { requireAdmin } from "@/lib/requireAdmin";
import { redirect } from "next/navigation";
import { createContext } from "@/lib/trpc/init";
import { appRouter } from "@/lib/trpc/routers/_app";

type ServerMetric = {
  id: string;
  country?: string;
  region?: string;
  status: string;
  sessions: number;
};

type MetricsPageProps = {
  searchParams?: Promise<{ [key: string]: string | string[] | undefined }>;
};

export default async function AdminVpnMetricsPage({
  searchParams,
}: MetricsPageProps) {
  const gate = await requireAdmin();
  if (!gate.ok) {
    redirect(gate.reason === "unauthenticated" ? "/api/auth/signin" : "/");
  }

  const ctx = await createContext();
  const caller = appRouter.createCaller(ctx);
  const raw = (await caller.admin.listServers()) as any[];

  const allServers: ServerMetric[] = raw.map((s) => ({
    id: s.id ?? "unknown",
    country: s.country ?? s.metadata?.country,
    region: s.region ?? s.metadata?.region,
    status: s.status ?? "unknown",
    sessions:
      (s.metrics && typeof s.metrics.sessions === "number"
        ? s.metrics.sessions
        : 0) || 0,
  }));

  const resolvedSearch =
    (searchParams && (await searchParams)) ||
    ({} as Record<string, string | string[] | undefined>);

  const statusFilter =
    (resolvedSearch.status as string | undefined)?.toLowerCase() || "all";
  const countryFilter =
    (resolvedSearch.country as string | undefined)?.toLowerCase() || "all";
  const regionFilter =
    (resolvedSearch.region as string | undefined)?.toLowerCase() || "all";

  const filteredServers = allServers.filter((s) => {
    if (statusFilter !== "all" && s.status.toLowerCase() !== statusFilter) {
      return false;
    }
    if (
      countryFilter !== "all" &&
      (s.country ?? "").toLowerCase() !== countryFilter
    ) {
      return false;
    }
    if (
      regionFilter !== "all" &&
      (s.region ?? "").toLowerCase() !== regionFilter
    ) {
      return false;
    }
    return true;
  });

  const totalSessions = filteredServers.reduce(
    (sum, s) => sum + (s.sessions || 0),
    0,
  );
  const onlineServers = filteredServers.filter(
    (s) => s.status === "online",
  ).length;

  const byCountry = filteredServers.reduce<Record<string, number>>((acc, s) => {
    const key = s.country || "Unknown";
    acc[key] = (acc[key] || 0) + (s.sessions || 0);
    return acc;
  }, {});

  const allCountries = Array.from(
    new Set(
      allServers
        .map((s) => s.country?.toLowerCase())
        .filter((c): c is string => Boolean(c)),
    ),
  ).sort();

  const allRegions = Array.from(
    new Set(
      allServers
        .map((s) => s.region?.toLowerCase())
        .filter((r): r is string => Boolean(r)),
    ),
  ).sort();

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 pb-10 pt-4 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
          Metrics
        </p>
        <h1 className="text-2xl font-semibold text-slate-50">VPN Metrics</h1>
        <p className="text-sm text-slate-400">
          Aggregate sessions and load by server and country.
        </p>
      </div>

      <form className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/80 p-4 text-sm text-slate-200 shadow-sm shadow-black/20 backdrop-blur">
        <label className="flex items-center gap-2">
          <span>Status</span>
          <select
            name="status"
            defaultValue={statusFilter}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
          >
            <option value="all">All</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span>Country</span>
          <select
            name="country"
            defaultValue={countryFilter}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
          >
            <option value="all">All</option>
            {allCountries.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span>Region</span>
          <select
            name="region"
            defaultValue={regionFilter}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
          >
            <option value="all">All</option>
            {allRegions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          className="rounded-md border border-amber-500/40 bg-amber-500/20 px-3 py-1.5 text-sm font-semibold text-amber-100 transition hover:border-amber-400 hover:bg-amber-500/30"
        >
          Apply
        </button>
      </form>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-black/20">
          <div className="mb-1 text-sm text-slate-400">Online servers</div>
          <div className="text-3xl font-bold text-slate-50">
            {onlineServers}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            of {filteredServers.length} matched servers
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-black/20">
          <div className="mb-1 text-sm text-slate-400">Active sessions</div>
          <div className="text-3xl font-bold text-slate-50">
            {totalSessions}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            current sessions across all protocols
          </p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-black/20">
          <div className="mb-1 text-sm text-slate-400">Countries</div>
          <div className="text-3xl font-bold text-slate-50">
            {Object.keys(byCountry).length}
          </div>
          <p className="mt-1 text-xs text-slate-500">
            based on server metadata reported at registration
          </p>
        </div>
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-black/20">
        <h2 className="mb-4 text-lg font-semibold text-slate-50">
          Sessions by country
        </h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-800">
            <thead className="bg-slate-900/80">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Country
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Sessions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {Object.entries(byCountry).map(([country, sessions]) => (
                <tr
                  key={country}
                  className="bg-slate-950/40 hover:bg-slate-800/70"
                >
                  <td className="px-4 py-3 text-sm text-slate-200">
                    {country}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-200">
                    {sessions}
                  </td>
                </tr>
              ))}
              {Object.keys(byCountry).length === 0 && (
                <tr>
                  <td
                    colSpan={2}
                    className="px-4 py-6 text-center text-sm text-slate-400"
                  >
                    No metrics available yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-black/20">
        <h2 className="mb-4 text-lg font-semibold text-slate-50">
          Per-server detail
        </h2>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-800">
            <thead className="bg-slate-900/80">
              <tr>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  ID
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Country
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Region
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Status
                </th>
                <th className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Sessions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filteredServers.map((s) => (
                <tr
                  key={s.id}
                  className="bg-slate-950/40 hover:bg-slate-800/70"
                >
                  <td className="px-4 py-3 text-sm font-mono text-slate-400">
                    {s.id}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-200">
                    {s.country ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-200">
                    {s.region ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-200">
                    {s.status}
                  </td>
                  <td className="px-4 py-3 text-sm text-slate-200">
                    {s.sessions}
                  </td>
                </tr>
              ))}
              {filteredServers.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-sm text-slate-400"
                  >
                    No servers registered yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

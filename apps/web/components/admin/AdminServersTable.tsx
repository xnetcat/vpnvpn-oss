"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc/client";

type AdminServer = {
  id: string;
  status?: string;
  lastSeen?: string;
  region?: string;
  country?: string;
  metrics?: { sessions?: number };
  activeSessions?: number;
  metadata?: Record<string, unknown> | null;
};

type Props = {
  initialServers?: AdminServer[];
};

type NormalizedServer = {
  id: string;
  status: string;
  lastSeen?: string;
  region?: string;
  country?: string;
  sessions: number;
};

const statusOptions = ["all", "online", "offline", "unknown"] as const;

function formatRelativeTime(iso?: string) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatStatus(status: string) {
  const normalized = status.toLowerCase();
  switch (normalized) {
    case "online":
      return {
        label: "Online",
        icon: CheckCircle2,
        classes:
          "text-emerald-300 bg-emerald-500/10 ring-1 ring-emerald-500/30",
      };
    case "offline":
      return {
        label: "Offline",
        icon: XCircle,
        classes: "text-rose-300 bg-rose-500/10 ring-1 ring-rose-500/30",
      };
    default:
      return {
        label: "Unknown",
        icon: Clock3,
        classes: "text-amber-200 bg-amber-500/10 ring-1 ring-amber-400/30",
      };
  }
}

export default function AdminServersTable({ initialServers = [] }: Props) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<(typeof statusOptions)[number]>("all");
  const [regionFilter, setRegionFilter] = useState("all");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const {
    data = initialServers,
    isFetching,
    refetch,
  } = trpc.admin.listServers.useQuery(undefined, {
    initialData: initialServers,
  });

  const deleteMutation = trpc.admin.deleteServer.useMutation({
    onSuccess: async () => {
      await utils.admin.listServers.invalidate();
      await refetch();
    },
    onError: () => {
      alert("Failed to delete server");
    },
  });

  const normalized = useMemo<NormalizedServer[]>(() => {
    return (data || []).map((item: AdminServer) => {
      const metadata = (item as AdminServer).metadata || {};
      const region = (item as AdminServer).region ?? (metadata as any).region;
      const country =
        (item as AdminServer).country ?? (metadata as any).country ?? undefined;

      const rawStatus = (item as AdminServer).status ?? "unknown";
      const sessions = Number(
        (item as AdminServer).metrics?.sessions ??
          (item as AdminServer).activeSessions ??
          0,
      );

      return {
        id: (item as AdminServer).id ?? "unknown",
        status: rawStatus,
        lastSeen: (item as AdminServer).lastSeen,
        region,
        country,
        sessions,
      } satisfies NormalizedServer;
    });
  }, [data]);

  const regions = useMemo(() => {
    return Array.from(
      new Set(
        normalized
          .map((s: NormalizedServer) => s.region?.toLowerCase())
          .filter((r): r is string => Boolean(r)),
      ),
    ).sort();
  }, [normalized]);

  const filtered = useMemo(() => {
    return normalized.filter((s: NormalizedServer) => {
      const matchesSearch =
        !search ||
        s.id.toLowerCase().includes(search.toLowerCase()) ||
        (s.region ?? "").toLowerCase().includes(search.toLowerCase()) ||
        (s.country ?? "").toLowerCase().includes(search.toLowerCase());

      const matchesStatus =
        status === "all" ? true : s.status.toLowerCase() === status;

      const matchesRegion =
        regionFilter === "all"
          ? true
          : (s.region ?? "").toLowerCase() === regionFilter;

      return matchesSearch && matchesStatus && matchesRegion;
    });
  }, [normalized, search, status, regionFilter]);

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this server from the fleet?")) return;
    setDeletingId(id);
    try {
      await deleteMutation.mutateAsync({ id });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
        <label className="flex items-center gap-2">
          <span>Status</span>
          <select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as (typeof statusOptions)[number])
            }
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-50"
          >
            {statusOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt === "all"
                  ? "All"
                  : opt.charAt(0).toUpperCase() + opt.slice(1)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2">
          <span>Region</span>
          <select
            value={regionFilter}
            onChange={(e) => setRegionFilter(e.target.value)}
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-50"
          >
            <option value="all">All</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-[220px] flex-1 items-center gap-2">
          <span className="whitespace-nowrap">Search</span>
          <div className="relative w-full">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ID, country, region…"
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-8 py-1 text-sm text-slate-50"
            />
          </div>
        </label>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm font-medium text-slate-100 hover:border-amber-400 hover:text-amber-100 disabled:opacity-60"
        >
          <RefreshCw
            className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/80 shadow-sm shadow-slate-900/40">
        <table className="min-w-full divide-y divide-slate-800">
          <thead className="bg-slate-900/80">
            <tr>
              <th className="px-4 py-2 text-left text-sm font-medium text-slate-400">
                ID
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-slate-400">
                Region
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-slate-400">
                Country
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-slate-400">
                Status
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-slate-400">
                Sessions
              </th>
              <th className="px-4 py-2 text-left text-sm font-medium text-slate-400">
                Last Seen
              </th>
              <th className="px-4 py-2 text-right text-sm font-medium text-slate-400">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {filtered.map((s) => {
              const statusMeta = formatStatus(s.status);
              const StatusIcon = statusMeta.icon;
              const isDeleting =
                deletingId === s.id && deleteMutation.isPending;

              return (
                <tr key={s.id} className="hover:bg-slate-800/80">
                  <td className="px-4 py-2 text-sm text-slate-100">{s.id}</td>
                  <td className="px-4 py-2 text-sm text-slate-300">
                    {s.region ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-sm text-slate-300">
                    {s.country ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-sm">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${statusMeta.classes}`}
                    >
                      <StatusIcon className="h-3.5 w-3.5" />
                      {statusMeta.label}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-sm text-slate-300">
                    {typeof s.sessions === "number" ? s.sessions : "—"}
                  </td>
                  <td className="px-4 py-2 text-sm text-slate-300">
                    {formatRelativeTime(s.lastSeen)}
                  </td>
                  <td className="px-4 py-2 text-right text-sm text-slate-300">
                    <button
                      type="button"
                      onClick={() => handleDelete(s.id)}
                      disabled={isDeleting}
                      className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-100 transition hover:border-rose-400 hover:bg-rose-500/20 disabled:opacity-60"
                    >
                      {isDeleting ? (
                        <RefreshCw className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}

            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-6 text-center text-sm text-slate-400"
                >
                  {isFetching ? (
                    <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1.5 text-slate-300">
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      Loading servers…
                    </div>
                  ) : (
                    <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1.5 text-slate-300">
                      No servers match the current filters.
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

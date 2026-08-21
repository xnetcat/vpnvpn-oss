"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Clock3, Search, Slash, XCircle } from "lucide-react";

export type ServerRow = {
  id: string;
  region: string;
  country?: string;
  status: string;
  sessions: number;
  cpu?: number;
  lastSeen?: string;
};

type Props = {
  servers: ServerRow[];
};

const statusOptions = ["all", "online", "offline", "unknown"] as const;

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

export default function ServersTable({ servers }: Props) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<(typeof statusOptions)[number]>("all");

  const filtered = useMemo(() => {
    return servers.filter((s) => {
      const matchesSearch =
        !search ||
        s.id.toLowerCase().includes(search.toLowerCase()) ||
        s.region.toLowerCase().includes(search.toLowerCase()) ||
        (s.country ?? "").toLowerCase().includes(search.toLowerCase());

      const matchesStatus =
        status === "all" ? true : s.status.toLowerCase() === status;

      return matchesSearch && matchesStatus;
    });
  }, [servers, search, status]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex flex-1 items-center">
          <Search className="absolute left-3 h-4 w-4 text-slate-500" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by country, region, or ID..."
            className="w-full rounded-lg border border-slate-800 bg-slate-900/70 px-9 py-2 text-sm text-slate-100 shadow-sm outline-none ring-1 ring-transparent transition focus:border-emerald-500/60 focus:ring-emerald-500/20"
          />
        </div>
        <div className="flex gap-2">
          <select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as (typeof statusOptions)[number])
            }
            className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-sm text-slate-100 shadow-sm outline-none ring-1 ring-transparent transition focus:border-emerald-500/60 focus:ring-emerald-500/20"
          >
            {statusOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt === "all"
                  ? "All statuses"
                  : opt.charAt(0).toUpperCase() + opt.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 shadow-xl shadow-black/20 backdrop-blur">
        <table className="min-w-full divide-y divide-slate-800/80">
          <thead className="bg-slate-900/80">
            <tr className="text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3 text-left">Country</th>
              <th className="px-4 py-3 text-left">Region</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-left">Sessions</th>
              <th className="px-4 py-3 text-left">CPU</th>
              <th className="px-4 py-3 text-left">Last seen</th>
              <th className="px-4 py-3 text-left">ID</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70 text-sm">
            {filtered.map((s) => {
              const statusMeta = formatStatus(s.status);
              const StatusIcon = statusMeta.icon;
              return (
                <tr
                  key={s.id}
                  className="bg-slate-950/40 text-slate-100 transition hover:bg-slate-800/60"
                >
                  <td className="px-4 py-3 text-slate-200">
                    {s.country ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-200">{s.region}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${statusMeta.classes}`}
                    >
                      <StatusIcon className="h-3.5 w-3.5" />
                      {statusMeta.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-100">{s.sessions}</td>
                  <td className="px-4 py-3 text-slate-100">
                    {typeof s.cpu === "number" ? `${s.cpu.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {formatRelativeTime(s.lastSeen)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {s.id}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-slate-400"
                >
                  <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1.5 text-slate-300">
                    <Slash className="h-4 w-4" />
                    No servers match the current filters.
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

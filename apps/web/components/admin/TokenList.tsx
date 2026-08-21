"use client";

import { useMemo, useState } from "react";
import { RefreshCw, Search, Shield, Slash, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";

type Token = {
  id: string;
  tokenPrefix: string;
  label: string;
  createdAt: string;
  usageCount: number;
  active: boolean;
  scope?: "user" | "system";
};

const statusOptions = ["all", "active", "revoked"] as const;
const scopeOptions = ["all", "user", "system"] as const;

function formatDate(iso?: string | null) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString();
}

export default function TokenList() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<(typeof statusOptions)[number]>("all");
  const [scope, setScope] = useState<(typeof scopeOptions)[number]>("all");
  const utils = trpc.useUtils();

  const {
    data: tokens = [],
    isLoading,
    isFetching,
  } = trpc.admin.listTokens.useQuery();

  const revokeMutation = trpc.admin.revokeToken.useMutation({
    onSuccess: () => {
      utils.admin.listTokens.invalidate();
    },
    onError: () => {
      alert("Failed to revoke token");
    },
  });

  const handleRevoke = async (id: string) => {
    if (!confirm("Revoke this token? Existing nodes will stop registering.")) {
      return;
    }
    await revokeMutation.mutateAsync({ id });
  };

  const filtered = useMemo(() => {
    return tokens.filter((t: Token) => {
      const matchesSearch =
        !search ||
        t.label.toLowerCase().includes(search.toLowerCase()) ||
        (t.tokenPrefix ?? "").toLowerCase().includes(search.toLowerCase());

      const matchesStatus =
        status === "all" ? true : status === "active" ? t.active : !t.active;

      const normalizedScope =
        (t.scope as Token["scope"]) ||
        (t.label?.toLowerCase().includes("bootstrap") ? "system" : "user");

      const matchesScope = scope === "all" ? true : normalizedScope === scope;

      return matchesSearch && matchesStatus && matchesScope;
    });
  }, [tokens, search, scope, status]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center text-slate-400 shadow-inner shadow-black/30">
        Loading tokens...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="relative flex flex-1 items-center">
          <Search className="absolute left-3 h-4 w-4 text-slate-500" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by label or prefix..."
            className="w-full rounded-lg border border-slate-800 bg-slate-950 px-9 py-2 text-sm text-slate-100 shadow-sm outline-none ring-1 ring-transparent transition focus:border-amber-500/60 focus:ring-amber-500/20"
          />
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          <select
            value={status}
            onChange={(e) =>
              setStatus(e.target.value as (typeof statusOptions)[number])
            }
            className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-sm outline-none ring-1 ring-transparent transition focus:border-amber-500/60 focus:ring-amber-500/20"
          >
            {statusOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt === "all"
                  ? "All statuses"
                  : opt.charAt(0).toUpperCase() + opt.slice(1)}
              </option>
            ))}
          </select>
          <select
            value={scope}
            onChange={(e) =>
              setScope(e.target.value as (typeof scopeOptions)[number])
            }
            className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-sm outline-none ring-1 ring-transparent transition focus:border-amber-500/60 focus:ring-amber-500/20"
          >
            {scopeOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt === "all"
                  ? "All scopes"
                  : opt.charAt(0).toUpperCase() + opt.slice(1)}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => utils.admin.listTokens.invalidate()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-2 text-sm font-medium text-slate-100 transition hover:border-amber-400 hover:text-amber-100"
          >
            <RefreshCw
              className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 shadow-xl shadow-black/20 backdrop-blur">
        <table className="min-w-full divide-y divide-slate-800">
          <thead className="bg-slate-900/80">
            <tr className="text-xs uppercase tracking-wide text-slate-400">
              <th className="px-4 py-3 text-left">Label</th>
              <th className="px-4 py-3 text-left">Token</th>
              <th className="px-4 py-3 text-left">Scope</th>
              <th className="px-4 py-3 text-left">Usage</th>
              <th className="px-4 py-3 text-left">Created</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 text-sm">
            {filtered.map((token: Token) => {
              const normalizedScope =
                token.scope ||
                (token.label?.toLowerCase().includes("bootstrap")
                  ? "system"
                  : "user");

              return (
                <tr
                  key={token.id}
                  className="bg-slate-950/40 text-slate-100 transition hover:bg-slate-800/70"
                >
                  <td className="px-4 py-3 font-medium text-slate-100">
                    {token.label}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-400">
                    {token.tokenPrefix ? `${token.tokenPrefix}…` : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        normalizedScope === "system"
                          ? "bg-amber-500/10 text-amber-200 ring-1 ring-amber-500/30"
                          : "bg-sky-500/10 text-sky-200 ring-1 ring-sky-500/30"
                      }`}
                    >
                      <Shield className="h-3.5 w-3.5" />
                      {normalizedScope === "system" ? "System" : "Admin"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-200">
                    {token.usageCount || 0} uses
                  </td>
                  <td className="px-4 py-3 text-slate-300">
                    {formatDate(token.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        token.active
                          ? "bg-emerald-500/10 text-emerald-200 ring-1 ring-emerald-500/30"
                          : "bg-rose-500/10 text-rose-200 ring-1 ring-rose-500/30"
                      }`}
                    >
                      {token.active ? "Active" : "Revoked"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-300">
                    {token.active ? (
                      <button
                        onClick={() => void handleRevoke(token.id)}
                        disabled={revokeMutation.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-100 transition hover:border-rose-400 hover:bg-rose-500/20 disabled:opacity-60"
                      >
                        {revokeMutation.isPending ? (
                          <RefreshCw className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                        Revoke
                      </button>
                    ) : (
                      <span className="text-xs text-slate-500">Revoked</span>
                    )}
                  </td>
                </tr>
              );
            })}

            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-10 text-center text-sm text-slate-400"
                >
                  <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/70 px-3 py-1.5 text-slate-300">
                    <Slash className="h-4 w-4" />
                    No tokens match the current filters.
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

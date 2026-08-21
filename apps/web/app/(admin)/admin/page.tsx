import { requireAdmin } from "@/lib/requireAdmin";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Server, Key, Settings, Users, BarChart3 } from "lucide-react";
import { createContext } from "@/lib/trpc/init";
import { appRouter } from "@/lib/trpc/routers/_app";
import AdminServersTable from "@/components/admin/AdminServersTable";

type NodeSummary = {
  id: string;
  status: string;
  lastSeen?: string;
  activeSessions?: number;
  region?: string;
  country?: string;
};

async function fetchNodes(): Promise<NodeSummary[]> {
  try {
    const ctx = await createContext();
    const caller = appRouter.createCaller(ctx);
    const data = await caller.admin.listServers();

    return (data as any[]).map((item) => ({
      id: item.id ?? "unknown",
      status: item.status ?? "unknown",
      lastSeen: item.lastSeen,
      activeSessions:
        (item.metrics && item.metrics.sessions) ?? item.activeSessions,
      region: item.region ?? item.metadata?.region,
      country: item.country ?? item.metadata?.country,
    }));
  } catch (err) {
    console.error("[admin] fetchNodes error", { err });
    return [];
  }
}

export default async function AdminPage() {
  const gate = await requireAdmin();
  if (!gate.ok) {
    redirect(gate.reason === "unauthenticated" ? "/api/auth/signin" : "/");
  }

  const nodes = await fetchNodes();

  const onlineCount = nodes.filter((n) => n.status === "online").length;

  return (
    <main className="mx-auto max-w-6xl p-6 text-slate-50">
      <div className="mb-6">
        <h1 className="mb-1 text-2xl font-semibold text-slate-50">
          Admin Panel
        </h1>
        <p className="text-sm text-slate-400">
          Manage servers, tokens, and system configuration
        </p>
      </div>

      {/* Quick Actions */}
      <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-4">
        <Link
          href="/admin/tokens"
          className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40 transition-shadow hover:shadow-md"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="rounded-lg bg-emerald-500/10 p-2">
              <Key className="h-5 w-5 text-emerald-400" />
            </div>
            <h3 className="font-semibold text-slate-50">Server Tokens</h3>
          </div>
          <p className="text-sm text-slate-400">
            Manage registration tokens for VPN servers
          </p>
        </Link>

        <Link
          href="/admin/provision"
          className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40 transition-shadow hover:shadow-md"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="rounded-lg bg-sky-500/10 p-2">
              <Server className="h-5 w-5 text-sky-400" />
            </div>
            <h3 className="font-semibold text-slate-50">Provision Server</h3>
          </div>
          <p className="text-sm text-slate-400">
            Deploy new VPN servers to your infrastructure
          </p>
        </Link>

        <Link
          href="/admin/users"
          className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40 transition-shadow hover:shadow-md"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="rounded-lg bg-indigo-500/10 p-2">
              <Users className="h-5 w-5 text-indigo-400" />
            </div>
            <h3 className="font-semibold text-slate-50">Users</h3>
          </div>
          <p className="text-sm text-slate-400">
            Inspect users, subscriptions, and device counts
          </p>
        </Link>

        <Link
          href="/admin/analytics"
          className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40 transition-shadow hover:shadow-md"
        >
          <div className="flex items-center gap-3 mb-2">
            <div className="rounded-lg bg-orange-500/10 p-2">
              <BarChart3 className="h-5 w-5 text-orange-400" />
            </div>
            <h3 className="font-semibold text-slate-50">Analytics</h3>
          </div>
          <p className="text-sm text-slate-400">
            Usage metrics, trends, tier breakdown, and system health
          </p>
        </Link>

        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
          <div className="flex items-center gap-3 mb-2">
            <div className="rounded-lg bg-purple-500/10 p-2">
              <Settings className="h-5 w-5 text-purple-400" />
            </div>
            <h3 className="font-semibold text-slate-50">System Status</h3>
          </div>
          <p className="text-sm text-slate-400">
            {onlineCount} / {nodes.length} servers online
          </p>
        </div>
      </div>

      <div className="mb-4">
        <h2 className="text-xl font-semibold text-slate-50">Server Fleet</h2>
      </div>
      <AdminServersTable initialServers={nodes} />
    </main>
  );
}

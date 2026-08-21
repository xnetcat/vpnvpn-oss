import type { ComponentType } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import {
  Activity,
  BarChart3,
  Key,
  Plus,
  ShieldCheck,
  Users,
} from "lucide-react";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const adminNav: NavItem[] = [
  { href: "/admin", label: "Overview", icon: ShieldCheck },
  { href: "/admin/tokens", label: "Server Tokens", icon: Key },
  { href: "/admin/provision", label: "Provision Server", icon: Plus },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/admin/vpn-metrics", label: "VPN Metrics", icon: Activity },
];

function navItemClasses(active: boolean) {
  const base =
    "group flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors";
  const activeClasses =
    "border border-amber-500/40 bg-amber-500/10 text-slate-50 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]";
  const inactiveClasses =
    "text-slate-300 hover:bg-slate-800 hover:text-slate-50";
  return `${base} ${active ? activeClasses : inactiveClasses}`;
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = ((await headers()).get("x-pathname") || "").toLowerCase();

  return (
    <div className="flex min-h-screen bg-slate-950">
      <aside className="hidden w-64 border-r border-amber-500/10 bg-slate-900/80 md:sticky md:top-0 md:flex md:h-screen md:flex-col">
        <div className="px-4 pb-2 pt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
            Admin
          </p>
          <p className="text-sm font-semibold text-slate-100">
            Operations console
          </p>
        </div>
        <nav className="flex-1 space-y-1 px-2 pb-4">
          {adminNav.map((item) => {
            const Icon = item.icon;
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={navItemClasses(active)}
              >
                <Icon className="h-4 w-4 text-amber-300" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1">
        <header className="sticky top-0 z-20 border-b border-amber-500/20 bg-linear-to-r from-amber-500/5 via-slate-900 to-slate-950 backdrop-blur">
          <div className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
                Admin area
              </p>
              <h1 className="text-xl font-semibold text-slate-50">
                Operations Console
              </h1>
              <p className="text-sm text-slate-300">
                Manage nodes, tokens, users, and telemetry.
              </p>
            </div>
            <Link
              href="/dashboard"
              className="inline-flex items-center rounded-full border border-amber-500/30 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-amber-100 transition hover:border-amber-400 hover:bg-amber-500/10"
            >
              Back to dashboard
            </Link>
          </div>
        </header>
        <div className="px-4 pb-10 pt-6 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}

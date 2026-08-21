import type { ComponentType } from "react";
import Link from "next/link";
import { headers } from "next/headers";
import {
  LayoutDashboard,
  Server,
  ShieldCheck,
  Smartphone,
  User,
} from "lucide-react";
import { getSession } from "@/lib/auth";

type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
};

const userNav: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/devices", label: "Devices", icon: Smartphone },
  { href: "/servers", label: "Servers", icon: Server },
  { href: "/account", label: "Account", icon: User },
];

function navItemClasses(active: boolean) {
  const base =
    "group flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors";
  const activeClasses =
    "border border-emerald-500/40 bg-emerald-500/10 text-slate-50 shadow-[0_0_0_1px_rgba(16,185,129,0.15)]";
  const inactiveClasses =
    "text-slate-300 hover:bg-slate-800 hover:text-slate-50";
  return `${base} ${active ? activeClasses : inactiveClasses}`;
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const headerList = await headers();
  const pathname = (headerList.get("x-pathname") || "").toLowerCase();

  const session = await getSession();
  const email = (session?.user as any)?.email as string | undefined;
  const role = (session?.user as any)?.role as string | undefined;
  const isAdmin = role === "admin";
  const navItems: NavItem[] = isAdmin
    ? [...userNav, { href: "/admin", label: "Admin", icon: ShieldCheck }]
    : userNav;

  return (
    <div className="flex min-h-screen bg-slate-950">
      <aside className="hidden w-64 border-r border-slate-800 bg-slate-900/70 md:sticky md:top-0 md:flex md:h-screen md:flex-col">
        <div className="px-4 pb-2 pt-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-400">
            Dashboard
          </p>
          <p className="text-sm font-semibold text-slate-100">vpnVPN</p>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-6">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={navItemClasses(active)}
              >
                <Icon className="h-4 w-4 text-emerald-300" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="flex-1">
        <header className="sticky top-0 z-20 border-b border-slate-800/80 bg-slate-900/80 backdrop-blur">
          <div className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-400">
                Control center
              </p>
              <h1 className="text-xl font-semibold text-slate-50">Dashboard</h1>
              <p className="text-sm text-slate-400">
                Manage devices, servers, and billing.
              </p>
            </div>
            {email ? (
              <span className="inline-flex items-center rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-medium text-slate-200">
                {email}
              </span>
            ) : null}
          </div>
        </header>
        <div className="px-4 pb-10 pt-6 sm:px-6 lg:px-8">{children}</div>
      </main>
    </div>
  );
}

import Link from "next/link";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { WEB_ENV } from "@/env";

export const metadata: Metadata = {
  // `absolute` opts out of the root layout's "%s — vpnVPN" template, which
  // would otherwise double the brand name on the home page.
  title: { absolute: "vpnVPN — Privacy-first VPN" },
  description:
    "Fast, privacy-first VPN built on WireGuard, OpenVPN and IKEv2. No traffic logging, transparent fleet metrics, apps for macOS, Windows and Linux.",
};

// Desktop download URLs from environment
const DESKTOP_BUCKET_URL = WEB_ENV.DESKTOP_BUCKET_URL;
const ENVIRONMENT = WEB_ENV.ENVIRONMENT;
const DESKTOP_BASE = `${DESKTOP_BUCKET_URL}/releases/${ENVIRONMENT}`;

type DesktopDownloads = {
  macos: string | null;
  windows: string | null;
  linux: string | null;
};

type PlatformKey = keyof DesktopDownloads;
const PLATFORM_ORDER: PlatformKey[] = ["macos", "windows", "linux"];
const PLATFORM_META: Record<
  PlatformKey,
  { label: string; ext: string; deps: string[]; detail: string }
> = {
  macos: {
    label: "macOS",
    ext: ".dmg",
    deps: ["macOS 12+", "WireGuard or OpenVPN installed"],
    detail: "Signed build with Keychain‑backed secrets.",
  },
  windows: {
    label: "Windows",
    ext: ".exe",
    deps: ["Windows 10+", "WireGuard or OpenVPN installed"],
    detail: "Runs with embedded auto‑update and service helper.",
  },
  linux: {
    label: "Linux",
    ext: ".AppImage",
    deps: ["glibc 2.31+", "wireguard-tools or openvpn in PATH"],
    detail: "Portable AppImage; works on Debian/Ubuntu/Fedora.",
  },
};

function getDesktopDownloads(): DesktopDownloads {
  if (!DESKTOP_BASE) {
    return { macos: null, windows: null, linux: null };
  }
  return {
    macos: `${DESKTOP_BASE}/vpnvpn-desktop-latest.dmg`,
    windows: `${DESKTOP_BASE}/vpnvpn-desktop-latest.exe`,
    linux: `${DESKTOP_BASE}/vpnvpn-desktop-latest.AppImage`,
  };
}

type FleetMetrics = {
  totalServers: number;
  onlineServers: number;
  totalSessions: number;
  avgCpu: number | null;
  samples: { region: string; status: string; sessions: number }[];
};

function detectPlatform(userAgent: string | null): PlatformKey | "other" {
  if (!userAgent) return "other";
  const ua = userAgent.toLowerCase();
  if (ua.includes("mac os x") || ua.includes("macintosh")) return "macos";
  if (ua.includes("windows")) return "windows";
  if (ua.includes("linux")) return "linux";
  return "other";
}

async function fetchFleetMetrics(): Promise<FleetMetrics | null> {
  const base = WEB_ENV.CONTROL_PLANE_API_URL;
  const apiKey = WEB_ENV.CONTROL_PLANE_API_KEY;

  if (!base || !apiKey) return null;

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/servers`, {
      method: "GET",
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any[];
    if (!Array.isArray(data)) return null;

    const totalServers = data.length;
    const onlineNodes = data.filter(
      (s) => (s.status ?? "unknown").toLowerCase() === "online",
    );
    const onlineServers = onlineNodes.length;

    let totalSessions = 0;
    let cpuSum = 0;
    let cpuCount = 0;

    for (const s of onlineNodes) {
      const sessions =
        typeof s.metrics?.sessions === "number"
          ? s.metrics.sessions
          : typeof s.activeSessions === "number"
            ? s.activeSessions
            : 0;
      totalSessions += sessions;
      if (typeof s.metrics?.cpu === "number") {
        cpuSum += s.metrics.cpu;
        cpuCount += 1;
      }
    }

    const samples = onlineNodes.slice(0, 3).map((s) => ({
      region: s.region ?? s.metadata?.region ?? "unknown",
      status: s.status ?? "unknown",
      sessions:
        typeof s.metrics?.sessions === "number"
          ? s.metrics.sessions
          : typeof s.activeSessions === "number"
            ? s.activeSessions
            : 0,
    }));

    return {
      totalServers,
      onlineServers,
      totalSessions,
      avgCpu: cpuCount ? cpuSum / cpuCount : null,
      samples,
    };
  } catch (err) {
    console.error("[landing] failed to fetch fleet metrics", err);
    return null;
  }
}

export default async function HomePage() {
  const session = await getSession();
  const headersList = await headers();
  const isAuthed = Boolean((session?.user as any)?.id);
  const metrics = await fetchFleetMetrics();
  const downloads = getDesktopDownloads();

  const userPlatform = detectPlatform(headersList.get("user-agent"));
  const availablePlatforms = PLATFORM_ORDER.filter((key) => downloads[key]);
  const recommendedPlatform: PlatformKey | null =
    userPlatform !== "other" && downloads[userPlatform] ? userPlatform : null;
  const fallbackPlatform = availablePlatforms[0] ?? null;
  const activePlatform =
    (recommendedPlatform as PlatformKey | null) ?? fallbackPlatform;
  const showMacNotice = activePlatform === "macos";

  const onlineServers = metrics?.onlineServers ?? null;
  const totalServers = metrics?.totalServers ?? null;
  const totalSessions = metrics?.totalSessions ?? null;
  const avgCpu = metrics?.avgCpu ?? null;
  const hasDownloads = downloads.macos || downloads.windows || downloads.linux;

  return (
    <main className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-slate-950 via-slate-950 to-slate-950" />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(16,185,129,0.18),transparent_35%),radial-gradient(circle_at_80%_10%,rgba(56,189,248,0.16),transparent_30%),radial-gradient(circle_at_50%_80%,rgba(59,130,246,0.12),transparent_30%)]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-emerald-500/0 via-emerald-500/50 to-cyan-400/0" />

      <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-14 sm:px-6 lg:px-8">
        {/* Hero */}
        <section className="grid gap-10 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:items-center">
          <div>
            <div className="inline-flex items-center rounded-full border border-emerald-400/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-200">
              vpnVPN • Your control plane + real VPN nodes
            </div>
            <h1 className="mt-5 text-balance text-4xl font-semibold leading-tight tracking-tight text-white sm:text-5xl">
              A production VPN product,{" "}
              <span className="bg-linear-to-r from-emerald-400 via-cyan-300 to-sky-400 bg-clip-text text-transparent">
                not a side project.
              </span>
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-200/80 sm:text-base">
              Full SaaS VPN stack you actually control: dashboard, billing,
              multi‑node control plane, metrics, and desktop app. Point it at
              your own WireGuard/OpenVPN/IKEv2 nodes or let us host them.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-4">
              {isAuthed ? (
                <Link
                  href="/dashboard"
                  className="inline-flex items-center justify-center rounded-lg bg-linear-to-r from-emerald-500 to-cyan-500 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/25 transition hover:from-emerald-400 hover:to-cyan-400"
                >
                  Go to dashboard
                </Link>
              ) : (
                <>
                  <Link
                    href="/auth/register"
                    className="inline-flex items-center justify-center rounded-lg bg-linear-to-r from-emerald-500 to-cyan-500 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/25 transition hover:from-emerald-400 hover:to-cyan-400"
                  >
                    Get started from $10/mo
                  </Link>
                  <Link
                    href="/pricing"
                    className="inline-flex items-center justify-center rounded-lg border border-slate-700/80 bg-slate-900/50 px-5 py-2.5 text-sm font-semibold text-slate-100 transition hover:border-slate-600 hover:bg-slate-800"
                  >
                    View pricing
                  </Link>
                </>
              )}
              <p className="text-xs text-slate-400">
                No traffic logs. Cancel anytime.
              </p>
            </div>

            <dl className="mt-8 grid grid-cols-2 gap-4 text-sm text-slate-300 sm:grid-cols-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <dt className="text-[11px] uppercase tracking-wide text-slate-500">
                  Protocols
                </dt>
                <dd className="mt-1 font-semibold text-white">
                  WireGuard, OpenVPN, IKEv2
                </dd>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <dt className="text-[11px] uppercase tracking-wide text-slate-500">
                  Multi‑node
                </dt>
                <dd className="mt-1 font-semibold text-white">
                  Regions &amp; load aware
                </dd>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <dt className="text-[11px] uppercase tracking-wide text-slate-500">
                  Clients
                </dt>
                <dd className="mt-1 font-semibold text-white">
                  Web, desktop, WireGuard, OpenVPN
                </dd>
              </div>
            </dl>
          </div>

          {/* Live metrics card */}
          <div className="relative">
            <div className="pointer-events-none absolute -inset-6 rounded-3xl bg-linear-to-tr from-emerald-400/20 via-transparent to-cyan-400/20 blur-2xl" />
            <div className="relative overflow-hidden rounded-2xl border border-slate-800/80 bg-slate-900/70 shadow-2xl shadow-emerald-900/30 backdrop-blur">
              <div className="flex items-center justify-between border-b border-slate-800/80 px-4 py-3">
                <span className="text-xs font-medium text-slate-300">
                  vpnVPN • Server fleet
                </span>
                <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-200">
                  Live metrics
                </span>
              </div>
              <div className="px-4 py-3">
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
                    <div className="text-[11px] text-slate-400">
                      Online servers
                    </div>
                    <div className="mt-1 text-lg font-semibold text-white">
                      {onlineServers ?? "—"}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      {totalServers !== null
                        ? `of ${totalServers} total`
                        : "live from control plane"}
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
                    <div className="text-[11px] text-slate-400">
                      Active sessions
                    </div>
                    <div className="mt-1 text-lg font-semibold text-white">
                      {totalSessions ?? "—"}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      current across online nodes
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
                    <div className="text-[11px] text-slate-400">
                      Avg. CPU / node
                    </div>
                    <div className="mt-1 text-lg font-semibold text-white">
                      {avgCpu !== null ? `${Math.round(avgCpu)}%` : "—"}
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-500">
                      based on online nodes
                    </div>
                  </div>
                </div>

                <div className="mt-4 overflow-hidden rounded-lg border border-slate-800">
                  <table className="min-w-full divide-y divide-slate-800 text-xs">
                    <thead className="bg-slate-900/80 text-[11px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Region</th>
                        <th className="px-3 py-2 text-left">Status</th>
                        <th className="px-3 py-2 text-right">Sessions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800 bg-slate-900/60">
                      {metrics?.samples?.length ? (
                        metrics.samples.map((s) => (
                          <tr key={s.region + s.status}>
                            <td className="px-3 py-1.5 text-slate-100">
                              {s.region}
                            </td>
                            <td className="px-3 py-1.5 text-emerald-200">
                              {s.status}
                            </td>
                            <td className="px-3 py-1.5 text-right text-slate-100">
                              {s.sessions}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td
                            className="px-3 py-2 text-center text-slate-500"
                            colSpan={3}
                          >
                            No online servers yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="mt-16 space-y-6">
          <div className="max-w-3xl">
            <h2 className="text-xl font-semibold text-white">
              Everything you need to run a serious VPN service.
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Control plane, billing, metrics, desktop clients, and a Rust node
              you can self-host or let us run. Same stack in dev and prod.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 shadow-lg shadow-emerald-900/20">
              <h3 className="text-sm font-semibold text-white">
                SaaS dashboard
              </h3>
              <p className="mt-2 text-xs text-slate-300">
                Next.js dashboard for users and admins: subscriptions, devices,
                fleet, and live VPN metrics.
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 shadow-lg shadow-emerald-900/20">
              <h3 className="text-sm font-semibold text-white">Real VPN</h3>
              <p className="mt-2 text-xs text-slate-300">
                Rust VPN node with WireGuard, OpenVPN, and IKEv2 backends. Real
                interfaces, real encryption.
              </p>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5 shadow-lg shadow-emerald-900/20">
              <h3 className="text-sm font-semibold text-white">Desktop app</h3>
              <p className="mt-2 text-xs text-slate-300">
                Tauri desktop app with OTP login; launches
                WireGuard/OpenVPN/IKEv2 clients on macOS, Windows, and Linux.
              </p>
            </div>
            <div className="rounded-xl border border-emerald-700/60 bg-emerald-500/10 p-5 shadow-lg shadow-emerald-900/30">
              <h3 className="text-sm font-semibold text-emerald-100">
                Bring your own nodes
              </h3>
              <p className="mt-2 text-xs text-emerald-50/80">
                Ship our Rust node to any VPS/EC2 with Docker or systemd. Manage
                regions, peers, and health from the same dashboard—or let us
                host the fleet.
              </p>
            </div>
          </div>
        </section>

        {/* Desktop Downloads */}
        {hasDownloads && activePlatform && (
          <section className="mt-16 rounded-2xl border border-slate-800 bg-slate-900/60 px-6 py-8 shadow-xl shadow-emerald-900/25">
            <div className="text-center">
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-200">
                Download vpnVPN Desktop
                <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] text-emerald-50">
                  {PLATFORM_META[activePlatform].label} suggested
                </span>
              </div>
              <h2 className="mt-4 text-xl font-semibold text-white">
                Desktop downloads
              </h2>
              <p className="mt-2 text-sm text-slate-300">
                We detect your OS and pick the right build. Auto‑updates
                included.
              </p>
            </div>

            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              {availablePlatforms.map((key) => {
                const href = downloads[key];
                if (!href) return null;
                const isActive = key === activePlatform;
                const meta = PLATFORM_META[key];
                return (
                  <a
                    key={key}
                    href={href}
                    className={`relative flex h-full flex-col gap-3 rounded-xl border p-5 transition ${
                      isActive
                        ? "border-emerald-400/70 bg-emerald-500/10 shadow-lg shadow-emerald-800/30"
                        : "border-slate-800 bg-slate-900/70 hover:border-emerald-500/40 hover:bg-slate-900"
                    }`}
                  >
                    {isActive && (
                      <span className="absolute right-3 top-3 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">
                        Recommended
                      </span>
                    )}
                    <div className="text-lg font-semibold text-white">
                      {meta.label}
                    </div>
                    <div className="text-xs text-slate-400">
                      Download {meta.ext}
                    </div>
                    <p className="text-xs text-slate-300">{meta.detail}</p>
                    <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900/80 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        Dependencies
                      </p>
                      <ul className="mt-2 space-y-1 text-[12px] text-slate-200">
                        {meta.deps.map((dep) => (
                          <li key={dep} className="flex items-center gap-2">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            {dep}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </a>
                );
              })}
            </div>

            {showMacNotice && (
              <div className="mt-6 rounded-lg border border-amber-300/40 bg-amber-500/10 p-4">
                <h3 className="text-sm font-semibold text-amber-100">
                  macOS installation tip
                </h3>
                <p className="mt-2 text-xs text-amber-50/80 leading-relaxed">
                  If Gatekeeper blocks launch, clear the quarantine flag and
                  open:
                </p>
                <div className="mt-3 rounded bg-amber-500/10 p-3">
                  <p className="mb-2 text-xs font-medium text-amber-50">
                    Paste in Terminal:
                  </p>
                  <code className="block rounded border border-amber-400/20 bg-black/60 px-2 py-1.5 font-mono text-[11px] text-amber-50">
                    xattr -cr "/Applications/vpnVPN Desktop (Staging).app" &&
                    open "/Applications/vpnVPN Desktop (Staging).app"
                  </code>
                </div>
                <p className="mt-3 text-xs text-amber-50/70">
                  Or: right-click the app → Open (one time). Standard for apps
                  outside the Mac App Store.
                </p>
              </div>
            )}

            <p className="mt-6 text-center text-xs text-slate-400">
              Requires macOS 12+, Windows 10+, or Linux (glibc 2.31+).
              Auto‑updates on.
            </p>
          </section>
        )}

        {/* Callout */}
        <section className="mt-16 rounded-2xl border border-emerald-600/50 bg-emerald-500/10 px-6 py-6 shadow-lg shadow-emerald-900/30 sm:flex sm:items-center sm:justify-between sm:px-8">
          <div>
            <h3 className="text-sm font-semibold text-emerald-100">
              Ready when you are.
            </h3>
            <p className="mt-1 text-xs text-emerald-50/80">
              Start with one node locally, then fan out to regions. Same
              binaries in dev and prod.
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-3 sm:mt-0 sm:items-center">
            {isAuthed ? (
              <Link
                href="/dashboard"
                className="inline-flex items-center justify-center rounded-md bg-emerald-400 px-4 py-2 text-xs font-semibold text-slate-950 shadow-md shadow-emerald-500/40 hover:bg-emerald-300"
              >
                Open dashboard
              </Link>
            ) : (
              <Link
                href="/auth/register"
                className="inline-flex items-center justify-center rounded-md bg-emerald-400 px-4 py-2 text-xs font-semibold text-slate-950 shadow-md shadow-emerald-500/40 hover:bg-emerald-300"
              >
                Create your account
              </Link>
            )}
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md border border-emerald-300/60 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-50 hover:border-emerald-200 hover:bg-emerald-500/20"
            >
              See plans
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}

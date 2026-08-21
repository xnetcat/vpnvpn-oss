// Per-day usage bar chart for the user dashboard. Server-renderable (no client
// JS): mirrors the simplified CSS bar approach used by the admin analytics
// page (app/(admin)/admin/analytics/page.tsx) and the dark-slate + emerald
// design system.

export type UsagePoint = {
  date: string; // YYYY-MM-DD (UTC)
  rxBytes: number;
  txBytes: number;
};

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** i;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export default function UsageChart({ series }: { series: UsagePoint[] }) {
  const peak = Math.max(...series.map((p) => p.rxBytes + p.txBytes), 0);

  if (peak === 0) {
    return (
      <p className="py-8 text-center text-sm text-slate-400">
        No usage recorded yet. Connect a device and traffic will show up here.
      </p>
    );
  }

  return (
    <div>
      <div className="flex h-40 items-end gap-1">
        {series.map((p) => {
          const total = p.rxBytes + p.txBytes;
          const height = peak > 0 ? (total / peak) * 100 : 0;
          return (
            <div
              key={p.date}
              className="group relative flex-1 rounded-t bg-emerald-500/80 transition-colors hover:bg-emerald-400"
              style={{ height: `${Math.max(height, 2)}%` }}
            >
              <div className="absolute bottom-full left-1/2 z-10 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-slate-200 group-hover:block">
                {formatBytes(total)}
                <br />
                {/* Server-perspective counters: tx = download to the device,
                    rx = upload from it. */}
                <span className="text-slate-400">
                  ↓ {formatBytes(p.txBytes)} · ↑ {formatBytes(p.rxBytes)}
                </span>
                <br />
                {new Date(`${p.date}T00:00:00Z`).toLocaleDateString()}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between text-xs text-slate-500">
        <span>
          {series.length > 0
            ? new Date(`${series[0].date}T00:00:00Z`).toLocaleDateString()
            : ""}
        </span>
        <span>
          {series.length > 0
            ? new Date(
                `${series[series.length - 1].date}T00:00:00Z`,
              ).toLocaleDateString()
            : ""}
        </span>
      </div>
    </div>
  );
}

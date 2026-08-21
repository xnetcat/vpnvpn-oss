import { requireUser } from "@/lib/requirePaidUser";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import RevokeDeviceButton from "@/components/RevokeDeviceButton";
import DownloadConfigButton from "@/components/DownloadConfigButton";
import { createContext } from "@/lib/trpc/init";
import { appRouter } from "@/lib/trpc/routers/_app";
import { formatBytes } from "@/components/UsageChart";

async function getUserDevices(userId: string) {
  return prisma.device.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

// Per-device transfer totals over the last 30 days (deviceId -> bytes).
// Best-effort: the devices table must still render if usage metrics fail.
async function getDeviceUsageTotals(): Promise<Map<string, number>> {
  try {
    const ctx = await createContext();
    const caller = appRouter.createCaller(ctx);
    const usage = await caller.analytics.userUsage();
    return new Map(usage.devices.map((d) => [d.deviceId, d.totalBytes]));
  } catch (err) {
    console.error("Failed to fetch device usage totals", err);
    return new Map();
  }
}

function maskPublicKey(key: string): string {
  if (key.length <= 16) return key;
  return `${key.substring(0, 8)}...${key.substring(key.length - 8)}`;
}

export default async function DevicesPage() {
  const gate = await requireUser();
  if (!gate.ok) {
    redirect("/api/auth/signin");
  }

  const [devices, usageTotals] = await Promise.all([
    getUserDevices(gate.userId),
    getDeviceUsageTotals(),
  ]);
  return (
    <main className="mx-auto max-w-6xl p-6 text-slate-50">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-50">Devices</h1>
          <p className="mt-1 text-sm text-slate-400">
            {devices.length} of {gate.deviceLimit} devices. Devices register
            automatically when you sign in through the vpnVPN desktop app.
          </p>
        </div>
        <div className="max-w-md rounded-md border border-slate-800 bg-slate-900/80 px-4 py-3 text-sm text-slate-300 shadow-sm shadow-slate-900/40">
          <div className="text-xs font-semibold uppercase tracking-wide text-emerald-400">
            How to add devices
          </div>
          <p className="mt-1">
            Connect with the desktop app, or use{" "}
            <span className="text-slate-200">Configs</span> to download a
            WireGuard, OpenVPN, or Apple (.mobileconfig) profile and connect
            with any third-party client — the desktop app is optional.
          </p>
        </div>
      </div>

      {devices.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-12 text-center shadow-sm shadow-slate-900/40">
          <p className="mb-4 text-slate-400">
            No devices connected yet. Sign in via the desktop app to register
            your first device and download its configuration automatically.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-800 bg-slate-900/80 shadow-sm shadow-slate-900/40">
          <table className="min-w-full divide-y divide-slate-800">
            <thead className="bg-slate-900/80">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Name
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Public Key
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Server
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Data (30d)
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
                  Added
                </th>
                <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 bg-slate-900/80">
              {devices.map((device: (typeof devices)[number]) => (
                <tr key={device.id} className="hover:bg-slate-800/80">
                  <td className="whitespace-nowrap px-6 py-4 text-sm font-medium text-slate-50">
                    {device.name}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm font-mono text-slate-400">
                    {maskPublicKey(device.publicKey)}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-slate-400">
                    {device.serverId || "Auto"}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-slate-400">
                    {usageTotals.has(device.id)
                      ? formatBytes(usageTotals.get(device.id) ?? 0)
                      : "—"}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-sm text-slate-400">
                    {new Date(device.createdAt).toLocaleDateString()}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-right text-sm font-medium">
                    <div className="inline-flex items-center gap-4">
                      <DownloadConfigButton
                        deviceId={device.id}
                        deviceName={device.name}
                      />
                      <RevokeDeviceButton
                        deviceId={device.id}
                        deviceName={device.name}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

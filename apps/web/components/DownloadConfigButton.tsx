"use client";

import { useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { trpc } from "@/lib/trpc/client";

function downloadText(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function DownloadConfigButton({
  deviceId,
  deviceName,
}: {
  deviceId: string;
  deviceName: string;
}) {
  const [open, setOpen] = useState(false);
  const getConfigs = trpc.device.getConfigs.useMutation({
    onSuccess: () => setOpen(true),
    onError: (error) => alert(`Failed to generate configs: ${error.message}`),
  });

  const safeName = deviceName.replace(/[^a-zA-Z0-9-_]/g, "_") || "device";
  const data = getConfigs.data;

  return (
    <>
      <button
        onClick={() => getConfigs.mutate({ deviceId })}
        disabled={getConfigs.isPending}
        className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
        aria-label={`Download config for ${deviceName}`}
      >
        {getConfigs.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Download className="h-4 w-4" />
        )}
        <span className="text-sm font-medium">Configs</span>
      </button>

      {open && data && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-6 text-left shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute right-3 top-3 text-slate-400 hover:text-slate-200"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>

            <h2 className="text-lg font-semibold text-slate-50">
              VPN profiles — {deviceName}
            </h2>
            <p className="mt-1 text-sm text-slate-400">
              Use any third-party client — the desktop app is optional. Tunnel
              IP <span className="font-mono text-slate-300">{data.assignedIp}</span>.
            </p>

            <div className="mt-4 grid gap-2">
              <button
                onClick={() =>
                  downloadText(
                    `vpnvpn-${safeName}.conf`,
                    data.wireguardConfig,
                    "text/plain",
                  )
                }
                className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 hover:border-emerald-500/60 hover:bg-slate-800"
              >
                <span>
                  <span className="font-medium">WireGuard</span>
                  <span className="ml-2 text-xs text-slate-400">.conf</span>
                </span>
                <Download className="h-4 w-4 text-emerald-400" />
              </button>

              {data.appleMobileConfig && (
                <button
                  onClick={() =>
                    downloadText(
                      `vpnvpn-${safeName}.mobileconfig`,
                      data.appleMobileConfig as string,
                      "application/x-apple-aspen-config",
                    )
                  }
                  className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 hover:border-emerald-500/60 hover:bg-slate-800"
                >
                  <span>
                    <span className="font-medium">Apple (iOS / macOS)</span>
                    <span className="ml-2 text-xs text-slate-400">
                      .mobileconfig — native IKEv2
                    </span>
                  </span>
                  <Download className="h-4 w-4 text-emerald-400" />
                </button>
              )}

              {data.openvpnConfig && (
                <button
                  onClick={() =>
                    downloadText(
                      `vpnvpn-${safeName}.ovpn`,
                      data.openvpnConfig as string,
                      "text/plain",
                    )
                  }
                  className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800/60 px-4 py-2.5 text-sm text-slate-100 hover:border-emerald-500/60 hover:bg-slate-800"
                >
                  <span>
                    <span className="font-medium">OpenVPN</span>
                    <span className="ml-2 text-xs text-slate-400">.ovpn</span>
                  </span>
                  <Download className="h-4 w-4 text-emerald-400" />
                </button>
              )}
            </div>

            <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
              <div className="font-semibold uppercase tracking-wide text-slate-500">
                Credentials (OpenVPN / IKEv2)
              </div>
              <div className="mt-1 font-mono text-slate-300">
                user: {data.vpnCredentials.username}
              </div>
              <div className="font-mono text-slate-300 break-all">
                pass: {data.vpnCredentials.password}
              </div>
            </div>

            <p className="mt-4 text-xs text-amber-300/90">
              Generating profiles rotates this device&apos;s keys and
              invalidates any config you downloaded earlier.
            </p>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
              WireGuard: import the .conf into the WireGuard app. Apple: open the
              .mobileconfig on iOS/macOS, then enable it under Settings → VPN.
              OpenVPN: import the .ovpn into OpenVPN Connect and enter the
              username/password above.
            </p>
          </div>
        </div>
      )}
    </>
  );
}

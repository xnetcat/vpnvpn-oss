import { useEffect, useRef, useState } from "react";
import type { Protocol, VpnConnectionStatus, ViewState } from "../lib/types";

function getProtocolLabel(protocol: Protocol): string {
  switch (protocol) {
    case "wireguard":
      return "WireGuard";
    case "openvpn":
      return "OpenVPN";
    case "ikev2":
      return "IKEv2 / IPsec";
  }
}

/** Format a byte count as a human-readable string (e.g. "1.2 MB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = unit === 0 ? 0 : value < 10 ? 2 : 1;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

/** Format a per-second byte rate (e.g. "1.2 MB/s"). */
export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Format a duration in seconds as H:MM:SS or M:SS. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "0:00";
  const s = Math.floor(totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = minutes.toString().padStart(hours > 0 ? 2 : 1, "0");
  const ss = seconds.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

type StatusPanelProps = {
  protocol: Protocol;
  hasConfig: boolean;
  status: ViewState;
  errorMessage?: string | null;
  connectionStatus?: VpnConnectionStatus | null;
  /** macOS IKEv2: the VPN profile awaits one-time user approval in System
   * Settings. Rendered as an instruction with a retry button, not an error. */
  pendingApproval?: boolean;
  onRetryPendingApproval?: () => void;
};

export function StatusPanel({
  protocol,
  hasConfig,
  status,
  errorMessage,
  connectionStatus,
  pendingApproval,
  onRetryPendingApproval,
}: StatusPanelProps) {
  const hasError = Boolean(errorMessage);
  const isConnected = status === "connected" && Boolean(connectionStatus?.is_connected);

  // Derive up/down rate from successive byte samples.
  const prevSample = useRef<{ sent: number; recv: number; t: number } | null>(
    null,
  );
  const [rates, setRates] = useState<{ up: number; down: number }>({
    up: 0,
    down: 0,
  });
  // Live-updating session duration tick.
  const [now, setNow] = useState(() => Date.now());

  const sent = connectionStatus?.bytes_sent ?? null;
  const recv = connectionStatus?.bytes_received ?? null;

  useEffect(() => {
    if (!isConnected || sent === null || recv === null) {
      prevSample.current = null;
      setRates({ up: 0, down: 0 });
      return;
    }
    const t = Date.now();
    const prev = prevSample.current;
    if (prev && t > prev.t) {
      const dt = (t - prev.t) / 1000;
      const up = Math.max(0, (sent - prev.sent) / dt);
      const down = Math.max(0, (recv - prev.recv) / dt);
      setRates({ up, down });
    }
    prevSample.current = { sent, recv, t };
  }, [isConnected, sent, recv]);

  // Tick the clock every second while connected so the duration updates.
  useEffect(() => {
    if (!isConnected) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isConnected]);

  const sessionSeconds = (() => {
    const startedAt = connectionStatus?.connected_at;
    if (!isConnected || !startedAt) return null;
    const startMs = Date.parse(startedAt);
    if (Number.isNaN(startMs)) return null;
    return Math.max(0, (now - startMs) / 1000);
  })();

  return (
    <div className="border-t border-slate-800 bg-slate-900/60 px-6 py-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <h3 className="text-sm font-medium text-slate-300">
            Protocol: {getProtocolLabel(protocol)}
          </h3>
          {hasError ? (
            <div className="mt-2 space-y-1 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
              <p className="text-xs font-semibold text-red-300">
                Connection failed
              </p>
              <pre className="whitespace-pre-wrap break-words text-[11px] text-red-200">
                {errorMessage}
              </pre>
            </div>
          ) : pendingApproval ? (
            <div className="mt-2 space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2">
              <p className="text-xs font-semibold text-amber-300">
                One-time approval needed
              </p>
              <p className="text-[11px] text-amber-200">
                macOS requires you to approve the &quot;vpnVPN IKEv2&quot; VPN
                profile once. System Settings should be showing it now —
                approve it, then retry. Future IKEv2 connections are fully
                automatic.
              </p>
              {onRetryPendingApproval && (
                <button
                  type="button"
                  onClick={onRetryPendingApproval}
                  className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-400/20"
                >
                  I&apos;ve approved it — connect
                </button>
              )}
            </div>
          ) : hasConfig ? (
            <p className="mt-1 text-xs text-emerald-400">
              {status === "connected"
                ? "Configuration applied"
                : "Configuration generated, applying..."}
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Click Connect to generate VPN configuration
            </p>
          )}
        </div>
      </div>

      {isConnected && (sent !== null || recv !== null) && (
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-slate-500">Download</dt>
            <dd className="font-mono text-emerald-300" aria-label="download rate">
              {formatRate(rates.down)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Upload</dt>
            <dd className="font-mono text-sky-300" aria-label="upload rate">
              {formatRate(rates.up)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Total transfer</dt>
            <dd className="font-mono text-slate-300" aria-label="total transfer">
              ↓ {formatBytes(recv ?? 0)} / ↑ {formatBytes(sent ?? 0)}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Session</dt>
            <dd className="font-mono text-slate-300" aria-label="session duration">
              {sessionSeconds === null ? "—" : formatDuration(sessionSeconds)}
            </dd>
          </div>
        </dl>
      )}
    </div>
  );
}

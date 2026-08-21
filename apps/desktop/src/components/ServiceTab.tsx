import { useEffect, useState } from "react";
import {
  Check,
  X,
  RefreshCw,
  AlertTriangle,
  Settings,
  Play,
  Square,
  RotateCw,
  Wrench,
  Info,
  Shield,
  Loader2,
  Code,
  Terminal,
  FileText,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { tailDaemonLogs } from "../lib/tauri";

type DaemonStatus = {
  running: boolean;
  version: string;
  uptime_secs: number;
  has_network_permission: boolean;
  has_firewall_permission: boolean;
  kill_switch_active: boolean;
  channel?: string;
  source?: string;
  binary_path?: string | null;
  using_dev_socket?: boolean;
};

type ServiceTabProps = {
  daemonStatus: DaemonStatus | null;
  isLoading: boolean;
  onRefreshStatus: () => Promise<void>;
  onStartDaemon: () => Promise<void>;
  onStopDaemon: () => Promise<void>;
  onRestartDaemon: () => Promise<void>;
  onUninstallDaemon: () => Promise<void>;
  onRequestPermissions: () => Promise<void>;
  isDevelopment?: boolean;
  onUpdateDaemon?: () => Promise<void>;
};

function formatUptime(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    const mins = Math.floor(seconds / 60);
    return `${mins}m ${seconds % 60}s`;
  }
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function StatusIndicator({
  status,
  label,
}: {
  status: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/50 p-3">
      <span className="text-sm text-slate-300">{label}</span>
      <div className="flex items-center gap-2">
        {status ? (
          <>
            <div className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-sm font-medium text-emerald-400">Active</span>
          </>
        ) : (
          <>
            <div className="h-2 w-2 rounded-full bg-slate-500" />
            <span className="text-sm font-medium text-slate-500">Inactive</span>
          </>
        )}
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  disabled,
  loading,
  icon: Icon,
  label,
  variant = "default",
}: {
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon: React.ElementType;
  label: string;
  variant?: "default" | "danger" | "warning";
}) {
  const variantStyles = {
    default:
      "border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white",
    danger: "border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20",
    warning:
      "border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${variantStyles[variant]}`}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Icon className="h-4 w-4" />
      )}
      {label}
    </button>
  );
}

export function ServiceTab({
  daemonStatus,
  isLoading,
  onRefreshStatus,
  onStartDaemon,
  onStopDaemon,
  onRestartDaemon,
  onUninstallDaemon,
  onRequestPermissions,
  isDevelopment = false,
  onUpdateDaemon,
}: ServiceTabProps) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logCursor, setLogCursor] = useState<number | null>(null);
  const [logTimer, setLogTimer] = useState<ReturnType<
    typeof setInterval
  > | null>(null);
  useEffect(() => {
    return () => {
      if (logTimer) clearInterval(logTimer);
    };
  }, [logTimer]);

  const handleViewLogs = async () => {
    if (showLogs) {
      setShowLogs(false);
      if (logTimer) {
        clearInterval(logTimer);
        setLogTimer(null);
      }
      return;
    }

    setLogsLoading(true);
    try {
      await pullLogs();
      setShowLogs(true);
      const timer = setInterval(() => {
        void pullLogs();
      }, 2000);
      setLogTimer(timer);
    } catch (e) {
      setLogs([`Error loading logs: ${e}`]);
      setShowLogs(true);
    } finally {
      setLogsLoading(false);
    }
  };

  const pullLogs = async () => {
    const chunk = await tailDaemonLogs(logCursor ?? undefined);
    if (!chunk) return;
    setLogCursor(chunk.cursor);
    if (chunk.lines.length > 0) {
      setLogs(
        (prev) => [...prev, ...chunk.lines].slice(-400), // keep last 400 lines
      );
    }
  };

  const handleAction = async (action: string, handler: () => Promise<void>) => {
    setActionLoading(action);
    try {
      await handler();
    } finally {
      setActionLoading(null);
      await onRefreshStatus();
    }
  };

  return (
    <div className="space-y-6">
      {/* Service Status Header */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            VPN Service Status
          </h2>
          <button
            type="button"
            onClick={() => handleAction("refresh", onRefreshStatus)}
            disabled={isLoading || actionLoading !== null}
            className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        </div>

        {/* Status Card */}
        {daemonStatus ? (
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-5">
            <div className="flex items-center gap-4">
              <div
                className={`flex h-14 w-14 items-center justify-center rounded-xl ${
                  daemonStatus.running ? "bg-emerald-500/20" : "bg-red-500/20"
                }`}
              >
                {daemonStatus.running ? (
                  <Shield className="h-7 w-7 text-emerald-400" />
                ) : (
                  <X className="h-7 w-7 text-red-400" />
                )}
              </div>
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-lg font-semibold text-slate-100">
                    vpnVPN Daemon
                  </span>
                  {daemonStatus.channel && (
                    <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs font-semibold text-slate-200">
                      {daemonStatus.channel}
                    </span>
                  )}
                  {daemonStatus.source && (
                    <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-300">
                      {daemonStatus.source}
                    </span>
                  )}
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      daemonStatus.running
                        ? "bg-emerald-500/20 text-emerald-400"
                        : "bg-red-500/20 text-red-400"
                    }`}
                  >
                    {daemonStatus.running ? "Running" : "Stopped"}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-4 text-sm text-slate-400">
                  <span>Version {daemonStatus.version}</span>
                  {daemonStatus.running && (
                    <>
                      <span>•</span>
                      <span>
                        Uptime: {formatUptime(daemonStatus.uptime_secs)}
                      </span>
                    </>
                  )}
                </div>
              </div>
            </div>
            {daemonStatus.binary_path && (
              <p className="mt-3 text-xs text-slate-500">
                Path: {daemonStatus.binary_path}
              </p>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-5">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-amber-500/20">
                <AlertTriangle className="h-7 w-7 text-amber-400" />
              </div>
              <div>
                <span className="text-lg font-semibold text-slate-100">
                  Service Not Available
                </span>
                <p className="mt-1 text-sm text-slate-400">
                  The VPN daemon is not installed or not responding.
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Service Controls */}
      <div className="border-t border-slate-800 pt-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Service Controls
        </h2>
        <div className="flex flex-wrap gap-3">
          {daemonStatus?.running ? (
            <>
              <ActionButton
                onClick={() => handleAction("stop", onStopDaemon)}
                loading={actionLoading === "stop"}
                disabled={actionLoading !== null}
                icon={Square}
                label="Stop Service"
                variant="danger"
              />
              <ActionButton
                onClick={() => handleAction("restart", onRestartDaemon)}
                loading={actionLoading === "restart"}
                disabled={actionLoading !== null}
                icon={RotateCw}
                label="Restart Service"
              />
            </>
          ) : (
            <ActionButton
              onClick={() => handleAction("start", onStartDaemon)}
              loading={actionLoading === "start"}
              disabled={actionLoading !== null}
              icon={Play}
              label="Start Service"
            />
          )}
          <ActionButton
            onClick={() => handleAction("uninstall", onUninstallDaemon)}
            loading={actionLoading === "uninstall"}
            disabled={actionLoading !== null}
            icon={Wrench}
            label="Uninstall Daemon"
            variant="danger"
          />
        </div>
      </div>

      {/* Permissions */}
      {daemonStatus && (
        <div className="border-t border-slate-800 pt-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Permissions
            </h2>
            {(!daemonStatus.has_network_permission ||
              !daemonStatus.has_firewall_permission) && (
              <button
                type="button"
                onClick={() =>
                  handleAction("permissions", onRequestPermissions)
                }
                disabled={actionLoading !== null}
                className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
              >
                <Settings className="h-3.5 w-3.5" />
                Grant Permissions
              </button>
            )}
          </div>
          <div className="space-y-2">
            <StatusIndicator
              status={daemonStatus.has_network_permission}
              label="Network Management"
            />
            <StatusIndicator
              status={daemonStatus.has_firewall_permission}
              label="Firewall Control"
            />
            <StatusIndicator
              status={daemonStatus.kill_switch_active}
              label="Kill Switch"
            />
          </div>
        </div>
      )}

      {/* Daemon Logs */}
      <div className="border-t border-slate-800 pt-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-slate-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
              Daemon Logs
            </h2>
          </div>
          <button
            type="button"
            onClick={handleViewLogs}
            disabled={logsLoading}
            className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            {logsLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : showLogs ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            {showLogs ? "Hide Logs" : "View Logs"}
          </button>
        </div>

        {showLogs && (
          <div className="rounded-xl border border-slate-700 bg-slate-950 p-4">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap font-mono text-xs text-slate-300">
              {logs.length ? logs.join("\n") : "No logs available"}
            </pre>
          </div>
        )}
      </div>

      {/* Development Tools */}
      {isDevelopment && onUpdateDaemon && (
        <div className="border-t border-slate-800 pt-6">
          <div className="mb-4 flex items-center gap-2">
            <Code className="h-4 w-4 text-purple-400" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-purple-400">
              Development Tools
            </h2>
          </div>
          <div className="rounded-xl border border-purple-500/30 bg-purple-500/10 p-4">
            <div className="flex items-start gap-3">
              <Terminal className="mt-0.5 h-5 w-5 shrink-0 text-purple-400" />
              <div className="flex-1">
                <p className="font-medium text-purple-300">Update Daemon</p>
                <p className="mt-1 text-sm text-purple-300/80">
                  Rebuild the daemon from source and reinstall it. This will
                  stop any running daemon, build the new version, and start it
                  again.
                </p>
                <div className="mt-3">
                  <ActionButton
                    onClick={() => handleAction("update", onUpdateDaemon)}
                    loading={actionLoading === "update"}
                    disabled={actionLoading !== null}
                    icon={RefreshCw}
                    label="Build & Reinstall Daemon"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Info Box */}
      <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
          <div className="text-sm text-blue-300">
            <p className="font-medium">About the VPN Service</p>
            <p className="mt-1 text-blue-300/80">
              The vpnVPN daemon runs with elevated privileges to manage VPN
              connections, firewall rules, and the kill switch. It starts
              automatically when your system boots and stays running in the
              background.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

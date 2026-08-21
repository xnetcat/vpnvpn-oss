import {
  Settings,
  LogOut,
  Shield,
  Wifi,
  WifiOff,
  ExternalLink,
} from "lucide-react";
import type { ViewState } from "../lib/types";
import { openInBrowser } from "../lib/tauri";
import { DASHBOARD_URL } from "../lib/config";

type DesktopHeaderProps = {
  status: ViewState;
  onSettingsClick: () => void;
  onSignOut: () => void;
};

export function DesktopHeader({
  status,
  onSettingsClick,
  onSignOut,
}: DesktopHeaderProps) {
  const handleOpenDashboard = () => {
    void openInBrowser(DASHBOARD_URL);
  };

  return (
    <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900/95 px-4 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600">
          <Shield className="h-4 w-4 text-white" />
        </div>
        <span className="text-sm font-semibold tracking-tight text-slate-100">
          vpnVPN
        </span>
      </div>

      <div className="flex items-center gap-2">
        {/* Connection Status */}
        <div className="flex items-center gap-2 rounded-full bg-slate-800/80 px-3 py-1.5">
          {status === "connected" ? (
            <Wifi className="h-3.5 w-3.5 text-emerald-400" />
          ) : status === "connecting" ? (
            <Wifi className="h-3.5 w-3.5 animate-pulse text-amber-400" />
          ) : (
            <WifiOff className="h-3.5 w-3.5 text-slate-500" />
          )}
          <span className="text-xs font-medium text-slate-300">
            {status === "connected"
              ? "Connected"
              : status === "connecting"
                ? "Connecting..."
                : "Disconnected"}
          </span>
        </div>

        {/* Dashboard Button */}
        <button
          type="button"
          onClick={handleOpenDashboard}
          className="flex items-center gap-1.5 rounded-lg bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 hover:text-slate-100"
          title="Open Dashboard in Browser"
        >
          Dashboard
          <ExternalLink className="h-3 w-3" />
        </button>

        {/* Settings Button */}
        <button
          type="button"
          onClick={onSettingsClick}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
          title="Settings"
        >
          <Settings className="h-4 w-4" />
        </button>

        {/* Sign Out Button */}
        <button
          type="button"
          onClick={onSignOut}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-red-400"
          title="Sign out"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

import { AlertTriangle } from "lucide-react";
import type {
  MapServer,
  ViewState,
  Protocol,
  VpnToolsStatus,
} from "../lib/types";

type ConnectionBarProps = {
  selectedServer: MapServer | null;
  status: ViewState;
  protocol: Protocol;
  vpnTools: VpnToolsStatus | null;
  onConnect: () => void;
  onDisconnect: () => void;
};

export function ConnectionBar({
  selectedServer,
  status,
  protocol,
  vpnTools,
  onConnect,
  onDisconnect,
}: ConnectionBarProps) {
  const isConnecting = status === "connecting";

  // Check if the selected protocol's tool is available
  const isToolAvailable = (): boolean => {
    if (!vpnTools) return false;
    switch (protocol) {
      case "wireguard":
        return vpnTools.wireguard.available;
      case "openvpn":
        return vpnTools.openvpn.available;
      case "ikev2":
        return vpnTools.ikev2.available;
    }
  };

  // Check if any VPN tool is available
  const hasAnyTool = vpnTools
    ? vpnTools.wireguard.available ||
      vpnTools.openvpn.available ||
      vpnTools.ikev2.available
    : false;

  // Determine if connect should be disabled
  const toolAvailable = isToolAvailable();
  const canConnect = selectedServer && !isConnecting && toolAvailable;

  // Get warning message
  const getWarningMessage = (): string | null => {
    if (!vpnTools) return null;
    if (!hasAnyTool) {
      return "No VPN tools installed. Please install WireGuard or OpenVPN.";
    }
    if (!toolAvailable) {
      if (protocol === "ikev2") {
        return "IKEv2/IPsec is not available. Please install strongSwan or use a different protocol.";
      }
      return `${protocol === "wireguard" ? "WireGuard" : "OpenVPN"} is not installed. Please install it or select a different protocol.`;
    }
    // Info message for IKEv2 when tool is available
    if (protocol === "ikev2" && toolAvailable) {
      return "IKEv2 will open the config file for you to import into System Settings.";
    }
    return null;
  };

  const warningMessage = getWarningMessage();

  return (
    <div className="border-b border-slate-800 bg-slate-900/60">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          {selectedServer ? (
            <>
              <div className="text-lg font-semibold text-slate-100">
                {selectedServer.country ?? "Unknown"} • {selectedServer.region}
              </div>
              <div className="text-sm text-slate-400">
                {selectedServer.sessions} active sessions •{" "}
                {selectedServer.status}
              </div>
            </>
          ) : (
            <div className="text-sm text-slate-500">
              Select a server to connect
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={status === "connected" ? onDisconnect : onConnect}
          disabled={!canConnect && status !== "connected"}
          className={`rounded-full px-8 py-2.5 text-sm font-semibold shadow-lg transition-all ${
            status === "connected"
              ? "bg-slate-700 text-slate-100 hover:bg-slate-600"
              : "bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:from-emerald-400 hover:to-teal-400 disabled:cursor-not-allowed disabled:from-slate-600 disabled:to-slate-600 disabled:text-slate-400"
          }`}
        >
          {status === "connected"
            ? "Disconnect"
            : isConnecting
              ? "Connecting..."
              : "Connect"}
        </button>
      </div>

      {/* Warning/Info banner */}
      {warningMessage && status !== "connected" && (
        <div
          className={`flex items-center gap-2 border-t px-6 py-2 ${
            protocol === "ikev2" && toolAvailable
              ? "border-blue-500/20 bg-blue-500/10"
              : "border-amber-500/20 bg-amber-500/10"
          }`}
        >
          <AlertTriangle
            className={`h-4 w-4 shrink-0 ${
              protocol === "ikev2" && toolAvailable
                ? "text-blue-400"
                : "text-amber-400"
            }`}
          />
          <span
            className={`text-xs ${
              protocol === "ikev2" && toolAvailable
                ? "text-blue-300"
                : "text-amber-300"
            }`}
          >
            {warningMessage}
          </span>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  Info,
  Wrench,
  Sliders,
  Shield,
  Terminal,
  Download,
  ExternalLink,
  RefreshCw,
  Bug,
  Server,
} from "lucide-react";
import type {
  SettingsTab,
  Protocol,
  VpnToolsStatus,
  ViewState,
  DaemonStatus,
} from "../lib/types";
import {
  getSplitTunnel,
  setSplitTunnel,
  getAutoReconnect,
  setAutoReconnect,
  type SplitTunnelMode,
} from "../lib/tauri";
import { ServiceTab } from "./ServiceTab";

type DebugInfo = {
  isConnected: boolean;
  connectionStatus: ViewState;
  actuallyConnected: boolean;
  actualProtocol: string | null;
  interfaceName: string | null;
  selectedServerId: string | null;
  selectedServerRegion: string | null;
  protocol: Protocol;
  isProduction: boolean;
  tauriAvailable: boolean;
  userCountry: string | null;
};

type SettingsViewProps = {
  activeTab: SettingsTab;
  setActiveTab: (tab: SettingsTab) => void;
  protocol: Protocol;
  setProtocol: (p: Protocol) => void;
  autoConnect: boolean;
  setAutoConnect: (b: boolean) => void;
  wgQuickPath: string;
  setWgQuickPath: (s: string) => void;
  openvpnPath: string;
  setOpenvpnPath: (s: string) => void;
  wireguardCliPath: string;
  setWireguardCliPath: (s: string) => void;
  vpnTools: VpnToolsStatus | null;
  onRefreshTools: () => Promise<void>;
  isRefreshingTools: boolean;
  debugInfo: DebugInfo | null;
  onBack: () => void;
  // Daemon-related props
  daemonStatus: DaemonStatus | null;
  isDaemonLoading: boolean;
  onRefreshDaemonStatus: () => Promise<void>;
  onStartDaemon: () => Promise<void>;
  onStopDaemon: () => Promise<void>;
  onRestartDaemon: () => Promise<void>;
  onUninstallDaemon: () => Promise<void>;
  onRequestPermissions: () => Promise<void>;
  isDevelopment?: boolean;
  onUpdateDaemon?: () => Promise<void>;
};

const PROTOCOL_OPTIONS = [
  {
    id: "wireguard" as const,
    label: "WireGuard",
    desc: "Fast, modern, and secure",
  },
  {
    id: "openvpn" as const,
    label: "OpenVPN",
    desc: "Widely compatible",
  },
  {
    id: "ikev2" as const,
    label: "IKEv2 / IPsec",
    desc: "Native OS support",
  },
];

// Installation instructions for each tool per platform
type PlatformInfo = {
  title: string;
  steps: string[];
  command: string | null;
  link?: string;
  builtin?: boolean;
};

type ToolInstructions = {
  name: string;
  description: string;
  platforms: Record<string, PlatformInfo>;
};

const INSTALL_INSTRUCTIONS: Record<string, ToolInstructions> = {
  wireguard: {
    name: "WireGuard",
    description:
      "Modern, fast VPN protocol with state-of-the-art cryptography.",
    platforms: {
      macos: {
        title: "macOS",
        steps: [
          "Install via Homebrew: brew install wireguard-tools",
          "Or download from: https://www.wireguard.com/install/",
          "The wg-quick command will be available after installation",
        ],
        command: "brew install wireguard-tools",
      },
      linux: {
        title: "Linux",
        steps: [
          "Ubuntu/Debian: sudo apt install wireguard-tools",
          "Fedora: sudo dnf install wireguard-tools",
          "Arch: sudo pacman -S wireguard-tools",
        ],
        command: "sudo apt install wireguard-tools",
      },
      windows: {
        title: "Windows",
        steps: [
          "Download the official installer from wireguard.com",
          "Run the installer and follow the prompts",
          "wireguard.exe will be added to your PATH",
        ],
        command: null,
        link: "https://www.wireguard.com/install/",
      },
    },
  },
  openvpn: {
    name: "OpenVPN",
    description: "Widely compatible VPN protocol with proven security.",
    platforms: {
      macos: {
        title: "macOS",
        steps: [
          "Install via Homebrew: brew install openvpn",
          "Or install Tunnelblick for a GUI: https://tunnelblick.net",
        ],
        command: "brew install openvpn",
      },
      linux: {
        title: "Linux",
        steps: [
          "Ubuntu/Debian: sudo apt install openvpn",
          "Fedora: sudo dnf install openvpn",
          "Arch: sudo pacman -S openvpn",
        ],
        command: "sudo apt install openvpn",
      },
      windows: {
        title: "Windows",
        steps: [
          "Download OpenVPN Connect or Community edition",
          "Run the installer with administrator privileges",
          "openvpn.exe will be added to your PATH",
        ],
        command: null,
        link: "https://openvpn.net/community-downloads/",
      },
    },
  },
  ikev2: {
    name: "IKEv2 / IPsec",
    description: "Native OS VPN protocol with excellent mobile support.",
    platforms: {
      macos: {
        title: "macOS",
        steps: [
          "Built-in support via networksetup (no installation needed)",
          "VPN profiles can be imported via System Preferences",
          "Managed automatically by vpnVPN",
        ],
        command: null,
        builtin: true,
      },
      linux: {
        title: "Linux",
        steps: [
          "Install strongSwan: sudo apt install strongswan",
          "Or use NetworkManager: sudo apt install network-manager-strongswan",
          "Configure via /etc/ipsec.conf or nmcli",
        ],
        command: "sudo apt install strongswan",
      },
      windows: {
        title: "Windows",
        steps: [
          "Built-in support via rasdial (no installation needed)",
          "VPN profiles can be configured in Network Settings",
          "Managed automatically by vpnVPN",
        ],
        command: null,
        builtin: true,
      },
    },
  },
};

function ToolStatusCard({
  name,
  available,
  path,
  instructions,
}: {
  name: string;
  available: boolean;
  path: string | null;
  instructions: ToolInstructions;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-900/50">
      {/* Header */}
      <div className="flex items-center justify-between p-4">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-lg ${
              available ? "bg-emerald-500/20" : "bg-red-500/20"
            }`}
          >
            {available ? (
              <Check className="h-5 w-5 text-emerald-400" />
            ) : (
              <X className="h-5 w-5 text-red-400" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-100">{name}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  available
                    ? "bg-emerald-500/20 text-emerald-400"
                    : "bg-red-500/20 text-red-400"
                }`}
              >
                {available ? "Installed" : "Not Found"}
              </span>
            </div>
            {path && (
              <p className="mt-0.5 font-mono text-xs text-slate-500">{path}</p>
            )}
            {!available && (
              <p className="mt-0.5 text-xs text-slate-500">
                {instructions.description}
              </p>
            )}
          </div>
        </div>

        {!available && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700"
          >
            <Download className="h-3.5 w-3.5" />
            Install
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>

      {/* Installation Instructions */}
      {expanded && !available && (
        <div className="border-t border-slate-800 bg-slate-950/50 p-4">
          <div className="grid gap-4 md:grid-cols-3">
            {Object.entries(instructions.platforms).map(([key, platform]) => (
              <div
                key={key}
                className="rounded-lg border border-slate-800 bg-slate-900/80 p-3"
              >
                <div className="mb-2 flex items-center gap-2">
                  <Terminal className="h-4 w-4 text-slate-400" />
                  <span className="text-xs font-semibold text-slate-200">
                    {platform.title}
                  </span>
                  {platform.builtin && (
                    <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-400">
                      Built-in
                    </span>
                  )}
                </div>
                <ul className="space-y-1.5">
                  {platform.steps.map((step, i) => (
                    <li key={i} className="text-[11px] text-slate-400">
                      {step}
                    </li>
                  ))}
                </ul>
                {platform.command && (
                  <div className="mt-2 rounded bg-slate-950 p-2">
                    <code className="text-[11px] text-emerald-400">
                      {platform.command}
                    </code>
                  </div>
                )}
                {platform.link && (
                  <a
                    href={platform.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 flex items-center gap-1 text-[11px] text-blue-400 hover:underline"
                  >
                    Download <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GeneralTab({
  protocol,
  setProtocol,
  autoConnect,
  setAutoConnect,
  vpnTools,
  killSwitchActive,
  onToggleKillSwitch,
}: {
  protocol: Protocol;
  setProtocol: (p: Protocol) => void;
  autoConnect: boolean;
  setAutoConnect: (b: boolean) => void;
  vpnTools: VpnToolsStatus | null;
  killSwitchActive: boolean;
  onToggleKillSwitch: () => void;
}) {
  const isProtocolAvailable = (id: Protocol): boolean => {
    if (!vpnTools) return true;
    switch (id) {
      case "wireguard":
        return vpnTools.wireguard.available;
      case "openvpn":
        return vpnTools.openvpn.available;
      case "ikev2":
        return vpnTools.ikev2.available;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
          VPN Protocol
        </h2>
        <div className="space-y-2">
          {PROTOCOL_OPTIONS.map((p) => (
            <label
              key={p.id}
              className={`flex cursor-pointer items-center justify-between rounded-lg border p-4 transition-colors ${
                protocol === p.id
                  ? "border-emerald-500/50 bg-emerald-500/10"
                  : "border-slate-700 bg-slate-900/50 hover:border-slate-600"
              }`}
            >
              <div className="flex items-center gap-3">
                <input
                  type="radio"
                  name="protocol"
                  value={p.id}
                  checked={protocol === p.id}
                  onChange={() => setProtocol(p.id)}
                  className="h-4 w-4 border-slate-600 bg-slate-800 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-slate-900"
                />
                <div>
                  <div className="text-sm font-medium text-slate-100">
                    {p.label}
                  </div>
                  <div className="text-xs text-slate-500">{p.desc}</div>
                </div>
              </div>
              {vpnTools && (
                <div className="flex items-center gap-1.5">
                  {isProtocolAvailable(p.id) ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      <span className="text-xs text-emerald-400">
                        Available
                      </span>
                    </>
                  ) : (
                    <>
                      <X className="h-3.5 w-3.5 text-red-400" />
                      <span className="text-xs text-red-400">Not found</span>
                    </>
                  )}
                </div>
              )}
            </label>
          ))}
        </div>
      </div>

      <div className="border-t border-slate-800 pt-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Startup
        </h2>
        <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-700 bg-slate-900/50 p-4">
          <div>
            <div className="text-sm font-medium text-slate-100">
              Auto-connect on launch
            </div>
            <div className="text-xs text-slate-500">
              Automatically connect to the last server when the app starts
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoConnect}
            onClick={() => setAutoConnect(!autoConnect)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
              autoConnect ? "bg-emerald-500" : "bg-slate-700"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                autoConnect ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </label>
      </div>

      <div className="border-t border-slate-800 pt-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Security
        </h2>
        <label className="flex cursor-pointer items-center justify-between rounded-lg border border-slate-700 bg-slate-900/50 p-4">
          <div>
            <div className="text-sm font-medium text-slate-100">
              Kill Switch
            </div>
            <div className="text-xs text-slate-500">
              Block all internet traffic if the VPN disconnects unexpectedly
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={killSwitchActive}
            onClick={onToggleKillSwitch}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
              killSwitchActive ? "bg-emerald-500" : "bg-slate-700"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
                killSwitchActive ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </label>
      </div>

      <NetworkRoutingSection />
    </div>
  );
}

/// Split-tunnel + auto-reconnect settings, persisted to the daemon.
function NetworkRoutingSection() {
  const [mode, setMode] = useState<SplitTunnelMode>("full");
  const [subnetsText, setSubnetsText] = useState("");
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  // Load current daemon settings on mount.
  useEffect(() => {
    (async () => {
      try {
        const [st, ar] = await Promise.all([
          getSplitTunnel(),
          getAutoReconnect(),
        ]);
        setMode(st.mode);
        setSubnetsText(
          (st.mode === "exclude" ? st.exclude_subnets : st.include_subnets).join(
            "\n",
          ),
        );
        setAutoReconnect(ar);
      } catch {
        // Daemon not running — section is informational only.
        setAvailable(false);
      }
    })();
  }, []);

  const save = async () => {
    setStatus(null);
    const subnets = subnetsText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await setSplitTunnel({
        mode,
        include_subnets: mode === "include" ? subnets : [],
        exclude_subnets: mode === "exclude" ? subnets : [],
      });
      await setAutoReconnect(autoReconnect);
      setStatus("Saved. Changes apply on the next connection.");
    } catch (e) {
      setStatus(`Failed to save: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="border-t border-slate-800 pt-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Network Routing
      </h2>

      {!available && (
        <p className="mb-3 text-xs text-amber-400">
          Start the VPN service to configure routing.
        </p>
      )}

      <label className="mb-3 flex cursor-pointer items-center justify-between rounded-lg border border-slate-700 bg-slate-900/50 p-4">
        <div>
          <div className="text-sm font-medium text-slate-100">
            Auto-reconnect
          </div>
          <div className="text-xs text-slate-500">
            Automatically re-establish the tunnel if it drops unexpectedly
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={autoReconnect}
          onClick={() => setAutoReconnect(!autoReconnect)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-slate-900 ${
            autoReconnect ? "bg-emerald-500" : "bg-slate-700"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${
              autoReconnect ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </label>

      <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
        <div className="mb-2 text-sm font-medium text-slate-100">
          Split tunneling
        </div>
        <div className="mb-3 text-xs text-slate-500">
          Choose which traffic goes through the VPN. Subnet-based; per-app routing
          is not supported.
        </div>
        <div className="mb-3 flex gap-2">
          {(["full", "include", "exclude"] as SplitTunnelMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                mode === m
                  ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-300"
                  : "border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-600"
              }`}
            >
              {m === "full" ? "Full tunnel" : m}
            </button>
          ))}
        </div>

        {mode !== "full" && (
          <div className="mb-3">
            <label
              htmlFor="split-subnets"
              className="mb-1 block text-xs text-slate-400"
            >
              {mode === "include"
                ? "Only route these subnets (CIDR, one per line)"
                : "Exclude these subnets from the tunnel (CIDR, one per line)"}
            </label>
            <textarea
              id="split-subnets"
              value={subnetsText}
              onChange={(e) => setSubnetsText(e.target.value)}
              rows={3}
              placeholder="10.0.0.0/8&#10;192.168.1.0/24"
              className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 font-mono text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
            />
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={!available}
            className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Save routing
          </button>
          {status && <span className="text-xs text-slate-400">{status}</span>}
        </div>
      </div>
    </div>
  );
}

function ConnectionTab({
  wgQuickPath,
  setWgQuickPath,
  openvpnPath,
  setOpenvpnPath,
  wireguardCliPath,
  setWireguardCliPath,
  vpnTools,
  onRefreshTools,
  isRefreshingTools,
}: {
  wgQuickPath: string;
  setWgQuickPath: (s: string) => void;
  openvpnPath: string;
  setOpenvpnPath: (s: string) => void;
  wireguardCliPath: string;
  setWireguardCliPath: (s: string) => void;
  vpnTools: VpnToolsStatus | null;
  onRefreshTools: () => Promise<void>;
  isRefreshingTools: boolean;
}) {
  // Count available tools
  const availableCount = vpnTools
    ? [
        vpnTools.wireguard.available,
        vpnTools.openvpn.available,
        vpnTools.ikev2.available,
      ].filter(Boolean).length
    : 0;
  const totalCount = 3;

  return (
    <div className="space-y-6">
      {/* Status Overview */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            VPN Tools Status
          </h2>
          <button
            type="button"
            onClick={onRefreshTools}
            disabled={isRefreshingTools}
            className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-700 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${isRefreshingTools ? "animate-spin" : ""}`}
            />
            {isRefreshingTools ? "Checking..." : "Re-check"}
          </button>
        </div>

        {/* Summary Card */}
        <div className="mb-4 flex items-center gap-4 rounded-lg border border-slate-700 bg-slate-900/50 p-4">
          <div
            className={`flex h-12 w-12 items-center justify-center rounded-full ${
              availableCount === totalCount
                ? "bg-emerald-500/20"
                : availableCount > 0
                  ? "bg-amber-500/20"
                  : "bg-red-500/20"
            }`}
          >
            <span
              className={`text-lg font-bold ${
                availableCount === totalCount
                  ? "text-emerald-400"
                  : availableCount > 0
                    ? "text-amber-400"
                    : "text-red-400"
              }`}
            >
              {availableCount}/{totalCount}
            </span>
          </div>
          <div>
            <p className="text-sm font-medium text-slate-100">
              {availableCount === totalCount
                ? "All VPN tools detected"
                : availableCount > 0
                  ? `${availableCount} of ${totalCount} VPN tools detected`
                  : "No VPN tools detected"}
            </p>
            <p className="text-xs text-slate-500">
              {availableCount === totalCount
                ? "You can use any VPN protocol"
                : "Install missing tools to enable all protocols"}
            </p>
          </div>
        </div>

        {/* Tool Cards */}
        <div className="space-y-3">
          <ToolStatusCard
            name="WireGuard"
            available={vpnTools?.wireguard.available ?? false}
            path={vpnTools?.wireguard.path ?? null}
            instructions={INSTALL_INSTRUCTIONS.wireguard}
          />
          <ToolStatusCard
            name="OpenVPN"
            available={vpnTools?.openvpn.available ?? false}
            path={vpnTools?.openvpn.path ?? null}
            instructions={INSTALL_INSTRUCTIONS.openvpn}
          />
          <ToolStatusCard
            name="IKEv2 / IPsec"
            available={vpnTools?.ikev2.available ?? false}
            path={vpnTools?.ikev2.path ?? null}
            instructions={INSTALL_INSTRUCTIONS.ikev2}
          />
        </div>
      </div>

      {/* Custom Paths */}
      <div className="border-t border-slate-800 pt-6">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Custom Executable Paths
        </h2>
        <p className="mb-4 text-xs text-slate-500">
          Override auto-detected paths. Leave empty to use system defaults.
        </p>

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-300">
              WireGuard (wg-quick)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={wgQuickPath}
                onChange={(e) => setWgQuickPath(e.target.value)}
                placeholder={vpnTools?.wireguard.path || "wg-quick"}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              {vpnTools?.wireguard.available ? (
                <div className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1.5">
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                </div>
              ) : (
                <div className="flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-1.5">
                  <X className="h-3.5 w-3.5 text-red-400" />
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-300">
              OpenVPN
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={openvpnPath}
                onChange={(e) => setOpenvpnPath(e.target.value)}
                placeholder={vpnTools?.openvpn.path || "openvpn"}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
              {vpnTools?.openvpn.available ? (
                <div className="flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-1.5">
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                </div>
              ) : (
                <div className="flex items-center gap-1 rounded-md bg-red-500/10 px-2 py-1.5">
                  <X className="h-3.5 w-3.5 text-red-400" />
                </div>
              )}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-300">
              WireGuard CLI (Windows only)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={wireguardCliPath}
                onChange={(e) => setWireguardCliPath(e.target.value)}
                placeholder="wireguard.exe"
                className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
              />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Used on Windows instead of wg-quick
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function AboutTab() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-linear-to-br from-emerald-500 to-teal-600">
          <Shield className="h-8 w-8 text-white" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-slate-100">
            vpnVPN Desktop
          </h2>
          <p className="text-sm text-slate-400">Version 1.0.0</p>
        </div>
      </div>

      <div className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
        <p className="text-sm text-slate-300">
          Secure, private VPN connection for your desktop. Your private keys
          never leave your device.
        </p>
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Features
        </h3>
        <ul className="space-y-2 text-sm text-slate-300">
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-400" />
            WireGuard, OpenVPN, and IKEv2 support
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-400" />
            Local key generation (zero-knowledge)
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-400" />
            Auto-connect on startup
          </li>
          <li className="flex items-center gap-2">
            <Check className="h-4 w-4 text-emerald-400" />
            Cross-platform (macOS, Windows, Linux)
          </li>
        </ul>
      </div>

      <div className="border-t border-slate-800 pt-6">
        <p className="text-xs text-slate-500">
          Built with Tauri, React, and Next.js.
          <br />
          No logging. No tracking. Your privacy matters.
        </p>
      </div>
    </div>
  );
}

function DebugTab({ debugInfo }: { debugInfo: DebugInfo | null }) {
  if (!debugInfo) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-slate-500">Debug info not available</p>
      </div>
    );
  }

  // Only show debug tab in non-production
  if (debugInfo.isProduction) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-sm text-slate-500">
          Debug info is only available in development mode
        </p>
      </div>
    );
  }

  const items = [
    { label: "App Connection State", value: debugInfo.connectionStatus },
    {
      label: "App Thinks Connected",
      value: debugInfo.isConnected ? "Yes" : "No",
    },
    {
      label: "Actually Connected (System)",
      value: debugInfo.actuallyConnected ? "Yes" : "No",
      highlight: debugInfo.isConnected !== debugInfo.actuallyConnected,
    },
    {
      label: "Active Protocol (System)",
      value: debugInfo.actualProtocol || "None",
    },
    {
      label: "Interface Name",
      value: debugInfo.interfaceName || "None",
    },
    { label: "Selected Protocol", value: debugInfo.protocol },
    {
      label: "Selected Server ID",
      value: debugInfo.selectedServerId || "None",
    },
    {
      label: "Selected Server Region",
      value: debugInfo.selectedServerRegion || "None",
    },
    {
      label: "WG Server Public Key",
      value: "Provided per-server in config",
    },
    {
      label: "Tauri Available",
      value: debugInfo.tauriAvailable ? "Yes" : "No",
    },
    { label: "User Country", value: debugInfo.userCountry || "Unknown" },
    {
      label: "Environment",
      value: debugInfo.isProduction ? "Production" : "Development",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/20">
          <Bug className="h-5 w-5 text-amber-400" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            Debug Information
          </h2>
          <p className="text-xs text-slate-500">
            Development environment diagnostics
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-slate-700 bg-slate-900/50 overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            {items.map((item, idx) => (
              <tr
                key={item.label}
                className={`${idx % 2 === 0 ? "bg-slate-900/30" : ""} ${
                  "highlight" in item && item.highlight ? "bg-amber-500/10" : ""
                }`}
              >
                <td className="px-4 py-2.5 text-slate-400">{item.label}</td>
                <td
                  className={`px-4 py-2.5 font-mono text-xs ${
                    "highlight" in item && item.highlight
                      ? "text-amber-400"
                      : "text-slate-200"
                  }`}
                >
                  {item.value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p className="text-xs text-amber-300">
            This tab is only visible in development mode. Debug information
            helps diagnose connection issues when not connected to production
            servers.
          </p>
        </div>
      </div>
    </div>
  );
}

export function SettingsView({
  activeTab,
  setActiveTab,
  protocol,
  setProtocol,
  autoConnect,
  setAutoConnect,
  wgQuickPath,
  setWgQuickPath,
  openvpnPath,
  setOpenvpnPath,
  wireguardCliPath,
  setWireguardCliPath,
  vpnTools,
  onRefreshTools,
  isRefreshingTools,
  debugInfo,
  onBack,
  daemonStatus,
  isDaemonLoading,
  onRefreshDaemonStatus,
  onStartDaemon,
  onStopDaemon,
  onRestartDaemon,
  onUninstallDaemon,
  onRequestPermissions,
  isDevelopment,
  onUpdateDaemon,
}: SettingsViewProps) {
  const isProduction = debugInfo?.isProduction ?? true;

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: "general", label: "General", icon: <Sliders className="h-4 w-4" /> },
    {
      id: "connection",
      label: "Connection",
      icon: <Wrench className="h-4 w-4" />,
    },
    { id: "service", label: "Service", icon: <Server className="h-4 w-4" /> },
    { id: "about", label: "About", icon: <Info className="h-4 w-4" /> },
  ];

  // Add debug tab in non-production
  if (!isProduction) {
    tabs.push({
      id: "debug" as SettingsTab,
      label: "Debug",
      icon: <Bug className="h-4 w-4" />,
    });
  }

  return (
    <div className="flex h-full flex-col bg-slate-950">
      {/* Settings Header */}
      <div className="flex items-center gap-3 border-b border-slate-800 bg-slate-900/80 px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h1 className="text-lg font-semibold text-slate-100">Settings</h1>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Tabs Sidebar */}
        <nav className="w-48 border-r border-slate-800 bg-slate-900/50 p-3">
          <ul className="space-y-1">
            {tabs.map((tab) => (
              <li key={tab.id}>
                <button
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    activeTab === tab.id
                      ? "bg-slate-800 text-slate-100"
                      : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200"
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "general" && (
            <GeneralTab
              protocol={protocol}
              setProtocol={setProtocol}
              autoConnect={autoConnect}
              setAutoConnect={setAutoConnect}
              vpnTools={vpnTools}
              killSwitchActive={daemonStatus?.kill_switch_active ?? false}
              onToggleKillSwitch={async () => {
                // Dynamically import Tauri APIs
                try {
                  const { invoke } = await import("@tauri-apps/api/core");
                  if (daemonStatus?.kill_switch_active) {
                    await invoke("disable_kill_switch");
                  } else {
                    await invoke("enable_kill_switch", { allowLan: true });
                  }
                  await onRefreshDaemonStatus();
                } catch (e) {
                  console.error("Failed to toggle kill switch:", e);
                }
              }}
            />
          )}
          {activeTab === "connection" && (
            <ConnectionTab
              wgQuickPath={wgQuickPath}
              setWgQuickPath={setWgQuickPath}
              openvpnPath={openvpnPath}
              setOpenvpnPath={setOpenvpnPath}
              wireguardCliPath={wireguardCliPath}
              setWireguardCliPath={setWireguardCliPath}
              vpnTools={vpnTools}
              onRefreshTools={onRefreshTools}
              isRefreshingTools={isRefreshingTools}
            />
          )}
          {activeTab === "service" && (
            <ServiceTab
              daemonStatus={daemonStatus}
              isLoading={isDaemonLoading}
              onRefreshStatus={onRefreshDaemonStatus}
              onStartDaemon={onStartDaemon}
              onStopDaemon={onStopDaemon}
              onRestartDaemon={onRestartDaemon}
              onUninstallDaemon={onUninstallDaemon}
              onRequestPermissions={onRequestPermissions}
              isDevelopment={isDevelopment}
              onUpdateDaemon={onUpdateDaemon}
            />
          )}
          {activeTab === "about" && <AboutTab />}
          {activeTab === "debug" && <DebugTab debugInfo={debugInfo} />}
        </div>
      </div>
    </div>
  );
}

export type ViewState = "disconnected" | "connecting" | "connected";
export type Protocol = "wireguard" | "openvpn" | "ikev2";

export type MapServer = {
  id: string;
  region: string;
  country?: string;
  status: string;
  sessions: number;
  publicKey?: string | null;
  publicIp?: string | null;
  wgEndpoint?: string | null;
  wgPort?: number | null;
  ovpnEndpoint?: string | null;
  ovpnPort?: number | null;
  ovpnCaBundle?: string | null;
  ovpnPeerFingerprint?: string | null;
  ikev2Remote?: string | null;
  cpu?: number;
  lastSeen?: string;
  metadata?: {
    port?: number;
    [key: string]: unknown;
  };
};

export type VpnToolInfo = {
  available: boolean;
  path: string | null;
  version: string | null;
  custom_path: string | null;
  error: string | null;
};

export type VpnToolsStatus = {
  wireguard: VpnToolInfo;
  openvpn: VpnToolInfo;
  ikev2: VpnToolInfo;
};

export type VpnToolsStatusLegacy = {
  wireguard_available: boolean;
  wireguard_path: string | null;
  openvpn_available: boolean;
  openvpn_path: string | null;
  ikev2_available: boolean;
  ikev2_path: string | null;
};

export type VpnBinaryPaths = {
  wg_quick_path?: string | null;
  wireguard_cli_path?: string | null;
  openvpn_path?: string | null;
  ikev2_path?: string | null;
};

export type DesktopSettings = {
  preferred_protocol?: Protocol;
  auto_connect?: boolean;
  wg_quick_path?: string | null;
  openvpn_path?: string | null;
  wireguard_cli_path?: string | null;
};

export type VpnConnectionStatus = {
  is_connected: boolean;
  protocol: string | null;
  interface_name: string | null;
  bytes_sent?: number | null;
  bytes_received?: number | null;
  connected_at?: string | null;
  assigned_ip?: string | null;
  server_id?: string | null;
  server_region?: string | null;
};

export type DaemonStatus = {
  running: boolean;
  version: string;
  uptime_secs: number;
  has_network_permission: boolean;
  has_firewall_permission: boolean;
  kill_switch_active: boolean;
  vpn_tools?: VpnToolsStatus;
  channel?: string;
  source?: string;
  binary_path?: string | null;
  using_dev_socket?: boolean;
};

export type DaemonLogChunk = {
  cursor: number;
  lines: string[];
  truncated: boolean;
};

export type OnboardingState = {
  completed: boolean;
  current_step: string;
  selected_protocol: Protocol | null;
  kill_switch_enabled: boolean;
  allow_lan: boolean;
  daemon_installed: boolean;
};

export type AppView = "main" | "settings" | "onboarding";
export type SettingsTab =
  | "general"
  | "connection"
  | "service"
  | "about"
  | "debug";

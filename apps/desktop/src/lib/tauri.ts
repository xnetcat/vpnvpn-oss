import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import type {
  Protocol,
  VpnToolsStatus,
  VpnToolsStatusLegacy,
  VpnBinaryPaths,
  DesktopSettings,
  VpnConnectionStatus,
  DaemonStatus,
  OnboardingState,
  DaemonLogChunk,
} from "./types";

// Logging helpers
const logToBackend = async (level: string, ...args: unknown[]) => {
  try {
    // Convert args to string, handling objects and arrays
    const message = args
      .map((arg) => {
        if (typeof arg === "object" && arg !== null) {
          try {
            return JSON.stringify(arg, null, 2);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(" ");
    await invoke("log_from_frontend", { level, message });
  } catch (e) {
    // Silently fail if backend logging is unavailable
    // This prevents infinite loops if the backend itself has issues
  }
};

export const log = (...args: unknown[]) => {
  console.log("[desktop]", ...args);
  void logToBackend("log", "[desktop]", ...args);
};

export const logError = (...args: unknown[]) => {
  console.error("[desktop]", ...args);
  void logToBackend("error", "[desktop]", ...args);
};

// VPN config operations
export type ApplyVpnConfigResult = {
  /** macOS IKEv2 only: the VPN profile was written and opened, and now awaits
   * one-time user approval in System Settings. Not an error — the UI shows an
   * instruction plus a retry affordance. */
  pending_approval: boolean;
  state: string;
};

export async function applyVpnConfig(
  protocol: Protocol,
  config: string,
  credentials?: { username: string; password: string }
): Promise<ApplyVpnConfigResult> {
  return await invoke<ApplyVpnConfigResult>("apply_vpn_config", {
    protocol,
    config,
    credentials,
  });
}

/** Whether the vpnVPN IKEv2 profile is installed/approved (macOS built-in
 * client). False on other platforms or when the check fails. */
export async function ikev2ProfileInstalled(): Promise<boolean> {
  try {
    return await invoke<boolean>("ikev2_profile_installed");
  } catch (e) {
    logError("Failed to check IKEv2 profile state", e);
    return false;
  }
}

export async function disconnectVpn(protocol: Protocol): Promise<void> {
  await invoke("disconnect_vpn", { protocol });
}

// Generate WireGuard keypair via Tauri (private key stays local)
export async function generateWireguardKeys(): Promise<[string, string]> {
  return await invoke<[string, string]>("generate_wireguard_keys");
}

// VPN tools detection - uses daemon when available, falls back to basic detection
export async function detectVpnTools(): Promise<VpnToolsStatus | null> {
  try {
    // Get tools from Tauri which delegates to daemon if available
    const legacy = await invoke<VpnToolsStatusLegacy>("detect_vpn_tools");

    if (legacy) {
      return {
        wireguard: {
          available: legacy.wireguard_available,
          path: legacy.wireguard_path,
          version: null,
          custom_path: null,
          error: legacy.wireguard_available ? null : "WireGuard not found",
        },
        openvpn: {
          available: legacy.openvpn_available,
          path: legacy.openvpn_path,
          version: null,
          custom_path: null,
          error: legacy.openvpn_available ? null : "OpenVPN not found",
        },
        ikev2: {
          available: legacy.ikev2_available,
          path: legacy.ikev2_path,
          version: null,
          custom_path: null,
          error: legacy.ikev2_available ? null : "IKEv2 tool not found",
        },
      };
    }

    return null;
  } catch (e) {
    logError("Failed to detect VPN tools", e);
    return null;
  }
}

// Get detailed VPN tools info from daemon (includes version, custom paths, errors)
export async function getVpnToolsDetailed(): Promise<VpnToolsStatus | null> {
  try {
    return await invoke<VpnToolsStatus>("get_vpn_tools_detailed");
  } catch (e) {
    logError("Failed to get detailed VPN tools", e);
    return null;
  }
}

// Refresh VPN tools detection (triggers daemon to re-scan)
export async function refreshVpnTools(): Promise<VpnToolsStatus | null> {
  try {
    const legacy = await invoke<VpnToolsStatusLegacy>("refresh_vpn_tools");

    if (legacy) {
      return {
        wireguard: {
          available: legacy.wireguard_available,
          path: legacy.wireguard_path,
          version: null,
          custom_path: null,
          error: legacy.wireguard_available ? null : "WireGuard not found",
        },
        openvpn: {
          available: legacy.openvpn_available,
          path: legacy.openvpn_path,
          version: null,
          custom_path: null,
          error: legacy.openvpn_available ? null : "OpenVPN not found",
        },
        ikev2: {
          available: legacy.ikev2_available,
          path: legacy.ikev2_path,
          version: null,
          custom_path: null,
          error: legacy.ikev2_available ? null : "IKEv2 tool not found",
        },
      };
    }

    return null;
  } catch (e) {
    logError("Failed to refresh VPN tools", e);
    return null;
  }
}

// Update VPN binary paths in daemon and return refreshed tools status
export async function updateVpnBinaryPaths(
  paths: VpnBinaryPaths
): Promise<VpnToolsStatus | null> {
  try {
    log("Updating VPN binary paths:", paths);

    const legacy = await invoke<VpnToolsStatusLegacy>(
      "update_vpn_binary_paths",
      {
        wgQuickPath: paths.wg_quick_path ?? null,
        wireguardCliPath: paths.wireguard_cli_path ?? null,
        openvpnPath: paths.openvpn_path ?? null,
        ikev2Path: paths.ikev2_path ?? null,
      }
    );

    if (legacy) {
      return {
        wireguard: {
          available: legacy.wireguard_available,
          path: legacy.wireguard_path,
          version: null,
          custom_path: paths.wg_quick_path ?? paths.wireguard_cli_path ?? null,
          error: legacy.wireguard_available ? null : "WireGuard not found",
        },
        openvpn: {
          available: legacy.openvpn_available,
          path: legacy.openvpn_path,
          version: null,
          custom_path: paths.openvpn_path ?? null,
          error: legacy.openvpn_available ? null : "OpenVPN not found",
        },
        ikev2: {
          available: legacy.ikev2_available,
          path: legacy.ikev2_path,
          version: null,
          custom_path: paths.ikev2_path ?? null,
          error: legacy.ikev2_available ? null : "IKEv2 tool not found",
        },
      };
    }

    return null;
  } catch (e) {
    logError("Failed to update VPN binary paths", e);
    throw e; // Re-throw so caller knows it failed
  }
}

// VPN connection status
export async function checkVpnStatus(): Promise<VpnConnectionStatus | null> {
  try {
    return await invoke<VpnConnectionStatus>("check_vpn_status");
  } catch (e) {
    logError("Failed to check VPN status", e);
    return null;
  }
}

// Desktop settings
export async function getDesktopSettings(): Promise<DesktopSettings | null> {
  try {
    return await invoke<DesktopSettings>("get_desktop_settings");
  } catch (e) {
    logError("Failed to get desktop settings", e);
    return null;
  }
}

export async function updateDesktopSettings(settings: {
  preferredProtocol?: string;
  autoConnect?: boolean;
  wgQuickPath?: string;
  openvpnPath?: string;
  wireguardCliPath?: string;
}): Promise<void> {
  try {
    // Tauri expects parameter name as key
    await invoke("update_desktop_settings", {
      update: {
        preferred_protocol: settings.preferredProtocol,
        auto_connect: settings.autoConnect,
        wg_quick_path: settings.wgQuickPath,
        openvpn_path: settings.openvpnPath,
        wireguard_cli_path: settings.wireguardCliPath,
      },
    });
  } catch (e) {
    logError("Failed to update desktop settings", e);
  }
}

// Health check
export async function healthCheck(): Promise<boolean> {
  try {
    const result = await invoke<{ ok: boolean }>("health_check");
    return result.ok;
  } catch (e) {
    logError("Health check failed", e);
    return false;
  }
}

// Get unique machine identifier
export async function getMachineId(): Promise<string | null> {
  try {
    return await invoke<string>("get_machine_id");
  } catch (e) {
    logError("Failed to get machine ID", e);
    return null;
  }
}

// Open URL in default browser
export async function openInBrowser(url: string): Promise<void> {
  try {
    await open(url);
  } catch (e) {
    logError("Failed to open URL in browser", e);
  }
}

// ============ Daemon operations ============

// Check if daemon is available
export async function isDaemonAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_daemon_available");
  } catch (e) {
    logError("Failed to check daemon availability", e);
    return false;
  }
}

// Get daemon status
export async function getDaemonStatus(): Promise<DaemonStatus | null> {
  try {
    return await invoke<DaemonStatus>("get_daemon_status");
  } catch (e) {
    logError("Failed to get daemon status", e);
    return null;
  }
}

// Get daemon logs (for debugging)
export async function getDaemonLogs(): Promise<string> {
  try {
    return await invoke<string>("get_daemon_logs");
  } catch (e) {
    logError("Failed to get daemon logs", e);
    return `Error getting logs: ${e}`;
  }
}

// Tail daemon logs (cursor-based)
export async function tailDaemonLogs(
  cursor?: number
): Promise<DaemonLogChunk | null> {
  try {
    return await invoke<DaemonLogChunk>("tail_daemon_logs", { cursor });
  } catch (e) {
    logError("Failed to tail daemon logs", e);
    return null;
  }
}

// Enable kill switch
export async function enableKillSwitch(allowLan: boolean): Promise<void> {
  await invoke("enable_kill_switch", { allowLan });
}

// Disable kill switch
export async function disableKillSwitch(): Promise<void> {
  await invoke("disable_kill_switch");
}

// Restart daemon
export async function restartDaemon(): Promise<void> {
  await invoke("restart_daemon");
}

// Stop daemon
export async function stopDaemon(): Promise<void> {
  await invoke("stop_daemon");
}

// Install daemon
export async function installDaemon(): Promise<void> {
  await invoke("install_daemon");
}

// Uninstall daemon
export async function uninstallDaemon(): Promise<void> {
  await invoke("uninstall_daemon");
}

// Get onboarding state
export async function getOnboardingState(): Promise<OnboardingState | null> {
  try {
    return await invoke<OnboardingState>("get_onboarding_state");
  } catch (e) {
    logError("Failed to get onboarding state", e);
    return null;
  }
}

// Save onboarding state
export async function saveOnboardingState(
  state: OnboardingState
): Promise<void> {
  await invoke("save_onboarding_state", { state });
}

// Check if running in development mode
export async function isDevelopmentMode(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_development");
  } catch (e) {
    logError("Failed to check development mode", e);
    return false;
  }
}

// Update daemon in development mode (build and reinstall)
export async function updateDaemonDev(): Promise<void> {
  await invoke("update_daemon_dev");
}

// Update daemon (channel-aware). For non-dev channels this drives the daemon's
// signed-update flow (stage the signed binary, verify its signature, restart);
// for the dev channel it rebuilds from source. The Rust side picks the strategy.
export async function updateDaemon(): Promise<void> {
  await invoke("update_daemon");
}

// ============ Split tunneling ============

export type SplitTunnelMode = "full" | "include" | "exclude";

export type SplitTunnelSettings = {
  mode: SplitTunnelMode;
  include_subnets: string[];
  exclude_subnets: string[];
};

export async function getSplitTunnel(): Promise<SplitTunnelSettings> {
  return await invoke<SplitTunnelSettings>("get_split_tunnel");
}

export async function setSplitTunnel(
  config: SplitTunnelSettings,
): Promise<void> {
  await invoke("set_split_tunnel", { config });
}

// ============ Auto-reconnect ============

export async function getAutoReconnect(): Promise<boolean> {
  return await invoke<boolean>("get_auto_reconnect");
}

export async function setAutoReconnect(enabled: boolean): Promise<void> {
  await invoke("set_auto_reconnect", { enabled });
}

// ============ System Tray operations ============

// Update system tray state
export async function updateTrayState(params: {
  connected: boolean;
  killSwitchEnabled: boolean;
  autoStartEnabled: boolean;
  serverName?: string;
}): Promise<void> {
  try {
    await invoke("update_tray_state", {
      connected: params.connected,
      killSwitchEnabled: params.killSwitchEnabled,
      autoStartEnabled: params.autoStartEnabled,
      serverName: params.serverName ?? null,
    });
  } catch (e) {
    logError("Failed to update tray state", e);
  }
}

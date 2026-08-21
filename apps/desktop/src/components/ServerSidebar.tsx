import { useState, useMemo } from "react";
import { RefreshCw, ChevronRight, ChevronDown, Zap } from "lucide-react";
import type { MapServer, ViewState, Protocol } from "../lib/types";

type ServerSidebarProps = {
  servers: MapServer[];
  selectedServer: MapServer | null;
  onSelectServer: (id: string) => void;
  onConnect: () => void;
  status: ViewState;
  protocol: Protocol;
  onRefresh?: () => void;
  isRefreshing?: boolean;
};

// Group servers by country
function groupByCountry(servers: MapServer[]): Map<string, MapServer[]> {
  const grouped = new Map<string, MapServer[]>();
  for (const server of servers) {
    const country = server.country ?? "Unknown";
    const existing = grouped.get(country) ?? [];
    existing.push(server);
    grouped.set(country, existing);
  }
  // Sort countries alphabetically
  return new Map(
    [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])),
  );
}

export function ServerSidebar({
  servers,
  selectedServer,
  onSelectServer,
  onConnect,
  status,
  protocol,
  onRefresh,
  isRefreshing,
}: ServerSidebarProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedCountries, setExpandedCountries] = useState<Set<string>>(
    new Set(),
  );

  // Group servers by country
  const groupedServers = useMemo(() => groupByCountry(servers), [servers]);

  // Filter servers based on search
  const filteredGroups = useMemo(() => {
    if (!searchTerm) return groupedServers;

    const lowerTerm = searchTerm.toLowerCase();
    const filtered = new Map<string, MapServer[]>();

    for (const [country, countryServers] of groupedServers) {
      // Check if country matches
      if (country.toLowerCase().includes(lowerTerm)) {
        filtered.set(country, countryServers);
        continue;
      }
      // Check if any server region matches
      const matchingServers = countryServers.filter((s) =>
        s.region.toLowerCase().includes(lowerTerm),
      );
      if (matchingServers.length > 0) {
        filtered.set(country, matchingServers);
      }
    }

    return filtered;
  }, [groupedServers, searchTerm]);

  // Auto-expand countries when searching
  useMemo(() => {
    if (searchTerm) {
      setExpandedCountries(new Set(filteredGroups.keys()));
    }
  }, [searchTerm, filteredGroups]);

  // Auto-expand the country of the selected server
  useMemo(() => {
    if (selectedServer?.country) {
      setExpandedCountries(
        (prev) => new Set([...prev, selectedServer.country!]),
      );
    }
  }, [selectedServer?.country]);

  const toggleCountry = (country: string) => {
    setExpandedCountries((prev) => {
      const next = new Set(prev);
      if (next.has(country)) {
        next.delete(country);
      } else {
        next.add(country);
      }
      return next;
    });
  };

  const isConnecting = status === "connecting";
  const isConnected = status === "connected";

  const protocolLabel =
    protocol === "wireguard"
      ? "WireGuard"
      : protocol === "openvpn"
        ? "OpenVPN"
        : "IKEv2";

  return (
    <aside className="hidden w-72 flex-col border-r border-slate-800 bg-slate-900/80 md:flex">
      {/* Search Header */}
      <div className="border-b border-slate-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Search country or region..."
            value={searchTerm}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              title="Refresh server list"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
              />
            </button>
          )}
        </div>
        {/* Protocol indicator */}
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-slate-500">Protocol:</span>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
            {protocolLabel}
          </span>
        </div>
      </div>

      {/* Server List */}
      <div className="flex-1 overflow-y-auto p-2">
        <h2 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Locations ({filteredGroups.size})
        </h2>

        {filteredGroups.size === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-slate-500">
            {isRefreshing ? (
              "Loading servers..."
            ) : searchTerm ? (
              "No servers match your search."
            ) : (
              <>
                No servers available.
                <br />
                Check your subscription.
              </>
            )}
          </div>
        ) : (
          <ul className="space-y-1">
            {[...filteredGroups.entries()].map(([country, countryServers]) => {
              const isExpanded = expandedCountries.has(country);
              const onlineCount = countryServers.filter(
                (s) => s.status === "online",
              ).length;
              const hasSelectedServer = countryServers.some(
                (s) => s.id === selectedServer?.id,
              );

              return (
                <li key={country}>
                  {/* Country Header */}
                  <button
                    type="button"
                    onClick={() => toggleCountry(country)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${
                      hasSelectedServer
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "text-slate-300 hover:bg-slate-800/80"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-slate-500" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-slate-500" />
                      )}
                      <span className="text-sm font-medium">{country}</span>
                    </div>
                    <span className="text-xs text-slate-500">
                      {onlineCount}/{countryServers.length} online
                    </span>
                  </button>

                  {/* Server List (expanded) */}
                  {isExpanded && (
                    <ul className="ml-4 mt-1 space-y-1 border-l border-slate-800 pl-2">
                      {countryServers.map((server) => {
                        const isSelected = selectedServer?.id === server.id;
                        const isOnline = server.status === "online";

                        return (
                          <li key={server.id}>
                            <div
                              className={`rounded-lg px-3 py-2 transition-colors ${
                                isSelected
                                  ? "bg-emerald-500/20"
                                  : "hover:bg-slate-800/60"
                              }`}
                            >
                              {/* Server Info - clickable row */}
                              <button
                                type="button"
                                onClick={() => onSelectServer(server.id)}
                                className={`flex w-full items-center gap-2 text-left ${
                                  isSelected
                                    ? "text-emerald-300"
                                    : "text-slate-400 hover:text-slate-200"
                                }`}
                              >
                                <span
                                  className={`h-2 w-2 rounded-full ${
                                    isOnline ? "bg-emerald-400" : "bg-slate-500"
                                  }`}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium">
                                    {server.region}
                                  </div>
                                  <div className="text-xs text-slate-500">
                                    {server.sessions} sessions
                                  </div>
                                </div>
                              </button>

                              {/* Connect Button - only for selected server */}
                              {isSelected && (
                                <button
                                  type="button"
                                  onClick={onConnect}
                                  disabled={
                                    !isOnline || isConnecting || isConnected
                                  }
                                  className={`mt-2 flex w-full items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors ${
                                    isConnected
                                      ? "bg-emerald-500/20 text-emerald-400"
                                      : isConnecting
                                        ? "bg-yellow-500/20 text-yellow-400"
                                        : isOnline
                                          ? "bg-emerald-500 text-white hover:bg-emerald-400"
                                          : "cursor-not-allowed bg-slate-700 text-slate-500"
                                  }`}
                                >
                                  <Zap className="h-3 w-3" />
                                  {isConnected
                                    ? "Connected"
                                    : isConnecting
                                      ? "Connecting..."
                                      : !isOnline
                                        ? "Offline"
                                        : `Connect via ${protocolLabel}`}
                                </button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

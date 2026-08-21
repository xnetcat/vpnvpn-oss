import { memo, useMemo, useState } from "react";
import {
  ComposableMap,
  Geographies,
  Geography,
  Marker,
} from "react-simple-maps";
import { Shield, X, Zap, MapPin, Users } from "lucide-react";
import type { MapServer, ViewState, Protocol } from "../lib/types";
import { COUNTRY_COORDS, REGION_TO_COUNTRY } from "../lib/constants";

// TopoJSON world map (Natural Earth)
const GEO_URL =
  "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

type ServerMapProps = {
  servers: MapServer[];
  selectedServer: MapServer | null;
  userCountry: string | null;
  onSelectServer: (id: string) => void;
  onConnect: () => void;
  status: ViewState;
  protocol: Protocol;
};

// Get coordinates for a server
function getServerCoords(
  server: MapServer,
  userCountry: string | null,
): [number, number] | null {
  // Try direct country code
  if (server.country && COUNTRY_COORDS[server.country]) {
    const coords = COUNTRY_COORDS[server.country];
    return [coords.lng, coords.lat];
  }

  // Try region mapping
  const countryFromRegion = REGION_TO_COUNTRY[server.region.toLowerCase()];
  if (countryFromRegion && COUNTRY_COORDS[countryFromRegion]) {
    const coords = COUNTRY_COORDS[countryFromRegion];
    return [coords.lng, coords.lat];
  }

  // For "local" servers, use user's country
  if (
    server.region.toLowerCase() === "local" &&
    userCountry &&
    COUNTRY_COORDS[userCountry]
  ) {
    const coords = COUNTRY_COORDS[userCountry];
    return [coords.lng, coords.lat];
  }

  // Default fallback
  return null;
}

// Memoized geography component to prevent re-renders
const WorldGeographies = memo(function WorldGeographies() {
  return (
    <Geographies geography={GEO_URL}>
      {({ geographies }) =>
        geographies.map((geo) => (
          <Geography
            key={geo.rsmKey}
            geography={geo}
            fill="#1e293b"
            stroke="#334155"
            strokeWidth={0.5}
            style={{
              default: { outline: "none" },
              hover: { outline: "none", fill: "#334155" },
              pressed: { outline: "none" },
            }}
          />
        ))
      }
    </Geographies>
  );
});

// Server popup component
function ServerPopup({
  server,
  onConnect,
  onClose,
  status,
  protocol,
}: {
  server: MapServer;
  onConnect: () => void;
  onClose: () => void;
  status: ViewState;
  protocol: Protocol;
}) {
  const isOnline = server.status === "online";
  const isConnecting = status === "connecting";
  const isConnected = status === "connected";

  const protocolLabel =
    protocol === "wireguard"
      ? "WireGuard"
      : protocol === "openvpn"
        ? "OpenVPN"
        : "IKEv2";

  return (
    <div className="absolute left-1/2 top-1/2 z-20 w-72 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-700 bg-slate-900/95 p-4 shadow-2xl backdrop-blur-sm">
      {/* Close button */}
      <button
        type="button"
        onClick={onClose}
        className="absolute right-2 top-2 rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200"
      >
        <X className="h-4 w-4" />
      </button>

      {/* Server info */}
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <span
            className={`h-3 w-3 rounded-full ${
              isOnline ? "bg-emerald-400" : "bg-slate-500"
            }`}
          />
          <h3 className="text-lg font-semibold text-slate-100">
            {server.country ?? "Unknown"}
          </h3>
        </div>
        <p className="mt-1 text-sm text-slate-400">{server.region}</p>
      </div>

      {/* Server stats */}
      <div className="mb-4 flex gap-4 text-xs text-slate-400">
        <div className="flex items-center gap-1">
          <MapPin className="h-3 w-3" />
          <span>{isOnline ? "Online" : "Offline"}</span>
        </div>
        <div className="flex items-center gap-1">
          <Users className="h-3 w-3" />
          <span>{server.sessions} sessions</span>
        </div>
      </div>

      {/* Protocol badge */}
      <div className="mb-4">
        <span className="rounded-full bg-slate-800 px-2 py-1 text-xs text-slate-300">
          {protocolLabel}
        </span>
      </div>

      {/* Connect button */}
      <button
        type="button"
        onClick={() => {
          onConnect();
          onClose();
        }}
        disabled={!isOnline || isConnecting || isConnected}
        className={`flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium transition-colors ${
          isConnected
            ? "bg-emerald-500/20 text-emerald-400"
            : isConnecting
              ? "bg-yellow-500/20 text-yellow-400"
              : "bg-emerald-500 text-white hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        }`}
      >
        <Zap className="h-4 w-4" />
        {isConnected
          ? "Connected"
          : isConnecting
            ? "Connecting..."
            : !isOnline
              ? "Server Offline"
              : "Connect"}
      </button>
    </div>
  );
}

export function ServerMap({
  servers,
  selectedServer,
  userCountry,
  onSelectServer,
  onConnect,
  status,
  protocol,
}: ServerMapProps) {
  const [popupServer, setPopupServer] = useState<MapServer | null>(null);

  // Compute markers with coordinates
  const markers = useMemo(() => {
    return servers
      .map((server) => {
        const coords = getServerCoords(server, userCountry);
        if (!coords) return null;
        return { server, coords };
      })
      .filter(Boolean) as { server: MapServer; coords: [number, number] }[];
  }, [servers, userCountry]);

  const handleMarkerClick = (server: MapServer) => {
    onSelectServer(server.id);
    setPopupServer(server);
  };

  const handleConnect = () => {
    onConnect();
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Map Background */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900" />

      {/* Map Container */}
      <div className="absolute inset-4 overflow-hidden rounded-2xl border border-slate-800/60 bg-slate-900/40 shadow-inner">
        {/* Decorative gradients */}
        <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-2xl">
          <div className="absolute -left-20 -top-20 h-60 w-60 rounded-full bg-emerald-500/10 blur-3xl" />
          <div className="absolute -bottom-20 -right-20 h-60 w-60 rounded-full bg-blue-500/10 blur-3xl" />
        </div>

        {servers.length > 0 ? (
          <>
            <ComposableMap
              projection="geoMercator"
              projectionConfig={{
                scale: 130,
                center: [10, 30],
              }}
              className="h-full w-full"
            >
              <WorldGeographies />

              {/* Server markers */}
              {markers.map(({ server, coords }) => {
                const isActive = selectedServer?.id === server.id;
                return (
                  <Marker key={server.id} coordinates={coords}>
                    <g
                      onClick={() => handleMarkerClick(server)}
                      style={{ cursor: "pointer" }}
                    >
                      {/* Pulse ring for active */}
                      {isActive && (
                        <circle
                          r={12}
                          fill="none"
                          stroke="#34d399"
                          strokeWidth={1}
                          opacity={0.5}
                          className="animate-ping"
                        />
                      )}
                      {/* Outer glow for active */}
                      {isActive && (
                        <circle r={8} fill="#10b981" fillOpacity={0.3} />
                      )}
                      {/* Main marker */}
                      <circle
                        r={isActive ? 6 : 4}
                        fill={isActive ? "#34d399" : "#94a3b8"}
                        stroke={isActive ? "#a7f3d0" : "#64748b"}
                        strokeWidth={2}
                        className="transition-all duration-200 hover:fill-emerald-400"
                      />
                    </g>
                  </Marker>
                );
              })}
            </ComposableMap>

            {/* Server Popup */}
            {popupServer && (
              <ServerPopup
                server={popupServer}
                onConnect={handleConnect}
                onClose={() => setPopupServer(null)}
                status={status}
                protocol={protocol}
              />
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center">
              <Shield className="mx-auto h-12 w-12 text-slate-600" />
              <p className="mt-3 text-sm text-slate-500">
                No servers available
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

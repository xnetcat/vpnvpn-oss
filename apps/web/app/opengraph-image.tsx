import { ImageResponse } from "next/og";

// Branded Open Graph card, colors matching the site theme (slate-950 base,
// emerald→teal accent). Served at /opengraph-image and referenced from the
// root layout's openGraph metadata automatically by Next.js.
export const alt = "vpnVPN — Privacy-first VPN";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#020617",
        backgroundImage:
          "radial-gradient(circle at 50% 0%, rgba(16,185,129,0.25) 0%, rgba(2,6,23,0) 60%)",
        color: "#f8fafc",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 120,
          height: 120,
          borderRadius: 32,
          background: "linear-gradient(135deg, #10b981 0%, #14b8a6 100%)",
          fontSize: 64,
          marginBottom: 40,
        }}
      >
        🛡️
      </div>
      <div style={{ fontSize: 88, fontWeight: 700, letterSpacing: -2 }}>
        vpnVPN
      </div>
      <div style={{ fontSize: 36, color: "#94a3b8", marginTop: 16 }}>
        Privacy-first VPN. WireGuard, OpenVPN and IKEv2. No traffic logging.
      </div>
    </div>,
    size,
  );
}

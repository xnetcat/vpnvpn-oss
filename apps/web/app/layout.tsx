import "./globals.css";
import type { Metadata } from "next";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { TRPCProvider } from "@/lib/trpc/Provider";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

// Canonical site URL for absolute metadata URLs (OG image, canonical links).
// Read from process.env directly with a static fallback: this is evaluated
// during `next build`, where WEB_ENV values may be absent (they are injected
// at runtime in Docker/Railway) and `new URL("")` would throw. A malformed
// NEXTAUTH_URL (e.g. missing scheme) must degrade to the default instead of
// crashing module evaluation.
const FALLBACK_SITE_URL = "https://vpnvpn.dev";
function resolveSiteUrl(): string {
  try {
    return new URL(
      process.env.NEXTAUTH_URL?.trim() || FALLBACK_SITE_URL,
    ).toString();
  } catch {
    return FALLBACK_SITE_URL;
  }
}
const siteUrl = resolveSiteUrl();

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "vpnVPN — Privacy-first VPN", template: "%s — vpnVPN" },
  description:
    "Privacy-first VPN with WireGuard, OpenVPN and IKEv2. No traffic logging.",
  openGraph: {
    title: "vpnVPN — Privacy-first VPN",
    description:
      "Privacy-first VPN with WireGuard, OpenVPN and IKEv2. No traffic logging.",
    url: siteUrl,
    siteName: "vpnVPN",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "vpnVPN — Privacy-first VPN",
    description:
      "Privacy-first VPN with WireGuard, OpenVPN and IKEv2. No traffic logging.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-50 antialiased">
        <TRPCProvider>
          {/* Header */}
          <SiteHeader />
          {children}
          <SiteFooter />
          <Analytics />
          <SpeedInsights />
        </TRPCProvider>
      </body>
    </html>
  );
}

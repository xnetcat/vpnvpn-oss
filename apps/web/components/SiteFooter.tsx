import Link from "next/link";
import { headers } from "next/headers";

// Marketing/site footer. Hidden on the app shell (dashboard/admin) where the
// dedicated dashboard chrome takes over, matching SiteHeader's behavior.
export default async function SiteFooter() {
  const headersList = await headers();
  const pathname = (headersList.get("x-pathname") || "").toLowerCase();

  const isAppShellRoute = [
    "/dashboard",
    "/devices",
    "/servers",
    "/account",
    "/admin",
  ].some((prefix) => pathname.startsWith(prefix));

  if (isAppShellRoute) {
    return null;
  }

  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-slate-800 bg-slate-950/95">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
        <p>© {year} vpnVPN. Secure, private, no-logging VPN service.</p>
        <nav className="flex flex-wrap items-center gap-4">
          <Link href="/pricing" className="hover:text-slate-200">
            Pricing
          </Link>
          <Link href="/transparency" className="hover:text-slate-200">
            Transparency
          </Link>
          <Link href="/terms" className="hover:text-slate-200">
            Terms of Service
          </Link>
          <Link href="/privacy" className="hover:text-slate-200">
            Privacy Policy
          </Link>
        </nav>
      </div>
    </footer>
  );
}

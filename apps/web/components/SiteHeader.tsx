import Link from "next/link";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import SignOutButton from "@/components/SignOutButton";

export default async function SiteHeader() {
  const headersList = await headers();
  const pathname = (headersList.get("x-pathname") || "").toLowerCase();

  // Hide the marketing header on app shells (dashboard/admin).
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

  const session = await getSession();
  const authed = Boolean((session?.user as any)?.id);
  const isAdmin = (session?.user as any)?.role === "admin";
  return (
    <header className="border-b border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link
          href={authed ? "/dashboard" : "/"}
          className="text-sm font-semibold tracking-tight text-slate-100"
        >
          vpnVPN
        </Link>
        <nav className="flex items-center gap-4 text-xs font-medium text-slate-300">
          {authed ? (
            <>
              <Link href="/dashboard" className="hover:text-slate-50">
                Dashboard
              </Link>
              {isAdmin && (
                <Link href="/admin" className="hover:text-slate-50">
                  Admin
                </Link>
              )}
              <Link href="/servers" className="hover:text-slate-50">
                Servers
              </Link>
              <Link href="/transparency" className="hover:text-slate-50">
                Transparency
              </Link>
              <Link href="/account" className="hover:text-slate-50">
                Account
              </Link>
              <SignOutButton />
            </>
          ) : (
            <>
              <Link href="/pricing" className="hover:text-slate-50">
                Pricing
              </Link>
              <Link href="/transparency" className="hover:text-slate-50">
                Transparency
              </Link>
              <Link href="/auth/register" className="hover:text-slate-50">
                Register
              </Link>
              <Link
                href="/auth/signin"
                className="rounded-full bg-slate-50 px-3 py-1 text-slate-900 hover:bg-slate-200"
              >
                Sign in
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

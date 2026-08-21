import Link from "next/link";
import { Shield } from "lucide-react";

export default function NotFound() {
  return (
    <main className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600">
          <Shield className="h-7 w-7 text-white" />
        </div>
        <p className="text-sm font-semibold uppercase tracking-wide text-emerald-400">
          404
        </p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-50">
          Page not found
        </h1>
        <p className="mt-3 text-sm text-slate-400">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center justify-center rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-500 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/25 transition hover:from-emerald-400 hover:to-cyan-400"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}

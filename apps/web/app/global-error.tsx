"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] global error", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-950 text-slate-50 antialiased">
        <main className="flex min-h-screen items-center justify-center px-4">
          <div className="w-full max-w-md text-center">
            <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600">
              <span className="text-2xl font-bold text-white">v</span>
            </div>
            <p className="text-sm font-semibold uppercase tracking-wide text-rose-400">
              Something went wrong
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-slate-50">
              The app failed to load
            </h1>
            <p className="mt-3 text-sm text-slate-400">
              An unexpected error occurred. Please try again.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => reset()}
                className="inline-flex items-center justify-center rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-500 px-5 py-2.5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/25 transition hover:from-emerald-400 hover:to-cyan-400"
              >
                Try again
              </button>
              <a
                href="/"
                className="inline-flex items-center justify-center rounded-lg border border-slate-700/80 bg-slate-900/50 px-5 py-2.5 text-sm font-semibold text-slate-100 transition hover:border-slate-600 hover:bg-slate-800"
              >
                Back to home
              </a>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}

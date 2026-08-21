"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { FormEvent } from "react";
import { Suspense, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { Shield, Mail, Key, ArrowRight } from "lucide-react";

type MagicState = "idle" | "sending" | "sent" | "error";
type CodeState = "idle" | "verifying" | "error" | "success";

const providers = [
  { id: "github", label: "Continue with GitHub" },
  { id: "google", label: "Continue with Google" },
];

// Human-readable messages for NextAuth's `?error=` codes. `pages.error` points
// at this page (see lib/auth.ts), so OAuth callback failures, expired magic
// links etc. surface here instead of NextAuth's unstyled default error page.
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  OAuthAccountNotLinked:
    "That email is already linked to a different sign-in method. Use the provider you originally signed up with.",
  AccessDenied: "Access denied. Your account is not allowed to sign in.",
  Verification:
    "That sign-in link is invalid or has expired. Request a new magic link below.",
  Configuration:
    "Sign-in is temporarily misconfigured on our side. Please try again later.",
  Default: "Something went wrong while signing you in. Please try again.",
};

function SignInForm() {
  const searchParams = useSearchParams();
  const rawCallback = searchParams.get("callbackUrl") || "/dashboard";

  const authErrorCode = searchParams.get("error");
  const authError = authErrorCode
    ? (AUTH_ERROR_MESSAGES[authErrorCode] ?? AUTH_ERROR_MESSAGES.Default)
    : null;

  const isDesktopParam = searchParams.get("desktop") === "1";
  const isDesktopShell =
    typeof window !== "undefined" &&
    typeof (window as any).__TAURI__?.core?.invoke === "function";

  const defaultCallback =
    typeof window !== "undefined"
      ? `${window.location.origin}/dashboard`
      : "/dashboard";

  const callbackUrl =
    isDesktopParam && rawCallback === "/dashboard"
      ? defaultCallback
      : rawCallback;

  const [email, setEmail] = useState("");
  const [magicState, setMagicState] = useState<MagicState>("idle");
  const [magicError, setMagicError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeState, setCodeState] = useState<CodeState>("idle");
  const [codeError, setCodeError] = useState<string | null>(null);

  const resolveCodeMutation = trpc.desktop.resolveCode.useMutation();

  const handleProviderSignIn = async (providerId: string) => {
    // In the desktop shell, open OAuth flows in the system browser instead of the
    // embedded webview, so the user gets a full browser login experience.
    if (isDesktopShell && isDesktopParam) {
      try {
        const result = await signIn(providerId, {
          callbackUrl,
          redirect: false,
        });
        const url = (result as any)?.url as string | undefined;
        if (url) {
          const anyWin = window as any;
          await anyWin.__TAURI__.shell.open(url);
          return;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("desktop OAuth sign-in failed", err);
      }
    }

    void signIn(providerId, { callbackUrl });
  };

  const handleMagicLinkSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!email) return;

    setMagicState("sending");
    setMagicError(null);
    try {
      const result = await signIn("email", {
        email,
        callbackUrl,
        redirect: false,
      });

      if (result?.error) {
        setMagicState("error");
        setMagicError("Failed to send code. Please try again.");
        return;
      }

      setMagicState("sent");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("magic link sign-in failed", err);
      setMagicState("error");
      setMagicError("Something went wrong. Please try again.");
    }
  };

  const handleCodeSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!email || !code) return;

    setCodeState("verifying");
    setCodeError(null);
    try {
      const result = await resolveCodeMutation.mutateAsync({ email, code });

      if (!result.ok || !result.url) {
        setCodeState("error");
        setCodeError(
          "Invalid or expired code. Request a new one from the desktop app.",
        );
        return;
      }

      // Complete the NextAuth email callback inside this browser context.
      await fetch(result.url);
      setCodeState("success");
      // For desktop flows, send the user to the desktop shell which should now
      // have a valid session.
      window.location.href = "/dashboard";
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("desktop code sign-in failed", err);
      setCodeState("error");
      setCodeError("Something went wrong. Please try again.");
    }
  };

  // Desktop-specific sign-in flow - code only
  if (isDesktopParam) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
        <div className="w-full max-w-md">
          {/* Logo and Title */}
          <div className="mb-8 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600">
              <Shield className="h-8 w-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-100">
              vpnVPN Desktop
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              Sign in with a one-time code sent to your email
            </p>
          </div>

          {/* Sign In Card */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-slate-900/40">
            {authError && (
              <div className="mb-4 rounded-lg bg-red-500/10 p-3">
                <p className="text-center text-sm text-red-400">{authError}</p>
              </div>
            )}
            {/* Step 1: Email */}
            <form onSubmit={handleMagicLinkSubmit} className="space-y-4">
              <div>
                <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200">
                  <Mail className="h-4 w-4 text-slate-400" />
                  Email Address
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-slate-50 shadow-sm placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <button
                type="submit"
                disabled={magicState === "sending" || !email}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-3 text-sm font-semibold text-white shadow-lg transition-all hover:from-emerald-400 hover:to-teal-400 disabled:from-slate-600 disabled:to-slate-600 disabled:text-slate-400"
              >
                {magicState === "sending" ? (
                  "Sending code..."
                ) : (
                  <>
                    Send verification code
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </button>

              {magicState === "sent" && (
                <div className="rounded-lg bg-emerald-500/10 p-3">
                  <p className="text-center text-sm text-emerald-400">
                    Code sent! Check your inbox and enter the 6-digit code
                    below.
                  </p>
                </div>
              )}

              {magicState === "error" && magicError && (
                <div className="rounded-lg bg-red-500/10 p-3">
                  <p className="text-center text-sm text-red-400">
                    {magicError}
                  </p>
                </div>
              )}
            </form>

            {/* Divider */}
            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-slate-800" />
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Enter your code
              </span>
              <div className="h-px flex-1 bg-slate-800" />
            </div>

            {/* Step 2: Code Entry */}
            <form onSubmit={handleCodeSubmit} className="space-y-4">
              <div>
                <label className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200">
                  <Key className="h-4 w-4 text-slate-400" />
                  6-Digit Code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] text-slate-50 shadow-sm placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>

              <button
                type="submit"
                disabled={codeState === "verifying" || code.length !== 6}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-100 transition-colors hover:bg-slate-700 disabled:opacity-50"
              >
                {codeState === "verifying" ? (
                  "Verifying..."
                ) : codeState === "success" ? (
                  <>
                    <span className="text-emerald-400">Signed in!</span>
                  </>
                ) : (
                  "Sign in with code"
                )}
              </button>

              {codeState === "error" && codeError && (
                <div className="rounded-lg bg-red-500/10 p-3">
                  <p className="text-center text-sm text-red-400">
                    {codeError}
                  </p>
                </div>
              )}
            </form>
          </div>

          {/* Footer */}
          <div className="mt-6 text-center">
            <p className="text-xs text-slate-500">
              By signing in, you agree to vpnVPN&apos;s{" "}
              <Link
                href="/terms"
                className="text-emerald-400 hover:text-emerald-300"
              >
                Terms of Service
              </Link>
              <br />
              and acknowledge our{" "}
              <Link
                href="/privacy"
                className="text-emerald-400 hover:text-emerald-300"
              >
                Privacy Policy
              </Link>
              .
            </p>
          </div>
        </div>
      </main>
    );
  }

  // Standard web sign-in flow
  return (
    <main className="flex min-h-[calc(100vh-65px)] items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-lg shadow-slate-900/40">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
          Sign in
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Secure access to your vpnVPN account. Sign in with your email using a
          one-time magic link, or continue with your preferred provider.
        </p>

        {authError && (
          <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2">
            <p className="text-sm text-red-400">{authError}</p>
          </div>
        )}

        <form onSubmit={handleMagicLinkSubmit} className="mt-6 space-y-3">
          <label className="block text-sm font-medium text-slate-200">
            Email magic link
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-50 shadow-sm placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </label>
          <button
            type="submit"
            disabled={magicState === "sending"}
            className="flex w-full items-center justify-center rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
          >
            {magicState === "sending"
              ? "Sending magic link..."
              : "Send magic link"}
          </button>
          {magicState === "sent" && (
            <p className="text-xs text-emerald-400">
              Magic link sent. Check your inbox to complete sign-in.
            </p>
          )}
          {magicState === "error" && magicError && (
            <p className="text-xs text-red-400">{magicError}</p>
          )}
        </form>

        <div className="mt-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-slate-800" />
          <span className="text-xs uppercase tracking-wide text-slate-500">
            Or continue with
          </span>
          <div className="h-px flex-1 bg-slate-800" />
        </div>

        <div className="mt-4 space-y-3">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => handleProviderSignIn(p.id)}
              className="flex w-full items-center justify-center rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-800"
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="mt-6 border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-500">
            By continuing you agree to vpnVPN&apos;s{" "}
            <Link
              href="/terms"
              className="text-emerald-400 hover:text-emerald-300"
            >
              Terms of Service
            </Link>{" "}
            and acknowledge our{" "}
            <Link
              href="/privacy"
              className="text-emerald-400 hover:text-emerald-300"
            >
              Privacy Policy
            </Link>
            .
          </p>
        </div>
      </div>
    </main>
  );
}

export default function SignInPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[calc(100vh-65px)] items-center justify-center bg-slate-950">
          <div className="text-slate-400">Loading...</div>
        </div>
      }
    >
      <SignInForm />
    </Suspense>
  );
}

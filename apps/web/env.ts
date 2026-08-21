type WebEnv = {
  CONTROL_PLANE_API_URL: string;
  CONTROL_PLANE_API_KEY: string;
  DESKTOP_BUCKET_URL: string;
  ENVIRONMENT: string;
  NEXTAUTH_URL: string;
  NEXTAUTH_SECRET: string;
  EMAIL_SERVER: string;
  EMAIL_FROM: string;
  RESEND_API_KEY: string;
  GITHUB_ID: string;
  GITHUB_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID_BASIC: string;
  STRIPE_PRICE_ID_PRO: string;
  STRIPE_PRICE_ID_ENTERPRISE: string;
  // Optional yearly price IDs. When unset, yearly billing is disabled and the
  // app behaves exactly as a monthly-only deployment.
  STRIPE_PRICE_BASIC_YEARLY?: string;
  STRIPE_PRICE_PRO_YEARLY?: string;
  STRIPE_PRICE_ENTERPRISE_YEARLY?: string;
  // Optional Redis URL for distributed rate limiting. When unset, rate limits
  // are tracked in-memory per instance (fine for single-instance deployments).
  REDIS_URL?: string;
};

// Optional keys are never validated/required; reading an unset one returns "".
const OPTIONAL_KEYS: (keyof WebEnv)[] = [
  "STRIPE_PRICE_BASIC_YEARLY",
  "STRIPE_PRICE_PRO_YEARLY",
  "STRIPE_PRICE_ENTERPRISE_YEARLY",
  "REDIS_URL",
];

const REQUIRED_KEYS: (keyof WebEnv)[] = [
  "CONTROL_PLANE_API_URL",
  "CONTROL_PLANE_API_KEY",
  "DESKTOP_BUCKET_URL",
  "ENVIRONMENT",
  "NEXTAUTH_URL",
  "NEXTAUTH_SECRET",
  "EMAIL_FROM",
  "RESEND_API_KEY",
  "EMAIL_SERVER",
  "GITHUB_ID",
  "GITHUB_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID_BASIC",
  "STRIPE_PRICE_ID_PRO",
  "STRIPE_PRICE_ID_ENTERPRISE",
];

// During `next build`, route modules are evaluated to collect page metadata
// but no real requests are served.  We must not throw at build time because
// the env vars are only available at runtime (injected by Docker / Railway).
//
// Detection: Next.js sets `process.env.NEXT_PHASE` during its lifecycle.
// During the build the phase is "phase-production-build".  We also fall back
// to the `NEXT_PHASE` env var which bun/next set in the build script.
function shouldSkipValidation(): boolean {
  try {
    // Next.js build phase — env vars won't be present
    const phase = process.env.NEXT_PHASE ?? "";
    if (phase.includes("build")) return true;
    // Test environment — env vars may be partially set
    if (process.env.VITEST || process.env.JEST_WORKER_ID || process.env.NODE_ENV === "test") return true;
  } catch {
    // process may not be defined in edge runtime — treat as build
    return true;
  }
  return false;
}

let _validated = false;

function getEnvValue(key: keyof WebEnv): string {
  const val = process.env[key] ?? "";

  // Skip validation during build — values won't be present
  if (shouldSkipValidation()) return val;

  // On first runtime access, validate all keys once
  if (!_validated) {
    _validated = true;
    const missing = REQUIRED_KEYS.filter(
      (k) => !process.env[k] || !process.env[k]!.trim(),
    );
    if (missing.length) {
      // eslint-disable-next-line no-console
      console.error(
        "[env] Missing required environment variables:",
        missing,
      );
      throw new Error(
        `Missing required env vars (${missing.length}): ${missing.join(", ")}`,
      );
    }
  }

  return val.trim();
}

// Lazy proxy: each property read goes through getEnvValue so we never throw
// at import / module-evaluation time.
export const WEB_ENV: WebEnv = new Proxy({} as WebEnv, {
  get(_target, prop: string) {
    if (REQUIRED_KEYS.includes(prop as keyof WebEnv)) {
      return getEnvValue(prop as keyof WebEnv);
    }
    if (OPTIONAL_KEYS.includes(prop as keyof WebEnv)) {
      return (process.env[prop] ?? "").trim();
    }
    return undefined;
  },
});

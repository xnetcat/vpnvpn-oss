const DEV_DEFAULTS: Record<string, string> = {
  VITE_API_BASE_URL: "http://localhost:3000",
  VITE_APP_CHANNEL: "devel",
};

function loadEnv() {
  const required = ["VITE_API_BASE_URL", "VITE_APP_CHANNEL"];
  const isDev = (import.meta.env as any)?.DEV;

  const missing: string[] = [];
  const values: Record<string, string> = {};

  for (const key of required) {
    const val = (import.meta.env as any)?.[key];
    if (typeof val !== "string" || !val.trim()) {
      if (isDev && DEV_DEFAULTS[key]) {
        values[key] = DEV_DEFAULTS[key];
      } else {
        missing.push(key);
      }
    } else {
      values[key] = val.trim();
    }
  }

  if (missing.length) {
    console.error(
      "[desktop env] Missing required environment variables:",
      missing,
    );
    throw new Error(
      `Missing required desktop env vars (${missing.length}): ${missing.join(", ")}`,
    );
  }

  return {
    API_BASE_URL: values.VITE_API_BASE_URL,
    APP_CHANNEL: values.VITE_APP_CHANNEL,
  };
}

export const DESKTOP_ENV = loadEnv();

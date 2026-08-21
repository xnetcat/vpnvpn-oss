import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "@vpnvpn/web/lib/trpc/routers";
import { API_BASE_URL } from "./config";
import { getStoredSessionToken } from "./auth";

export const trpc = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: `${API_BASE_URL.replace(/\/$/, "")}/api/trpc`,
      transformer: superjson,
      headers() {
        const token = getStoredSessionToken();
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
      fetch(url, options) {
        return fetch(url, { ...options, credentials: "include" });
      },
    }),
  ],
});

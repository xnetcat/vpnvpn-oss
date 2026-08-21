import { router, paidProcedure } from "../init";
import { TRPCError } from "@trpc/server";
import { WEB_ENV } from "@/env";

const base = WEB_ENV.CONTROL_PLANE_API_URL;
const apiKey = WEB_ENV.CONTROL_PLANE_API_KEY;

export const serversRouter = router({
  list: paidProcedure.query(async () => {
    if (!base || !apiKey) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Control plane not configured",
      });
    }

    const url = `${base.replace(/\/$/, "")}/servers`;

    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    });

    if (!res.ok) {
      console.error("[servers] GET /servers failed", {
        status: res.status,
      });
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch servers",
      });
    }

    const data = await res.json();

    // Transform control plane data to match expected format
    const servers = (data || []).map((item: any) => ({
      id: item.id || "unknown",
      region: item.region || item.metadata?.region || "unknown",
      country: item.country || item.metadata?.country,
      status: item.status || "unknown",
      sessions: item.metrics?.sessions || 0,
      publicKey: item.publicKey || null,
      wgEndpoint: item.wgEndpoint || item.metadata?.wgEndpoint || null,
      wgPort: item.wgPort || item.metadata?.wgPort || null,
      ovpnEndpoint: item.ovpnEndpoint || item.metadata?.ovpnEndpoint || null,
      ovpnPort: item.ovpnPort || item.metadata?.ovpnPort || null,
      ovpnCaBundle: item.ovpnCaBundle || item.metadata?.ovpnCaBundle || null,
      ovpnPeerFingerprint:
        item.ovpnPeerFingerprint || item.metadata?.ovpnPeerFingerprint || null,
      ikev2Remote: item.ikev2Remote || item.metadata?.ikev2Remote || null,
      cpu: typeof item.metrics?.cpu === "number" ? item.metrics.cpu : undefined,
      lastSeen: item.lastSeen,
      // Include server connection details
      publicIp: item.publicIp || null,
      metadata: item.metadata || {},
    }));

    return servers;
  }),
});

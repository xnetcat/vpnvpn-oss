import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { prisma } from "@vpnvpn/db";

// Detect Prisma's unique-constraint violation (P2002) without coupling to the
// PrismaClientKnownRequestError class, so it also works under mocked clients.
function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

// SHA-256 hex of a token. Node bearer tokens are stored only as this hash, so a
// database read never discloses a usable token. Must match the SQL backfill in
// the 20260608120000_security_scaling_hardening migration.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Constant-time string comparison for secrets (API keys). Avoids leaking the
// shared secret via early-exit timing on `!==`.
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ----- Peer credential encryption at rest (Task: VpnPeer.password) -----
// The control plane is the ONLY writer/reader of VpnPeer.password (the web app
// only relays it via POST /peers; nodes receive cleartext via GET /server/peers
// for EAP-MSCHAPv2). Encrypt it at rest with AES-256-GCM so a database read
// alone never discloses usable VPN credentials.
//
// Stored format: `enc:v1:<iv_b64>:<tag_b64>:<ct_b64>`. Values without the
// prefix are legacy plaintext rows and are returned as-is. When the env key is
// unset we keep storing plaintext (local/e2e stacks) and log a single startup
// warning.

export const PEER_CREDENTIALS_PREFIX = "enc:v1:";

// Resolve the AES-256-GCM key from PEER_CREDENTIALS_KEY (base64, 32 bytes).
// Returns null when unset; throws on a malformed value (fail fast rather than
// silently storing plaintext with a *configured-but-broken* key).
export function loadPeerCredentialsKey(): Buffer | null {
  const raw = process.env.PEER_CREDENTIALS_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "PEER_CREDENTIALS_KEY must be base64 of exactly 32 bytes (openssl rand -base64 32)"
    );
  }
  return key;
}

/** Encrypt a peer password for storage. Plaintext passthrough when no key. */
export function encryptPeerPassword(plain: string): string {
  const key = loadPeerCredentialsKey();
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PEER_CREDENTIALS_PREFIX}${iv.toString("base64")}:${tag.toString(
    "base64"
  )}:${ct.toString("base64")}`;
}

/**
 * Decrypt a stored peer password. Legacy values without the `enc:v1:` prefix
 * are returned as-is. If an encrypted value cannot be decrypted (missing/wrong
 * key), the stored value is returned unchanged — the node's EAP auth for that
 * peer will fail, but the request keeps serving the rest of the fleet.
 */
export function decryptPeerPassword(stored: string): string {
  if (!stored.startsWith(PEER_CREDENTIALS_PREFIX)) return stored;
  try {
    const key = loadPeerCredentialsKey();
    if (!key) {
      console.warn(
        "[control-plane] encrypted peer password present but PEER_CREDENTIALS_KEY is unset; returning stored value"
      );
      return stored;
    }
    const [ivB64, tagB64, ctB64] = stored
      .slice(PEER_CREDENTIALS_PREFIX.length)
      .split(":");
    if (!ivB64 || !tagB64 || !ctB64) return stored;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (err) {
    console.warn(
      "[control-plane] failed to decrypt peer password; returning stored value:",
      err instanceof Error ? err.message : String(err)
    );
    return stored;
  }
}

// Authenticate a VPN node from its `Authorization: Bearer <token>` header.
// Returns the matching active token record, or null when the header is missing,
// malformed, or the token is unknown/revoked. The raw token is looked up by its
// hash, never stored or compared in plaintext.
async function authenticateNodeToken(
  authHeader: string | undefined
): Promise<{ id: string } | null> {
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const record = await prisma.vpnToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!record || !record.active) return null;

  // Best-effort usage accounting. The token row is a write hot-spot at fleet
  // scale (every node heartbeats against a shared token), so never await it and
  // never let a write error fail authentication.
  void prisma.vpnToken
    .update({
      where: { id: record.id },
      data: { usageCount: { increment: 1 } },
    })
    .catch(() => {});

  return { id: record.id };
}

function requireApiKey(headers: Record<string, unknown>) {
  const apiKey = process.env.CONTROL_PLANE_API_KEY;
  if (!apiKey) {
    throw new Error("CONTROL_PLANE_API_KEY not configured");
  }
  const headerKey =
    ((headers["x-api-key"] as string) ??
      (headers["X-API-Key"] as string) ??
      "") as string;
  if (!safeEqual(headerKey, apiKey)) {
    const err: Error & { statusCode?: number } = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

// Rate-limit store selection. Defaults to the in-memory store, which is correct
// only for a single instance — railway.toml pins numReplicas=1 for this reason.
// To scale horizontally, set RATE_LIMIT_REDIS_URL and install `ioredis`; the
// limiter then shares counters across replicas. The dynamic import uses a
// variable specifier so `ioredis` stays an optional (uninstalled) dependency.
async function buildRateLimitOptions<T extends Record<string, unknown>>(
  base: T
): Promise<T & { redis?: unknown }> {
  const url = process.env.RATE_LIMIT_REDIS_URL;
  if (!url) return base;
  try {
    const moduleName = "ioredis";
    const mod: { default: new (url: string) => unknown } = await import(
      moduleName
    );
    const Redis = mod.default;
    return { ...base, redis: new Redis(url) };
  } catch (err) {
    console.warn(
      "[control-plane] RATE_LIMIT_REDIS_URL is set but ioredis could not be loaded; falling back to in-memory rate limiting (NOT safe across replicas):",
      err instanceof Error ? err.message : String(err)
    );
    return base;
  }
}

let cachedServer: FastifyInstance | null = null;

// One-shot guard so the plaintext-peer-credentials warning logs once per
// process, not once per buildServer() call.
let warnedPlaintextPeerCredentials = false;

const addPeerSchema = z.object({
  publicKey: z.string(),
  userId: z.string(),
  allowedIps: z.array(z.string()),
  serverId: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});

const revokeForUserSchema = z.object({
  userId: z.string(),
});

// Per-peer cumulative transfer counters (since daemon start) pushed alongside
// the server-level metric. WireGuard peers identify by publicKey, OpenVPN/
// IKEv2 sessions by username (the device id). At least one identity field is
// required; samples are stored RAW and consumers compute reset-aware deltas.
const peerUsageSchema = z
  .object({
    publicKey: z.string().min(1).max(256).optional(),
    username: z.string().min(1).max(256).optional(),
    rxBytes: z.number().int().nonnegative(),
    txBytes: z.number().int().nonnegative(),
  })
  .refine((p) => p.publicKey != null || p.username != null, {
    message: "peer sample requires publicKey or username",
  });

const vpnMetricSchema = z.object({
  serverId: z.string(),
  timestamp: z.string().datetime().optional(),
  cpu: z.number().optional(),
  memory: z.number().optional(),
  activePeers: z.number().optional(),
  egressBytes: z.number().nonnegative().optional(),
  ingressBytes: z.number().nonnegative().optional(),
  region: z.string().optional(),
  peers: z.array(peerUsageSchema).max(10000).optional(),
});

async function ensureBootstrapToken() {
  const token = process.env.CONTROL_PLANE_BOOTSTRAP_TOKEN;
  if (!token) {
    console.log("[control-plane] no bootstrap token configured");
    return;
  }

  console.log("[control-plane] ensuring bootstrap token...");
  // Retry to tolerate startup races (database or its migrations not ready yet).
  // Only fail fast after exhausting retries — a genuinely misconfigured
  // bootstrap token must not start the server silently.
  const maxAttempts = Number(process.env.BOOTSTRAP_MAX_ATTEMPTS ?? 15);
  const delayMs = Number(process.env.BOOTSTRAP_RETRY_DELAY_MS ?? 2000);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await prisma.vpnToken.upsert({
        where: { tokenHash: hashToken(token) },
        update: { active: true },
        create: {
          tokenHash: hashToken(token),
          tokenPrefix: token.slice(0, 8),
          label: "local-bootstrap",
          active: true,
        },
      });
      console.log("[control-plane] bootstrap token ensured");
      return;
    } catch (err) {
      lastErr = err;
      console.warn(
        `[control-plane] bootstrap token attempt ${attempt}/${maxAttempts} failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  // eslint-disable-next-line no-console
  console.error("[control-plane] failed to ensure bootstrap token", lastErr);
  throw new Error(
    `Failed to ensure bootstrap token after ${maxAttempts} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

const registerServerSchema = z.object({
  id: z.string(),
  publicKey: z.string(),
  listenPort: z.number(),
  metadata: z.unknown().optional(),
  wgEndpoint: z.string().nullable().optional(),
  wgPort: z.number().nullable().optional(),
  ovpnEndpoint: z.string().nullable().optional(),
  ovpnPort: z.number().nullable().optional(),
  ovpnCaBundle: z.string().nullable().optional(),
  ovpnPeerFingerprint: z.string().nullable().optional(),
  ikev2Remote: z.string().nullable().optional(),
});

export interface BuildServerOptions {
  // When false, skip the module-level singleton cache and return a fresh
  // instance. Useful for tests that need isolated rate-limit state.
  cache?: boolean;
}

export async function buildServer(
  options: BuildServerOptions = {}
): Promise<FastifyInstance> {
  const useCache = options.cache !== false;
  if (useCache && cachedServer) {
    return cachedServer;
  }

  const fastify = Fastify({ logger: true });

  console.log("[control-plane] starting server build...");

  // Validate the peer-credentials key once at startup: throw on a malformed
  // key (fail fast), warn ONCE per process when unset (plaintext storage —
  // expected for local/e2e stacks).
  if (loadPeerCredentialsKey() === null && !warnedPlaintextPeerCredentials) {
    warnedPlaintextPeerCredentials = true;
    console.warn(
      "[control-plane] PEER_CREDENTIALS_KEY is unset; peer passwords will be stored in PLAINTEXT (generate one with: openssl rand -base64 32)"
    );
  }

  await ensureBootstrapToken();

  await fastify.register(cors, {
    origin: true,
  });

  // Global rate limit. Documented contract (docs/API.md):
  //   reads ~100/min, writes ~20/min, auth/token ~10/min.
  // The global default covers read operations; stricter limits are applied
  // per-route via `config.rateLimit` on write/auth/token endpoints below.
  // `/health` opts out of rate limiting so liveness/readiness probes are never
  // throttled into uselessness.
  const RATE_LIMITS = {
    read: 100,
    write: 20,
    auth: 10,
  } as const;

  await fastify.register(
    rateLimit,
    await buildRateLimitOptions({
      global: true,
      max: RATE_LIMITS.read,
      timeWindow: "1 minute",
    })
  );

  // Enhanced healthcheck with database connectivity verification.
  // Exempt from rate limiting so liveness/readiness probes stay reliable.
  fastify.get("/health", { config: { rateLimit: false } }, async (_req, reply) => {
    const checks: Record<
      string,
      { status: "ok" | "error"; latencyMs?: number; error?: string }
    > = {};

    // Database connectivity check
    const dbStart = Date.now();
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
    } catch (err) {
      checks.database = {
        status: "error",
        latencyMs: Date.now() - dbStart,
        error: err instanceof Error ? err.message : "Unknown database error",
      };
    }

    // Determine overall status
    const hasError = Object.values(checks).some((c) => c.status === "error");
    const overallStatus = hasError ? "unhealthy" : "healthy";

    const response = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      service: "control-plane",
      checks,
    };

    return reply.code(hasError ? 503 : 200).send(response);
  });

  // ----- Metrics ingestion -----
  fastify.post(
    "/metrics/vpn",
    { config: { rateLimit: { max: RATE_LIMITS.write, timeWindow: "1 minute" } } },
    async (req, reply) => {
    try {
      // Metrics ingestion is now authenticated with the node's bearer token
      // (same token used for /server/register). Previously open, which let
      // anyone spoof/poison a server's metrics and write unbounded rows.
      const node = await authenticateNodeToken(
        req.headers.authorization as string | undefined
      );
      if (!node) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const metric = vpnMetricSchema.parse(req.body);
      const timestamp = metric.timestamp
        ? new Date(metric.timestamp)
        : new Date();

      await prisma.vpnMetric.create({
        data: {
          serverId: metric.serverId,
          timestamp,
          cpu: metric.cpu,
          memory: metric.memory,
          activePeers: metric.activePeers,
          egressBytes: metric.egressBytes,
          ingressBytes: metric.ingressBytes,
          region: metric.region,
        },
      });

      // Per-peer cumulative samples (optional). Stored raw; deltas are computed
      // by consumers (reset-aware: current < previous => delta = current).
      if (metric.peers && metric.peers.length > 0) {
        await prisma.peerMetric.createMany({
          data: metric.peers.map((p) => ({
            serverId: metric.serverId,
            timestamp,
            publicKey: p.publicKey ?? null,
            username: p.username ?? null,
            rxBytes: BigInt(p.rxBytes),
            txBytes: BigInt(p.txBytes),
          })),
        });
      }

      req.log.info(
        { serverId: metric.serverId, peerSamples: metric.peers?.length ?? 0 },
        "vpn metric ingested"
      );
      return reply.code(202).send({ status: "accepted" });
    } catch (err: unknown) {
      const error = err as Error;
      req.log.error({ err }, "vpn metric ingestion failed");
      return reply.code(400).send({ error: error.message ?? "Bad Request" });
    }
    }
  );

  // Prometheus HTTP service discovery: returns the currently-online nodes as
  // scrape targets so Prometheus auto-discovers the fleet instead of using a
  // static list. See https://prometheus.io/docs/prometheus/latest/http_sd/.
  // The node's metrics port is fixed per deployment (METRICS_TARGET_PORT,
  // default 8080 — the node ADMIN_PORT). Authn accepts the API key via
  // X-API-Key or `Authorization: Bearer <key>` (Prometheus http_sd uses the
  // latter).
  fastify.get("/metrics/targets", async (req, reply) => {
    try {
      const apiKey = process.env.CONTROL_PLANE_API_KEY;
      if (!apiKey) {
        return reply
          .code(500)
          .send({ error: "CONTROL_PLANE_API_KEY not configured" });
      }
      const headers = req.headers as Record<string, unknown>;
      const presented =
        (headers["x-api-key"] as string) ??
        ((headers["authorization"] as string) ?? "").replace(/^Bearer\s+/i, "");
      if (!safeEqual(presented, apiKey)) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const port = Number(process.env.METRICS_TARGET_PORT ?? 8080);
      const onlineWindowMs = 5 * 60 * 1000;
      const cutoff = new Date(Date.now() - onlineWindowMs);

      // Filter to currently-online nodes in SQL (uses the VpnServer.lastSeen
      // index) instead of loading the whole fleet and filtering in JS.
      const servers = await prisma.vpnServer.findMany({
        where: { lastSeen: { gte: cutoff }, publicIp: { not: null } },
      });
      const targets = servers.map((s) => {
        const metadata = (s.metadata as Record<string, unknown>) || {};
        const labels: Record<string, string> = { node: s.id };
        if (metadata.region) labels.region = String(metadata.region);
        if (metadata.country) labels.country = String(metadata.country);
        return { targets: [`${s.publicIp}:${port}`], labels };
      });

      return reply.code(200).send(targets);
    } catch (err: unknown) {
      // Keep error details server-side only.
      req.log.error({ err }, "metrics targets discovery failed");
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  // ----- Server registration & listing -----
  fastify.post(
    "/server/register",
    { config: { rateLimit: { max: RATE_LIMITS.auth, timeWindow: "1 minute" } } },
    async (req, reply) => {
    try {
      const node = await authenticateNodeToken(
        req.headers.authorization as string | undefined
      );
      if (!node) {
        return reply.code(401).send({ error: "Invalid or revoked token" });
      }

      const body = registerServerSchema.parse(req.body);

      const now = new Date();
      const incomingMeta = (body.metadata as Record<string, unknown>) || {};

      // Merge over any existing metadata rather than replacing it. Heartbeats
      // re-use this endpoint but send only a subset (region/country/publicIp),
      // so a blind replace would wipe fields that arrive only on full
      // registration — notably ikev2CaBundle and tlsCryptKey, which clients need
      // to build working IKEv2 / OpenVPN configs.
      const existing = await prisma.vpnServer.findUnique({
        where: { id: body.id },
        select: { metadata: true },
      });
      const existingMeta = (existing?.metadata as Record<string, unknown>) || {};
      const metadata: Record<string, unknown> = {
        ...existingMeta,
        ...incomingMeta,
        listenPort: body.listenPort,
      };

      const publicIp = metadata.publicIp as string | undefined;

      const server = await prisma.vpnServer.upsert({
        where: { id: body.id },
        update: {
          status: "online",
          lastSeen: now,
          publicIp: publicIp || undefined,
          publicKey: body.publicKey,
          metadata: metadata as object,
          wgEndpoint: body.wgEndpoint ?? undefined,
          wgPort: body.wgPort ?? undefined,
          ovpnEndpoint: body.ovpnEndpoint ?? undefined,
          ovpnPort: body.ovpnPort ?? undefined,
          ovpnCaBundle: body.ovpnCaBundle ?? undefined,
          ovpnPeerFingerprint: body.ovpnPeerFingerprint ?? undefined,
          ikev2Remote: body.ikev2Remote ?? undefined,
        },
        create: {
          id: body.id,
          status: "online",
          lastSeen: now,
          publicIp: publicIp || undefined,
          publicKey: body.publicKey,
          metadata: metadata as object,
          wgEndpoint: body.wgEndpoint ?? undefined,
          wgPort: body.wgPort ?? undefined,
          ovpnEndpoint: body.ovpnEndpoint ?? undefined,
          ovpnPort: body.ovpnPort ?? undefined,
          ovpnCaBundle: body.ovpnCaBundle ?? undefined,
          ovpnPeerFingerprint: body.ovpnPeerFingerprint ?? undefined,
          ikev2Remote: body.ikev2Remote ?? undefined,
        },
      });

      req.log.info({ id: server.id }, "server_registered");
      return reply.code(200).send({ status: "registered" });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      req.log.error({ err }, "registerServer failed");
      const status = error.statusCode ?? 400;
      return reply.code(status).send({ error: error.message ?? "Bad Request" });
    }
    }
  );

  // Fetch peers for vpn-server nodes.
  // In a multi-node setup, we return peers for the requesting server plus any
  // unpinned peers (serverId null). The server identity is provided via the
  // `id` query param and authenticated by the bearer token.
  fastify.get("/server/peers", async (req, reply) => {
    try {
      const node = await authenticateNodeToken(
        req.headers.authorization as string | undefined
      );
      if (!node) {
        return reply.code(401).send({ error: "Invalid or revoked token" });
      }

      const query = (req.query || {}) as { id?: string };
      const serverId = query.id;

      const peers = await prisma.vpnPeer.findMany({
        where: serverId
          ? {
              active: true,
              OR: [{ serverId }, { serverId: null }],
            }
          : { active: true },
        orderBy: { createdAt: "asc" },
      });

      // Shape into the snake_case PeerSpec expected by vpn-server.
      const payload = {
        peers: peers.map((p) => ({
          public_key: p.publicKey,
          preshared_key: null as string | null,
          allowed_ips: p.allowedIps,
          endpoint: null as string | null,
          username: p.username,
          // Nodes need the cleartext password for EAP-MSCHAPv2; decrypt
          // at-rest-encrypted values (legacy plaintext passes through).
          password: p.password == null ? p.password : decryptPeerPassword(p.password),
        })),
      };

      req.log.info(
        { count: payload.peers.length, serverId: serverId ?? null },
        "server_peers_listed"
      );
      return reply.code(200).send(payload);
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      req.log.error({ err }, "listServerPeers failed");
      const status = error.statusCode ?? 500;
      return reply
        .code(status)
        .send({ error: error.message ?? "Internal Error" });
    }
  });

  fastify.get("/servers", async (req, reply) => {
    try {
      requireApiKey(req.headers as Record<string, unknown>);
      const now = Date.now();

      const servers = await prisma.vpnServer.findMany({
        include: {
          metrics: {
            orderBy: { timestamp: "desc" },
            take: 1,
          },
        },
      });

      const mapped = servers.map((s) => {
        const lastSeen = s.lastSeen?.toISOString();
        let status = s.status || "unknown";
        if (lastSeen) {
          const lastMs = Date.parse(lastSeen);
          if (Number.isFinite(lastMs)) {
            const diffMs = now - lastMs;
            if (diffMs > 5 * 60 * 1000) {
              status = "offline";
            } else if (!status || status === "unknown") {
              status = "online";
            }
          }
        }

        const metadata = (s.metadata as Record<string, unknown>) || {};
        const metric = (s.metrics && s.metrics[0]) || null;

        return {
          id: s.id,
          publicIp: s.publicIp,
          publicKey: s.publicKey,
          metadata,
          wgEndpoint: s.wgEndpoint,
          wgPort: s.wgPort,
          ovpnEndpoint: s.ovpnEndpoint,
          ovpnPort: s.ovpnPort,
          ovpnCaBundle: s.ovpnCaBundle,
          ovpnPeerFingerprint: s.ovpnPeerFingerprint,
          ikev2Remote: s.ikev2Remote,
          metrics: metric
            ? {
                sessions: metric.activePeers ?? 0,
                cpu: metric.cpu,
                memory: metric.memory,
              }
            : {},
          status,
          lastSeen,
          country: (metadata.country as string) ?? metric?.region,
          region: (metadata.region as string) ?? metric?.region,
        };
      });

      req.log.info({ count: mapped.length }, "list_servers");
      return reply.code(200).send(mapped);
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      req.log.error({ err }, "listServers failed");
      const status = error.statusCode ?? 500;
      return reply
        .code(status)
        .send({ error: error.message ?? "Internal Error" });
    }
  });

  fastify.delete(
    "/servers/:id",
    { config: { rateLimit: { max: RATE_LIMITS.write, timeWindow: "1 minute" } } },
    async (req, reply) => {
    try {
      requireApiKey(req.headers as Record<string, unknown>);
      const { id } = req.params as { id?: string };

      if (!id) {
        return reply.code(400).send({ error: "Server id required" });
      }

      const server = await prisma.vpnServer.findUnique({ where: { id } });
      if (!server) {
        return reply.code(404).send({ error: "Server not found" });
      }

      // The VpnPeer.serverId foreign key uses ON DELETE SET NULL, so deleting
      // the server automatically detaches its peers (sets serverId to null).
      // No manual null-out needed.
      await prisma.vpnServer.delete({ where: { id } });

      req.log.info({ id }, "delete_server");
      return reply.code(204).send();
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      req.log.error({ err }, "deleteServer failed");
      const status = error.statusCode ?? 500;
      return reply
        .code(status)
        .send({ error: error.message ?? "Internal Error" });
    }
    }
  );

  // ----- Peer endpoints backed by Postgres via Prisma -----
  fastify.post(
    "/peers",
    { config: { rateLimit: { max: RATE_LIMITS.write, timeWindow: "1 minute" } } },
    async (req, reply) => {
    try {
      requireApiKey(req.headers as Record<string, unknown>);
      const body = addPeerSchema.parse(req.body);

      // Create the peer. We intentionally do NOT revoke the user's other peers
      // here: paid tiers allow multiple simultaneous devices, each its own
      // active peer with a distinct tunnel IP. Per-device revocation happens via
      // DELETE /peers/:publicKey; a full revoke (e.g. subscription lapse) via
      // POST /peers/revoke-for-user.
      await prisma.vpnPeer.create({
        data: {
          publicKey: body.publicKey,
          userId: body.userId,
          allowedIps: body.allowedIps,
          serverId: body.serverId,
          country: body.country,
          region: body.region,
          username: body.username,
          // Encrypt the EAP password at rest (plaintext when no key is set).
          password:
            body.password == null
              ? body.password
              : encryptPeerPassword(body.password),
          active: true,
        },
      });

      req.log.info(
        { userId: body.userId, serverId: body.serverId },
        "addPeer persisted"
      );

      return reply.code(204).send();
    } catch (err: unknown) {
      // A duplicate publicKey (the @id) or username (@unique) raises Prisma
      // P2002. Surface that as 409 Conflict rather than a generic 400.
      if (isUniqueConstraintError(err)) {
        req.log.warn({ err }, "addPeer unique constraint violation");
        return reply
          .code(409)
          .send({ error: "A peer with this publicKey already exists" });
      }
      const error = err as Error & { statusCode?: number };
      req.log.error({ err }, "addPeer failed");
      const status = error.statusCode ?? 400;
      return reply.code(status).send({ error: error.message ?? "Bad Request" });
    }
    }
  );

  fastify.post(
    "/peers/revoke-for-user",
    { config: { rateLimit: { max: RATE_LIMITS.write, timeWindow: "1 minute" } } },
    async (req, reply) => {
    try {
      requireApiKey(req.headers as Record<string, unknown>);
      const body = revokeForUserSchema.parse(req.body);

      await prisma.vpnPeer.updateMany({
        where: { userId: body.userId, active: true },
        data: { active: false, revokedAt: new Date() },
      });

      req.log.info({ userId: body.userId }, "revokePeersForUser persisted");
      return reply.code(204).send();
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      req.log.error({ err }, "revokePeersForUser failed");
      const status = error.statusCode ?? 400;
      return reply.code(status).send({ error: error.message ?? "Bad Request" });
    }
    }
  );

  fastify.delete(
    "/peers/:publicKey",
    { config: { rateLimit: { max: RATE_LIMITS.write, timeWindow: "1 minute" } } },
    async (req, reply) => {
    try {
      requireApiKey(req.headers as Record<string, unknown>);
      const { publicKey } = req.params as { publicKey: string };

      await prisma.vpnPeer.update({
        where: { publicKey },
        data: { active: false, revokedAt: new Date() },
      });

      req.log.info({ publicKey }, "revokePeerByPublicKey persisted");
      return reply.code(204).send();
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      req.log.error({ err }, "revokePeerByPublicKey failed");
      const status = error.statusCode ?? 400;
      return reply.code(status).send({ error: error.message ?? "Bad Request" });
    }
    }
  );

  // ----- Admin: Token Management -----
  const classifyToken = (label: string | null | undefined) => {
    const normalized = (label || "").toLowerCase();
    if (normalized.includes("bootstrap") || normalized.startsWith("system")) {
      return "system";
    }
    return "user";
  };

  fastify.get("/tokens", async (req, reply) => {
    try {
      requireApiKey(req.headers as Record<string, unknown>);

      const tokens = await prisma.vpnToken.findMany({
        orderBy: { createdAt: "desc" },
      });

      // Never expose the token hash; surface only the display prefix + metadata.
      return reply.code(200).send(
        tokens.map((token) => ({
          id: token.id,
          tokenPrefix: token.tokenPrefix,
          label: token.label,
          usageCount: token.usageCount,
          active: token.active,
          createdAt: token.createdAt,
          scope: classifyToken(token.label),
        }))
      );
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      req.log.error({ err }, "listTokens failed");
      const status = error.statusCode ?? 400;
      return reply.code(status).send({ error: error.message ?? "Bad Request" });
    }
  });

  const createTokenHandler = async (req: any, reply: any) => {
    try {
      requireApiKey(req.headers as Record<string, unknown>);
      const body = z.object({ label: z.string() }).parse(req.body);

      // Generate a secure random token. Only its hash is stored; the raw value
      // is returned to the caller exactly once here and is unrecoverable after.
      const rawToken = randomBytes(32).toString("hex");

      const vpnToken = await prisma.vpnToken.create({
        data: {
          tokenHash: hashToken(rawToken),
          tokenPrefix: rawToken.slice(0, 8),
          label: body.label,
          active: true,
        },
      });

      req.log.info({ label: body.label }, "admin_token_created");
      return reply.code(201).send({
        id: vpnToken.id,
        token: rawToken, // shown once; not recoverable later
        tokenPrefix: vpnToken.tokenPrefix,
        label: vpnToken.label,
        active: vpnToken.active,
        usageCount: vpnToken.usageCount,
        createdAt: vpnToken.createdAt,
        scope: classifyToken(vpnToken.label),
      });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      req.log.error({ err }, "createToken failed");
      const status = error.statusCode ?? 400;
      return reply.code(status).send({ error: error.message ?? "Bad Request" });
    }
  };

  const tokenRouteOptions = {
    config: { rateLimit: { max: RATE_LIMITS.auth, timeWindow: "1 minute" } },
  };

  fastify.post("/tokens", tokenRouteOptions, createTokenHandler);
  fastify.post("/admin/tokens", tokenRouteOptions, createTokenHandler);

  const revokeTokenHandler = async (req: any, reply: any) => {
    try {
      requireApiKey(req.headers as Record<string, unknown>);
      const { id } = req.params as { id: string };

      const existing = await prisma.vpnToken.findUnique({
        where: { id },
      });

      if (!existing) {
        return reply.code(404).send({ error: "Token not found" });
      }

      const revoked = await prisma.vpnToken.update({
        where: { id },
        data: { active: false },
      });

      req.log.info({ id }, "admin_token_revoked");
      return reply.code(200).send({
        id: revoked.id,
        tokenPrefix: revoked.tokenPrefix,
        label: revoked.label,
        active: revoked.active,
        usageCount: revoked.usageCount,
        createdAt: revoked.createdAt,
        scope: classifyToken(revoked.label),
      });
    } catch (err: unknown) {
      const error = err as Error & { statusCode?: number };
      req.log.error({ err }, "revokeToken failed");
      const status = error.statusCode ?? 400;
      return reply.code(status).send({ error: error.message ?? "Bad Request" });
    }
  };

  fastify.delete("/tokens/:id", tokenRouteOptions, revokeTokenHandler);
  fastify.delete("/admin/tokens/:id", tokenRouteOptions, revokeTokenHandler);

  if (useCache) {
    cachedServer = fastify;
  }
  return fastify;
}

// ----- Metrics retention -----
// VpnMetric grows ~1 row/node every ingestion tick with no natural bound. Prune
// rows older than the retention window so the table (and the single Postgres)
// don't grow without limit. Prometheus already holds the long-term series.

export const DEFAULT_METRICS_RETENTION_DAYS = 30;

export function metricsRetentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Delete metrics older than the cutoff once (server-level VpnMetric AND the
 * per-peer PeerMetric samples, which grow much faster — one row per peer per
 * ingestion tick). Returns the total number of rows deleted.
 */
export async function pruneOldMetrics(
  retentionDays = DEFAULT_METRICS_RETENTION_DAYS,
  now: Date = new Date()
): Promise<number> {
  const cutoff = metricsRetentionCutoff(now, retentionDays);
  const [metrics, peerMetrics] = await Promise.all([
    prisma.vpnMetric.deleteMany({ where: { timestamp: { lt: cutoff } } }),
    prisma.peerMetric.deleteMany({ where: { timestamp: { lt: cutoff } } }),
  ]);
  return (metrics?.count ?? 0) + (peerMetrics?.count ?? 0);
}

/**
 * Start a periodic metrics-retention prune. Returns the interval handle so the
 * caller can clear it. Safe to run on a single instance (numReplicas=1).
 */
export function startMetricsRetention(): NodeJS.Timeout {
  const retentionDays = Number(
    process.env.METRICS_RETENTION_DAYS ?? DEFAULT_METRICS_RETENTION_DAYS
  );
  const intervalMs = Number(
    process.env.METRICS_RETENTION_INTERVAL_MS ?? 60 * 60 * 1000 // hourly
  );

  const run = () => {
    pruneOldMetrics(retentionDays)
      .then((count) => {
        if (count > 0) {
          console.log(`[control-plane] pruned ${count} metric rows`);
        }
      })
      .catch((err) => {
        console.warn(
          "[control-plane] metrics retention prune failed:",
          err instanceof Error ? err.message : String(err)
        );
      });
  };

  run(); // prune once on startup
  const handle = setInterval(run, intervalMs);
  // Don't keep the process alive solely for the prune timer.
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

export { prisma };

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockPrisma = vi.hoisted(() => ({
  vpnPeer: {
    updateMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
  vpnToken: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  vpnServer: {
    upsert: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
  vpnMetric: {
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
  peerMetric: {
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  // Array form of $transaction: resolve all passed promises in order.
  $transaction: vi.fn((ops: unknown[]) =>
    Promise.all(ops as Array<Promise<unknown>>)
  ),
  $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
}));

vi.mock("@vpnvpn/db", () => ({
  prisma: mockPrisma,
}));

import {
  buildServer,
  hashToken,
  pruneOldMetrics,
  metricsRetentionCutoff,
  encryptPeerPassword,
  decryptPeerPassword,
  PEER_CREDENTIALS_PREFIX,
} from "./server";
import { prisma } from "@vpnvpn/db";

// Build a fresh (uncached) server so rate-limit state never leaks across tests.
async function freshServer(): Promise<FastifyInstance> {
  return buildServer({ cache: false });
}

const API_KEY = "test-key";
const apiKeyHeader = { "x-api-key": API_KEY };

describe("control-plane service", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.CONTROL_PLANE_API_KEY = API_KEY;
    delete process.env.CONTROL_PLANE_BOOTSTRAP_TOKEN;
    delete process.env.PEER_CREDENTIALS_KEY;

    // Sensible default mock resolutions.
    mockPrisma.vpnPeer.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.vpnPeer.create.mockResolvedValue({});
    mockPrisma.vpnPeer.update.mockResolvedValue({});
    mockPrisma.vpnPeer.findMany.mockResolvedValue([]);
    mockPrisma.vpnServer.findUnique.mockResolvedValue({ id: "server-1" });
    mockPrisma.vpnServer.findMany.mockResolvedValue([]);
    mockPrisma.vpnServer.upsert.mockResolvedValue({ id: "server-1" });
    mockPrisma.vpnServer.delete.mockResolvedValue({});
    mockPrisma.vpnToken.findUnique.mockResolvedValue({
      id: "tok-1",
      active: true,
    });
    mockPrisma.vpnToken.findMany.mockResolvedValue([]);
    mockPrisma.vpnToken.update.mockResolvedValue({});
    mockPrisma.vpnToken.create.mockResolvedValue({});
    mockPrisma.vpnMetric.create.mockResolvedValue({});
    mockPrisma.vpnMetric.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.peerMetric.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.peerMetric.deleteMany.mockResolvedValue({ count: 0 });

    app = await freshServer();
  });

  afterEach(async () => {
    await app.close();
  });

  // ----- /health -----
  describe("GET /health", () => {
    it("returns 200 healthy when the database is reachable", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("healthy");
      expect(body.service).toBe("control-plane");
      expect(body.checks.database.status).toBe("ok");
    });

    it("returns 503 unhealthy when the database query fails", async () => {
      mockPrisma.$queryRaw.mockRejectedValueOnce(new Error("db down"));
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(503);
      expect(res.json().status).toBe("unhealthy");
    });

    it("is not rate limited (many rapid probes all succeed)", async () => {
      for (let i = 0; i < 30; i++) {
        const res = await app.inject({ method: "GET", url: "/health" });
        expect(res.statusCode).toBe(200);
      }
    });
  });

  // ----- POST /metrics/vpn -----
  describe("POST /metrics/vpn", () => {
    const authHeader = { authorization: "Bearer node-token" };

    it("accepts a valid metric with a node token and returns 202", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/metrics/vpn",
        headers: authHeader,
        payload: { serverId: "server-1", cpu: 12.5, activePeers: 3 },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json().status).toBe("accepted");
      expect(prisma.vpnMetric.create).toHaveBeenCalled();
    });

    it("returns 401 without a node bearer token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/metrics/vpn",
        payload: { serverId: "server-1", cpu: 12.5, activePeers: 3 },
      });
      expect(res.statusCode).toBe(401);
      expect(prisma.vpnMetric.create).not.toHaveBeenCalled();
    });

    it("returns 401 with an unknown/revoked token", async () => {
      mockPrisma.vpnToken.findUnique.mockResolvedValueOnce(null);
      const res = await app.inject({
        method: "POST",
        url: "/metrics/vpn",
        headers: { authorization: "Bearer bad" },
        payload: { serverId: "server-1", cpu: 1 },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 for an invalid metric body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/metrics/vpn",
        headers: authHeader,
        payload: { cpu: "not-a-number" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("stores per-peer cumulative samples (raw, as BigInt) when peers are provided", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/metrics/vpn",
        headers: authHeader,
        payload: {
          serverId: "server-1",
          activePeers: 2,
          timestamp: "2026-06-10T12:00:00.000Z",
          peers: [
            { publicKey: "wg-pk-1", rxBytes: 1000, txBytes: 2000 },
            { username: "device-1", rxBytes: 5, txBytes: 7 },
          ],
        },
      });
      expect(res.statusCode).toBe(202);
      expect(prisma.peerMetric.createMany).toHaveBeenCalledWith({
        data: [
          {
            serverId: "server-1",
            timestamp: new Date("2026-06-10T12:00:00.000Z"),
            publicKey: "wg-pk-1",
            username: null,
            rxBytes: 1000n,
            txBytes: 2000n,
          },
          {
            serverId: "server-1",
            timestamp: new Date("2026-06-10T12:00:00.000Z"),
            publicKey: null,
            username: "device-1",
            rxBytes: 5n,
            txBytes: 7n,
          },
        ],
      });
    });

    it("does not touch PeerMetric when the peers array is absent or empty", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/metrics/vpn",
        headers: authHeader,
        payload: { serverId: "server-1", peers: [] },
      });
      expect(res.statusCode).toBe(202);
      expect(prisma.peerMetric.createMany).not.toHaveBeenCalled();
    });

    it("rejects garbage peer samples (400, nothing stored)", async () => {
      const garbage = [
        // negative counter
        [{ publicKey: "pk", rxBytes: -1, txBytes: 0 }],
        // non-numeric counter
        [{ publicKey: "pk", rxBytes: "lots", txBytes: 0 }],
        // missing both identity fields
        [{ rxBytes: 1, txBytes: 2 }],
        // identity too long
        [{ publicKey: "x".repeat(300), rxBytes: 1, txBytes: 2 }],
        // not an array
        "peers-as-string",
      ];
      for (const peers of garbage) {
        const res = await app.inject({
          method: "POST",
          url: "/metrics/vpn",
          headers: authHeader,
          payload: { serverId: "server-1", peers },
        });
        expect(res.statusCode).toBe(400);
      }
      expect(prisma.peerMetric.createMany).not.toHaveBeenCalled();
      expect(prisma.vpnMetric.create).not.toHaveBeenCalled();
    });
  });

  describe("GET /metrics/targets (Prometheus http_sd)", () => {
    it("returns 401 without a valid key", async () => {
      const res = await app.inject({ method: "GET", url: "/metrics/targets" });
      expect(res.statusCode).toBe(401);
    });

    it("returns online nodes as http_sd targets (Bearer auth)", async () => {
      process.env.METRICS_TARGET_PORT = "8080";
      // Online-window + has-publicIp filtering now happens in SQL (uses the
      // VpnServer.lastSeen index), so the DB returns only eligible rows.
      mockPrisma.vpnServer.findMany.mockResolvedValueOnce([
        {
          id: "node-eu",
          publicIp: "1.2.3.4",
          lastSeen: new Date(),
          metadata: { region: "eu", country: "de" },
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/metrics/targets",
        headers: { authorization: `Bearer ${API_KEY}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([
        {
          targets: ["1.2.3.4:8080"],
          labels: { node: "node-eu", region: "eu", country: "de" },
        },
      ]);
      // The query must filter to the online window and non-null publicIp.
      const arg = vi.mocked(prisma.vpnServer.findMany).mock.calls[0][0] as {
        where: { lastSeen: { gte: Date }; publicIp: { not: null } };
      };
      expect(arg.where.publicIp).toEqual({ not: null });
      expect(arg.where.lastSeen.gte).toBeInstanceOf(Date);
    });
  });

  // ----- POST /server/register (bearer auth + upsert) -----
  describe("POST /server/register", () => {
    const validBody = {
      id: "server-1",
      publicKey: "server-pk",
      listenPort: 51820,
      metadata: { region: "us-east-1", publicIp: "1.2.3.4" },
    };

    it("registers a server with a valid bearer token (upsert)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/server/register",
        headers: { authorization: "Bearer node-token" },
        payload: validBody,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("registered");
      expect(prisma.vpnServer.upsert).toHaveBeenCalled();
      // usage counter incremented for the token (by id, best-effort)
      expect(prisma.vpnToken.update).toHaveBeenCalledWith({
        where: { id: "tok-1" },
        data: { usageCount: { increment: 1 } },
      });
    });

    it("merges metadata on re-registration so partial heartbeats keep tlsCryptKey/ikev2CaBundle", async () => {
      // The server row already carries the shared OpenVPN tls-crypt key and the
      // IKEv2 CA, set during a prior full registration.
      mockPrisma.vpnServer.findUnique.mockResolvedValueOnce({
        id: "server-1",
        metadata: { tlsCryptKey: "TLS-CRYPT-KEY", ikev2CaBundle: "CA-PEM" },
      });

      // A heartbeat re-uses /server/register but only re-sends a metadata subset.
      const res = await app.inject({
        method: "POST",
        url: "/server/register",
        headers: { authorization: "Bearer node-token" },
        payload: {
          id: "server-1",
          publicKey: "server-pk",
          listenPort: 51820,
          metadata: { region: "us-east-1", publicIp: "5.6.7.8" },
        },
      });

      expect(res.statusCode).toBe(200);
      const upsertArg = vi.mocked(prisma.vpnServer.upsert).mock.calls[0][0];
      // The secrets survive; the heartbeat fields are applied on top.
      expect(upsertArg.update.metadata).toMatchObject({
        tlsCryptKey: "TLS-CRYPT-KEY",
        ikev2CaBundle: "CA-PEM",
        region: "us-east-1",
        publicIp: "5.6.7.8",
        listenPort: 51820,
      });
    });

    it("returns 401 when the bearer token is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/server/register",
        payload: validBody,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toMatch(/invalid or revoked/i);
    });

    it("returns 401 when the token is unknown/revoked", async () => {
      mockPrisma.vpnToken.findUnique.mockResolvedValueOnce(null);
      const res = await app.inject({
        method: "POST",
        url: "/server/register",
        headers: { authorization: "Bearer bad-token" },
        payload: validBody,
      });
      expect(res.statusCode).toBe(401);
      expect(prisma.vpnServer.upsert).not.toHaveBeenCalled();
    });

    it("returns 401 when the token exists but is inactive", async () => {
      mockPrisma.vpnToken.findUnique.mockResolvedValueOnce({
        token: "node-token",
        active: false,
      });
      const res = await app.inject({
        method: "POST",
        url: "/server/register",
        headers: { authorization: "Bearer node-token" },
        payload: validBody,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 for an invalid body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/server/register",
        headers: { authorization: "Bearer node-token" },
        payload: { id: "x" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ----- GET /server/peers -----
  describe("GET /server/peers", () => {
    it("returns peers shaped as snake_case PeerSpec for a valid token", async () => {
      mockPrisma.vpnPeer.findMany.mockResolvedValueOnce([
        {
          publicKey: "client-pk",
          allowedIps: ["10.8.0.2/32"],
          username: "ovpn-user",
          password: "ovpn-pass",
        },
      ]);
      const res = await app.inject({
        method: "GET",
        url: "/server/peers?id=server-1",
        headers: { authorization: "Bearer node-token" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.peers).toHaveLength(1);
      expect(body.peers[0]).toMatchObject({
        public_key: "client-pk",
        preshared_key: null,
        allowed_ips: ["10.8.0.2/32"],
        endpoint: null,
        username: "ovpn-user",
        password: "ovpn-pass",
      });
      // Filters to the requesting server plus unpinned peers.
      expect(prisma.vpnPeer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            active: true,
            OR: [{ serverId: "server-1" }, { serverId: null }],
          },
        })
      );
    });

    it("returns all active peers when no server id is provided", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/server/peers",
        headers: { authorization: "Bearer node-token" },
      });
      expect(res.statusCode).toBe(200);
      expect(prisma.vpnPeer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { active: true } })
      );
    });

    it("returns 401 without a bearer token", async () => {
      const res = await app.inject({ method: "GET", url: "/server/peers" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 for an invalid token", async () => {
      mockPrisma.vpnToken.findUnique.mockResolvedValueOnce(null);
      const res = await app.inject({
        method: "GET",
        url: "/server/peers",
        headers: { authorization: "Bearer nope" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ----- GET /servers -----
  describe("GET /servers", () => {
    it("lists servers with mapped metrics and status for a valid API key", async () => {
      mockPrisma.vpnServer.findMany.mockResolvedValueOnce([
        {
          id: "server-1",
          publicIp: "1.2.3.4",
          publicKey: "pk",
          metadata: { region: "us-east-1", country: "US" },
          status: "online",
          lastSeen: new Date(),
          metrics: [{ activePeers: 5, cpu: 10, memory: 20, region: "us-east-1" }],
        },
      ]);
      const res = await app.inject({
        method: "GET",
        url: "/servers",
        headers: apiKeyHeader,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe("server-1");
      expect(body[0].metrics.sessions).toBe(5);
      expect(body[0].status).toBe("online");
    });

    it("marks a server offline when lastSeen is stale", async () => {
      const stale = new Date(Date.now() - 10 * 60 * 1000);
      mockPrisma.vpnServer.findMany.mockResolvedValueOnce([
        {
          id: "old",
          status: "online",
          lastSeen: stale,
          metadata: {},
          metrics: [],
        },
      ]);
      const res = await app.inject({
        method: "GET",
        url: "/servers",
        headers: apiKeyHeader,
      });
      expect(res.json()[0].status).toBe("offline");
    });

    it("returns 401 with a wrong API key", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/servers",
        headers: { "x-api-key": "wrong" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 with no API key", async () => {
      const res = await app.inject({ method: "GET", url: "/servers" });
      expect(res.statusCode).toBe(401);
    });
  });

  // ----- DELETE /servers/:id -----
  describe("DELETE /servers/:id", () => {
    it("deletes a server (FK SET NULL detaches peers automatically)", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/servers/server-1",
        headers: apiKeyHeader,
      });
      expect(res.statusCode).toBe(204);
      expect(prisma.vpnServer.delete).toHaveBeenCalledWith({
        where: { id: "server-1" },
      });
      // Manual peer null-out was removed in favour of the DB ON DELETE SET NULL.
      expect(prisma.vpnPeer.updateMany).not.toHaveBeenCalled();
    });

    it("returns 404 when the server does not exist", async () => {
      mockPrisma.vpnServer.findUnique.mockResolvedValueOnce(null);
      const res = await app.inject({
        method: "DELETE",
        url: "/servers/missing",
        headers: apiKeyHeader,
      });
      expect(res.statusCode).toBe(404);
      expect(prisma.vpnServer.delete).not.toHaveBeenCalled();
    });

    it("returns 401 without an API key", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/servers/server-1",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ----- POST /peers -----
  describe("POST /peers", () => {
    const peerBody = {
      publicKey: "client-pk",
      userId: "user-1",
      allowedIps: ["10.8.0.2/32"],
    };

    it("rejects requests without an API key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/peers",
        payload: peerBody,
      });
      expect(res.statusCode).toBe(401);
    });

    it("creates a peer WITHOUT revoking the user's other peers (multi-device)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/peers",
        headers: apiKeyHeader,
        payload: peerBody,
      });
      expect(res.statusCode).toBe(204);
      // Paid tiers allow multiple simultaneous devices: adding a peer must NOT
      // revoke the user's existing peers (that was the single-device bug).
      expect(prisma.vpnPeer.updateMany).not.toHaveBeenCalled();
      expect(prisma.vpnPeer.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            publicKey: "client-pk",
            userId: "user-1",
            active: true,
          }),
        })
      );
    });

    it("returns 409 when the publicKey already exists (Prisma P2002)", async () => {
      mockPrisma.vpnPeer.create.mockRejectedValueOnce(
        Object.assign(new Error("Unique constraint failed"), {
          code: "P2002",
          meta: { target: ["publicKey"] },
        })
      );
      const res = await app.inject({
        method: "POST",
        url: "/peers",
        headers: apiKeyHeader,
        payload: peerBody,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/already exists/i);
    });

    it("returns 400 for an invalid body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/peers",
        headers: apiKeyHeader,
        payload: { userId: "user-1" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ----- POST /peers/revoke-for-user -----
  describe("POST /peers/revoke-for-user", () => {
    it("revokes all active peers for a user", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/peers/revoke-for-user",
        headers: apiKeyHeader,
        payload: { userId: "user-1" },
      });
      expect(res.statusCode).toBe(204);
      expect(prisma.vpnPeer.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", active: true },
        data: { active: false, revokedAt: expect.any(Date) },
      });
    });

    it("returns 401 without an API key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/peers/revoke-for-user",
        payload: { userId: "user-1" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 for an invalid body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/peers/revoke-for-user",
        headers: apiKeyHeader,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ----- DELETE /peers/:publicKey -----
  describe("DELETE /peers/:publicKey", () => {
    it("revokes a peer by public key", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/peers/client-pk",
        headers: apiKeyHeader,
      });
      expect(res.statusCode).toBe(204);
      expect(prisma.vpnPeer.update).toHaveBeenCalledWith({
        where: { publicKey: "client-pk" },
        data: { active: false, revokedAt: expect.any(Date) },
      });
    });

    it("returns 401 without an API key", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/peers/client-pk",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ----- Token endpoints -----
  describe("Token endpoints", () => {
    it("GET /tokens lists tokens with a classified scope", async () => {
      mockPrisma.vpnToken.findMany.mockResolvedValueOnce([
        {
          id: "id1",
          tokenPrefix: "abcd1234",
          label: "production-node",
          usageCount: 2,
          active: true,
          createdAt: new Date(),
        },
        {
          id: "id2",
          tokenPrefix: "ef567890",
          label: "local-bootstrap",
          usageCount: 0,
          active: true,
          createdAt: new Date(),
        },
      ]);
      const res = await app.inject({
        method: "GET",
        url: "/tokens",
        headers: apiKeyHeader,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body[0].scope).toBe("user");
      expect(body[1].scope).toBe("system");
      // Never leak the token (hash); only the display prefix is exposed.
      expect(body[0]).not.toHaveProperty("token");
      expect(body[0]).not.toHaveProperty("tokenHash");
      expect(body[0].tokenPrefix).toBe("abcd1234");
    });

    it("GET /tokens returns 401 without an API key", async () => {
      const res = await app.inject({ method: "GET", url: "/tokens" });
      expect(res.statusCode).toBe(401);
    });

    it("POST /tokens creates a token and returns the raw token once (201)", async () => {
      mockPrisma.vpnToken.create.mockResolvedValueOnce({
        id: "new-id",
        tokenPrefix: "abcd1234",
        label: "new-node",
        active: true,
        usageCount: 0,
        createdAt: new Date(),
      });
      const res = await app.inject({
        method: "POST",
        url: "/tokens",
        headers: apiKeyHeader,
        payload: { label: "new-node" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.label).toBe("new-node");
      expect(body.scope).toBe("user");
      // The raw token is returned exactly once and is a fresh random hex string,
      // not stored anywhere (only its hash is persisted).
      expect(typeof body.token).toBe("string");
      expect(body.token).toMatch(/^[0-9a-f]{64}$/);
      // The hash is derived from the returned raw token.
      const createArg = vi.mocked(prisma.vpnToken.create).mock.calls[0][0] as {
        data: { tokenHash: string; tokenPrefix: string };
      };
      expect(createArg.data.tokenHash).toBe(hashToken(body.token));
      expect(createArg.data).not.toHaveProperty("token");
      expect(prisma.vpnToken.create).toHaveBeenCalled();
    });

    it("POST /admin/tokens is an alias for token creation", async () => {
      mockPrisma.vpnToken.create.mockResolvedValueOnce({
        id: "admin-id",
        tokenPrefix: "11112222",
        label: "admin-node",
        active: true,
        usageCount: 0,
        createdAt: new Date(),
      });
      const res = await app.inject({
        method: "POST",
        url: "/admin/tokens",
        headers: apiKeyHeader,
        payload: { label: "admin-node" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("POST /tokens returns 401 without an API key", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/tokens",
        payload: { label: "x" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("POST /tokens returns 400 for an invalid body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/tokens",
        headers: apiKeyHeader,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("DELETE /tokens/:id revokes an existing token", async () => {
      mockPrisma.vpnToken.findUnique.mockResolvedValueOnce({
        id: "t1",
        tokenPrefix: "abcd1234",
        label: "node",
        active: true,
        usageCount: 0,
        createdAt: new Date(),
      });
      mockPrisma.vpnToken.update.mockResolvedValueOnce({
        id: "t1",
        tokenPrefix: "abcd1234",
        label: "node",
        active: false,
        usageCount: 0,
        createdAt: new Date(),
      });
      const res = await app.inject({
        method: "DELETE",
        url: "/tokens/t1",
        headers: apiKeyHeader,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(false);
      expect(prisma.vpnToken.update).toHaveBeenCalledWith({
        where: { id: "t1" },
        data: { active: false },
      });
    });

    it("DELETE /tokens/:id returns 404 for an unknown token", async () => {
      mockPrisma.vpnToken.findUnique.mockResolvedValueOnce(null);
      const res = await app.inject({
        method: "DELETE",
        url: "/tokens/missing",
        headers: apiKeyHeader,
      });
      expect(res.statusCode).toBe(404);
    });

    it("DELETE /tokens/:token returns 401 without an API key", async () => {
      const res = await app.inject({ method: "DELETE", url: "/tokens/t1" });
      expect(res.statusCode).toBe(401);
    });
  });

  // ----- API key configuration failure -----
  describe("API key misconfiguration", () => {
    it("returns 500 (server misconfiguration) when CONTROL_PLANE_API_KEY is unset", async () => {
      // requireApiKey throws a non-401 error here: the server is misconfigured,
      // not the client, so it surfaces as a 500 rather than an auth failure.
      delete process.env.CONTROL_PLANE_API_KEY;
      const res = await app.inject({
        method: "GET",
        url: "/servers",
        headers: apiKeyHeader,
      });
      expect(res.statusCode).toBe(500);
    });
  });
});

// ----- Rate limiting -----
describe("rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTROL_PLANE_API_KEY = API_KEY;
    delete process.env.CONTROL_PLANE_BOOTSTRAP_TOKEN;
    delete process.env.PEER_CREDENTIALS_KEY;
    mockPrisma.vpnPeer.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.vpnPeer.update.mockResolvedValue({});
  });

  it("returns 429 once the write limit (20/min) is exceeded on DELETE /peers", async () => {
    const app = await freshServer();
    let limited = false;
    // The write limit is 20/min; the 21st request within the window trips it.
    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: "DELETE",
        url: "/peers/client-pk",
        headers: apiKeyHeader,
      });
      if (res.statusCode === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
    await app.close();
  });

  it("does not rate-limit /health", async () => {
    const app = await freshServer();
    for (let i = 0; i < 150; i++) {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });
});

// ----- Metrics retention -----
describe("metrics retention", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.vpnMetric.deleteMany.mockResolvedValue({ count: 7 });
    mockPrisma.peerMetric.deleteMany.mockResolvedValue({ count: 5 });
  });

  it("computes the cutoff as now minus the retention window", () => {
    const now = new Date("2026-01-31T00:00:00.000Z");
    const cutoff = metricsRetentionCutoff(now, 30);
    expect(cutoff.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("deletes server AND per-peer metrics older than the cutoff and returns the total", async () => {
    const now = new Date("2026-01-31T00:00:00.000Z");
    const count = await pruneOldMetrics(30, now);
    expect(count).toBe(12); // 7 VpnMetric + 5 PeerMetric
    expect(prisma.vpnMetric.deleteMany).toHaveBeenCalledWith({
      where: { timestamp: { lt: metricsRetentionCutoff(now, 30) } },
    });
    expect(prisma.peerMetric.deleteMany).toHaveBeenCalledWith({
      where: { timestamp: { lt: metricsRetentionCutoff(now, 30) } },
    });
  });
});

// ----- Peer password encryption at rest (PEER_CREDENTIALS_KEY) -----
describe("peer password encryption", () => {
  // openssl rand -base64 32 equivalent (deterministic for tests).
  const KEY = Buffer.alloc(32, 7).toString("base64");

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTROL_PLANE_API_KEY = API_KEY;
    delete process.env.CONTROL_PLANE_BOOTSTRAP_TOKEN;
    delete process.env.PEER_CREDENTIALS_KEY;

    mockPrisma.vpnPeer.create.mockResolvedValue({});
    mockPrisma.vpnPeer.findMany.mockResolvedValue([]);
    mockPrisma.vpnToken.findUnique.mockResolvedValue({
      id: "tok-1",
      active: true,
    });
    mockPrisma.vpnToken.update.mockResolvedValue({});
  });

  afterEach(() => {
    delete process.env.PEER_CREDENTIALS_KEY;
  });

  it("encrypt/decrypt round-trips and produces the enc:v1 format", () => {
    process.env.PEER_CREDENTIALS_KEY = KEY;
    const stored = encryptPeerPassword("hunter2");
    expect(stored.startsWith(PEER_CREDENTIALS_PREFIX)).toBe(true);
    // enc:v1:<iv>:<tag>:<ct> — three base64 segments after the prefix.
    expect(stored.slice(PEER_CREDENTIALS_PREFIX.length).split(":")).toHaveLength(3);
    expect(decryptPeerPassword(stored)).toBe("hunter2");
    // Fresh IV every call: same plaintext, different ciphertext.
    expect(encryptPeerPassword("hunter2")).not.toBe(stored);
  });

  it("POST /peers stores an encrypted password and GET /server/peers serves cleartext (endpoint round-trip)", async () => {
    process.env.PEER_CREDENTIALS_KEY = KEY;
    const app = await freshServer();

    const res = await app.inject({
      method: "POST",
      url: "/peers",
      headers: apiKeyHeader,
      payload: {
        publicKey: "client-pk",
        userId: "user-1",
        allowedIps: ["10.8.0.2/32"],
        username: "device-1",
        password: "s3cret-eap",
      },
    });
    expect(res.statusCode).toBe(204);

    const createArg = vi.mocked(prisma.vpnPeer.create).mock.calls[0][0] as {
      data: { password: string };
    };
    expect(createArg.data.password.startsWith(PEER_CREDENTIALS_PREFIX)).toBe(
      true
    );
    expect(createArg.data.password).not.toContain("s3cret-eap");

    // Feed the stored (encrypted) row back through GET /server/peers.
    mockPrisma.vpnPeer.findMany.mockResolvedValueOnce([
      {
        publicKey: "client-pk",
        allowedIps: ["10.8.0.2/32"],
        username: "device-1",
        password: createArg.data.password,
      },
    ]);
    const list = await app.inject({
      method: "GET",
      url: "/server/peers?id=server-1",
      headers: { authorization: "Bearer node-token" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().peers[0].password).toBe("s3cret-eap");
    await app.close();
  });

  it("passes legacy plaintext rows through unchanged on GET /server/peers", async () => {
    process.env.PEER_CREDENTIALS_KEY = KEY;
    const app = await freshServer();
    mockPrisma.vpnPeer.findMany.mockResolvedValueOnce([
      {
        publicKey: "old-pk",
        allowedIps: [],
        username: "legacy-user",
        password: "legacy-plaintext",
      },
      // Null passwords (WireGuard-only peers) must stay null.
      {
        publicKey: "wg-pk",
        allowedIps: [],
        username: null,
        password: null,
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/server/peers",
      headers: { authorization: "Bearer node-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().peers[0].password).toBe("legacy-plaintext");
    expect(res.json().peers[1].password).toBeNull();
    await app.close();
  });

  it("stores plaintext when PEER_CREDENTIALS_KEY is unset (local/e2e stacks)", async () => {
    const app = await freshServer();
    const res = await app.inject({
      method: "POST",
      url: "/peers",
      headers: apiKeyHeader,
      payload: {
        publicKey: "client-pk-2",
        userId: "user-1",
        allowedIps: [],
        username: "device-2",
        password: "plain-pass",
      },
    });
    expect(res.statusCode).toBe(204);
    const createArg = vi.mocked(prisma.vpnPeer.create).mock.calls[0][0] as {
      data: { password: string };
    };
    expect(createArg.data.password).toBe("plain-pass");
    await app.close();
  });

  it("rejects a malformed PEER_CREDENTIALS_KEY at startup (fail fast)", async () => {
    process.env.PEER_CREDENTIALS_KEY = Buffer.alloc(16, 1).toString("base64"); // 16 bytes, not 32
    await expect(buildServer({ cache: false })).rejects.toThrow(
      /PEER_CREDENTIALS_KEY/
    );
  });
});

// ----- Bootstrap token fail-fast -----
describe("bootstrap token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTROL_PLANE_API_KEY = API_KEY;
  });

  afterEach(() => {
    delete process.env.CONTROL_PLANE_BOOTSTRAP_TOKEN;
    delete process.env.PEER_CREDENTIALS_KEY;
    delete process.env.BOOTSTRAP_MAX_ATTEMPTS;
  });

  it("fails fast (rejects) when the configured bootstrap token cannot be ensured", async () => {
    process.env.CONTROL_PLANE_BOOTSTRAP_TOKEN = "boot-token";
    process.env.BOOTSTRAP_MAX_ATTEMPTS = "1"; // don't retry in the test
    mockPrisma.vpnToken.upsert.mockRejectedValue(new Error("db unavailable"));
    await expect(buildServer({ cache: false })).rejects.toThrow(
      /bootstrap token/i
    );
  });

  it("ensures the bootstrap token (by hash) when configured and the DB is reachable", async () => {
    process.env.CONTROL_PLANE_BOOTSTRAP_TOKEN = "boot-token";
    mockPrisma.vpnToken.upsert.mockResolvedValueOnce({
      id: "boot-id",
      active: true,
    });
    const app = await buildServer({ cache: false });
    expect(prisma.vpnToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: hashToken("boot-token") },
      })
    );
    await app.close();
  });
});

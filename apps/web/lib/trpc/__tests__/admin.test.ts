import { describe, it, expect, vi, beforeEach } from "vitest";
import { createContext } from "../init";
import { appRouter } from "../routers/_app";
import type { Session } from "next-auth";

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/controlPlane", () => ({
  revokePeersForUser: vi.fn(),
}));

// Mock fetch
global.fetch = vi.fn();

describe("Admin Router", () => {
  const mockAdminSession: Session = {
    user: { id: "admin123", email: "admin@test.com", name: "Admin User" },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const mockUserSession: Session = {
    user: { id: "user123", email: "user@test.com", name: "Regular User" },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTROL_PLANE_API_URL = "https://api.test.com";
    process.env.CONTROL_PLANE_API_KEY = "test-key";
  });

  describe("admin.listServers", () => {
    it("should list servers for admin", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockAdminSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin123",
        role: "admin",
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => [
          { id: "server1", status: "online", metrics: { sessions: 5 } },
        ],
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockAdminSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.admin.listServers();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("server1");
    });

    it("should deny access for non-admin", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockUserSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        role: "user",
      });

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockUserSession;

      const caller = appRouter.createCaller(ctx);
      await expect(caller.admin.listServers()).rejects.toThrow(
        "Admin access required",
      );
    });
  });

  describe("admin.createToken", () => {
    it("should create a token for admin", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockAdminSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin123",
        role: "admin",
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          id: "tok_1",
          token: "new-token-123",
          tokenPrefix: "new-toke",
          label: "Test Token",
          usageCount: 0,
          active: true,
          createdAt: new Date().toISOString(),
          scope: "user",
        }),
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockAdminSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.admin.createToken({ label: "Test Token" });

      // Raw token returned exactly once on create, plus the prefix for display.
      expect(result.token).toBe("new-token-123");
      expect(result.tokenPrefix).toBe("new-toke");
      expect(result.label).toBe("Test Token");
    });
  });

  describe("admin.revokeToken", () => {
    it("should revoke a token by id for admin", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockAdminSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin123",
        role: "admin",
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ status: "revoked", id: "token-id-1" }),
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockAdminSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.admin.revokeToken({
        id: "token-id-1",
      });

      expect(fetch).toHaveBeenCalledWith(
        "https://api.test.com/tokens/token-id-1",
        {
          method: "DELETE",
          headers: { "x-api-key": "test-key" },
        },
      );
      expect(result.status).toBe("revoked");
    });
  });

  describe("admin.deleteServer", () => {
    it("should delete a server for admin", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockAdminSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin123",
        role: "admin",
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 204,
        text: async () => "",
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockAdminSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.admin.deleteServer({ id: "server-1" });

      expect(fetch).toHaveBeenCalledWith(
        "https://api.test.com/servers/server-1",
        {
          method: "DELETE",
          headers: { "x-api-key": "test-key" },
        },
      );
      expect(result.status).toBe("deleted");
    });

    it("should surface not found errors", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockAdminSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin123",
        role: "admin",
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "not found",
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockAdminSession;

      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.admin.deleteServer({ id: "missing" }),
      ).rejects.toThrow("Server not found");
    });
  });

  describe("admin.listUsers", () => {
    it("returns a mapped user directory for admin", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockAdminSession);

      // First findUnique = admin gate role check.
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin123",
        role: "admin",
      });
      mockPrisma.user.findMany.mockResolvedValue([
        {
          id: "u1",
          email: "u1@test.com",
          name: "User One",
          role: "user",
          createdAt: new Date(),
          devices: [{ id: "d1" }, { id: "d2" }],
          subscriptions: [{ tier: "pro", status: "active" }],
        },
      ]);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockAdminSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.admin.listUsers();

      expect(result).toHaveLength(1);
      expect(result[0].deviceCount).toBe(2);
      expect(result[0].subscription?.tier).toBe("pro");
    });
  });

  describe("admin.updateUserRole", () => {
    it("promotes another user to admin", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockAdminSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin123",
        role: "admin",
      });
      mockPrisma.user.update.mockResolvedValue({ id: "u1", role: "admin" });

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockAdminSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.admin.updateUserRole({
        userId: "u1",
        role: "admin",
      });

      expect(result.success).toBe(true);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { role: "admin" },
      });
    });

    it("prevents an admin from demoting themselves", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockAdminSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin123",
        role: "admin",
      });

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockAdminSession;

      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.admin.updateUserRole({ userId: "admin123", role: "user" }),
      ).rejects.toThrow("You cannot remove your own admin role");
      expect(mockPrisma.user.update).not.toHaveBeenCalled();
    });
  });

  describe("admin.deleteUser", () => {
    it("revokes peers and deletes another user", async () => {
      const { getSession } = await import("@/lib/auth");
      const { revokePeersForUser } = await import("@/lib/controlPlane");
      vi.mocked(getSession).mockResolvedValue(mockAdminSession);

      // 1st findUnique = admin gate, 2nd = target user lookup.
      mockPrisma.user.findUnique
        .mockResolvedValueOnce({ id: "admin123", role: "admin" })
        .mockResolvedValueOnce({ id: "u1", email: "u1@test.com" });
      mockPrisma.user.delete.mockResolvedValue({ id: "u1" });

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockAdminSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.admin.deleteUser({ userId: "u1" });

      expect(result.success).toBe(true);
      expect(revokePeersForUser).toHaveBeenCalledWith("u1");
      expect(mockPrisma.user.delete).toHaveBeenCalledWith({
        where: { id: "u1" },
      });
    });

    it("prevents an admin from deleting themselves", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockAdminSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "admin123",
        role: "admin",
      });

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockAdminSession;

      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.admin.deleteUser({ userId: "admin123" }),
      ).rejects.toThrow("You cannot delete your own account");
      expect(mockPrisma.user.delete).not.toHaveBeenCalled();
    });
  });
});

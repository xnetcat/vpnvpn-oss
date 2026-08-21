import { describe, it, expect, vi, beforeEach } from "vitest";
import { createContext } from "../init";
import { appRouter } from "../routers/_app";
import type { Session } from "next-auth";

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

// Mock fetch
global.fetch = vi.fn();

describe("Servers Router", () => {
  const mockSession: Session = {
    user: { id: "user123", email: "test@test.com", name: "Test User" },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const mockPrisma = {
    subscription: {
      findFirst: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONTROL_PLANE_API_URL = "https://api.test.com";
    process.env.CONTROL_PLANE_API_KEY = "test-key";
  });

  describe("servers.list", () => {
    it("should list servers for paid users", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: "sub123",
        userId: "user123",
        tier: "pro",
        status: "active",
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => [
          {
            id: "server1",
            status: "online",
            metadata: { region: "us-east-1" },
            metrics: { sessions: 5 },
            lastSeen: "2024-01-01T00:00:00Z",
          },
          {
            id: "server2",
            status: "online",
            metadata: { region: "eu-west-1" },
            metrics: { sessions: 3 },
            lastSeen: "2024-01-01T00:00:00Z",
          },
        ],
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.servers.list();

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("server1");
      expect(result[0].region).toBe("us-east-1");
      expect(result[0].sessions).toBe(5);
    });

    it("should allow free-tier users (no subscription) to list servers", async () => {
      // paidProcedure intentionally falls through to the "free" tier when a
      // user has no active subscription (free tier = 1 device, all servers),
      // so server listing is available to authenticated free users too.
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.subscription.findFirst.mockResolvedValue(null);

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => [],
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      await expect(caller.servers.list()).resolves.toEqual([]);
    });
  });
});

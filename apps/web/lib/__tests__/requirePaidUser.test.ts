import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

describe("requirePaidUser", () => {
  const mockPrisma = {
    subscription: {
      findFirst: vi.fn(),
    },
    device: {
      count: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("should allow paid user with active subscription", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user123" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    } as any);

    vi.doMock("@/lib/prisma", () => ({
      prisma: mockPrisma,
    }));

    mockPrisma.subscription.findFirst.mockResolvedValue({
      id: "sub123",
      userId: "user123",
      status: "active",
      tier: "pro",
    });

    const { requirePaidUser } = await import("@/lib/requirePaidUser");
    const result = await requirePaidUser();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("user123");
      expect(result.tier).toBe("pro");
      expect(result.deviceLimit).toBe(5);
    }
  });

  it("should reject unauthenticated user", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue(null);

    const { requirePaidUser } = await import("@/lib/requirePaidUser");
    const result = await requirePaidUser();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unauthenticated");
    }
  });

  it("should grant Free tier to a user without a subscription", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user123" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    } as any);

    vi.doMock("@/lib/prisma", () => ({
      prisma: mockPrisma,
    }));

    mockPrisma.subscription.findFirst.mockResolvedValue(null);

    const { requireUser } = await import("@/lib/requirePaidUser");
    const result = await requireUser();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("user123");
      expect(result.tier).toBe("free");
      expect(result.deviceLimit).toBe(1);
    }
  });

  it("requirePaidUser is an alias for requireUser (Free tier, no paywall)", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user123" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    } as any);

    vi.doMock("@/lib/prisma", () => ({
      prisma: mockPrisma,
    }));

    mockPrisma.subscription.findFirst.mockResolvedValue(null);

    const { requirePaidUser } = await import("@/lib/requirePaidUser");
    const result = await requirePaidUser();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tier).toBe("free");
    }
  });

  it("should allow admin user without subscription", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "admin123", role: "admin" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    } as any);

    vi.doMock("@/lib/prisma", () => ({
      prisma: mockPrisma,
    }));

    const { requirePaidUser } = await import("@/lib/requirePaidUser");
    const result = await requirePaidUser();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("admin123");
      expect(result.tier).toBe("enterprise");
      expect(result.deviceLimit).toBe(999);
    }
    // Subscription should not be queried for admins
    expect(mockPrisma.subscription.findFirst).not.toHaveBeenCalled();
  });

  it("should check device limit", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user123" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    } as any);

    vi.doMock("@/lib/prisma", () => ({
      prisma: mockPrisma,
    }));

    mockPrisma.subscription.findFirst.mockResolvedValue({
      id: "sub123",
      userId: "user123",
      status: "active",
      tier: "basic",
    });

    mockPrisma.device.count.mockResolvedValue(1);

    const { checkDeviceLimit } = await import("@/lib/requirePaidUser");
    const result = await checkDeviceLimit("user123");

    expect(result.canAdd).toBe(false);
    expect(result.current).toBe(1);
    expect(result.limit).toBe(1);
  });
});

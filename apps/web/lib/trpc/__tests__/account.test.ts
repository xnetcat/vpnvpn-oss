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

describe("Account Router", () => {
  const mockSession: Session = {
    user: { id: "user123", email: "test@test.com", name: "Test User" } as any,
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const mockPrisma = {
    subscription: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    notificationPreferences: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    device: {
      findMany: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns aggregated account data from get", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue(mockSession);

    mockPrisma.subscription.findFirst.mockResolvedValue({
      id: "sub123",
      userId: "user123",
      tier: "pro",
      status: "active",
      currentPeriodEnd: new Date(),
      updatedAt: new Date(),
    });

    mockPrisma.user.findUnique.mockResolvedValue({
      name: "Test User",
      email: "test@test.com",
    });

    mockPrisma.notificationPreferences.findUnique.mockResolvedValue({
      userId: "user123",
      marketing: true,
      transactional: true,
      security: true,
    });

    const ctx = await createContext();
    ctx.prisma = mockPrisma as any;
    ctx.session = mockSession;

    const caller = appRouter.createCaller(ctx);
    const result = await caller.account.get();

    expect(result.subscription?.id).toBe("sub123");
    expect(result.user?.email).toBe("test@test.com");
    expect(result.notificationPreferences?.security).toBe(true);
  });

  it("updates profile name via updateProfile", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue(mockSession);

    const ctx = await createContext();
    ctx.prisma = mockPrisma as any;
    ctx.session = mockSession;

    const caller = appRouter.createCaller(ctx);
    await caller.account.updateProfile({ name: "New Name" });

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: "user123" },
      data: { name: "New Name" },
    });
  });

  it("upserts notification preferences via updateNotifications", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue(mockSession);

    const ctx = await createContext();
    ctx.prisma = mockPrisma as any;
    ctx.session = mockSession;

    const caller = appRouter.createCaller(ctx);
    await caller.account.updateNotifications({
      marketing: false,
      transactional: true,
      security: false,
    });

    expect(mockPrisma.notificationPreferences.upsert).toHaveBeenCalledWith({
      where: { userId: "user123" },
      update: {
        marketing: false,
        transactional: true,
        security: false,
      },
      create: {
        userId: "user123",
        marketing: false,
        transactional: true,
        security: false,
      },
    });
  });

  it("exportData returns the user's data bundle", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue(mockSession);

    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user123",
      name: "Test User",
      email: "test@test.com",
    });
    mockPrisma.device.findMany.mockResolvedValue([{ id: "dev1" }]);
    mockPrisma.subscription.findMany.mockResolvedValue([{ id: "sub1" }]);
    mockPrisma.notificationPreferences.findUnique.mockResolvedValue({
      userId: "user123",
      marketing: true,
    });

    const ctx = await createContext();
    ctx.prisma = mockPrisma as any;
    ctx.session = mockSession;

    const caller = appRouter.createCaller(ctx);
    const result = await caller.account.exportData();

    expect(result.profile?.email).toBe("test@test.com");
    expect(result.devices).toHaveLength(1);
    expect(result.subscriptions).toHaveLength(1);
    expect(result.notificationPreferences?.marketing).toBe(true);
    expect(typeof result.exportedAt).toBe("string");
  });

  it("deleteAccount revokes peers, cancels subscriptions, and deletes user", async () => {
    const { getSession } = await import("@/lib/auth");
    const { stripe } = await import("@/lib/stripe");
    const { revokePeersForUser } = await import("@/lib/controlPlane");
    vi.mocked(getSession).mockResolvedValue(mockSession);

    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      subscriptions: [{ stripeSubscriptionId: "sub_123" }],
    });
    mockPrisma.user.delete.mockResolvedValue({ id: "user123" });
    vi.mocked(stripe.subscriptions.cancel).mockResolvedValue({} as any);

    const ctx = await createContext();
    ctx.prisma = mockPrisma as any;
    ctx.session = mockSession;

    const caller = appRouter.createCaller(ctx);
    const result = await caller.account.deleteAccount({ confirm: true });

    expect(result.success).toBe(true);
    expect(revokePeersForUser).toHaveBeenCalledWith("user123");
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_123");
    expect(mockPrisma.user.delete).toHaveBeenCalledWith({
      where: { id: "user123" },
    });
  });

  it("deleteAccount still deletes when peer revocation fails", async () => {
    const { getSession } = await import("@/lib/auth");
    const { revokePeersForUser } = await import("@/lib/controlPlane");
    vi.mocked(getSession).mockResolvedValue(mockSession);
    vi.mocked(revokePeersForUser).mockRejectedValueOnce(
      new Error("control plane down"),
    );

    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      subscriptions: [],
    });
    mockPrisma.user.delete.mockResolvedValue({ id: "user123" });

    const ctx = await createContext();
    ctx.prisma = mockPrisma as any;
    ctx.session = mockSession;

    const caller = appRouter.createCaller(ctx);
    const result = await caller.account.deleteAccount({ confirm: true });

    expect(result.success).toBe(true);
    expect(mockPrisma.user.delete).toHaveBeenCalled();
  });
});

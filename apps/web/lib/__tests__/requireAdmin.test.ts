import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

describe("requireAdmin", () => {
  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should allow admin user", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "admin123" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    } as any);

    vi.doMock("@/lib/prisma", () => ({
      prisma: mockPrisma,
    }));

    mockPrisma.user.findUnique.mockResolvedValue({
      id: "admin123",
      role: "admin",
    });

    const { requireAdmin } = await import("@/lib/requireAdmin");
    const result = await requireAdmin();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.userId).toBe("admin123");
    }
  });

  it("should reject non-admin user", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "user123" },
      expires: new Date(Date.now() + 86400000).toISOString(),
    } as any);

    vi.doMock("@/lib/prisma", () => ({
      prisma: mockPrisma,
    }));

    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user123",
      role: "user",
    });

    const { requireAdmin } = await import("@/lib/requireAdmin");
    const result = await requireAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("forbidden");
    }
  });

  it("should reject unauthenticated user", async () => {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue(null);

    const { requireAdmin } = await import("@/lib/requireAdmin");
    const result = await requireAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unauthenticated");
    }
  });
});

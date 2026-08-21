import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = {
  desktopLoginCode: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
};

vi.mock("@vpnvpn/db", () => ({
  prisma: mockPrisma,
}));

describe("consumeDesktopCode brute-force lockout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the url and consumes the code on a correct match", async () => {
    const { consumeDesktopCode } = await import("@/lib/desktopCodes");

    mockPrisma.desktopLoginCode.findFirst.mockResolvedValue({
      id: "c1",
      code: "123456",
      url: "/callback",
      attempts: 0,
    });
    mockPrisma.desktopLoginCode.update.mockResolvedValue({});

    const result = await consumeDesktopCode("user@test.com", "123456");

    expect(result).toBe("/callback");
    expect(mockPrisma.desktopLoginCode.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it("returns null when there is no candidate code", async () => {
    const { consumeDesktopCode } = await import("@/lib/desktopCodes");
    mockPrisma.desktopLoginCode.findFirst.mockResolvedValue(null);

    const result = await consumeDesktopCode("user@test.com", "123456");
    expect(result).toBeNull();
  });

  it("increments attempts and rejects on a wrong code", async () => {
    const { consumeDesktopCode } = await import("@/lib/desktopCodes");

    mockPrisma.desktopLoginCode.findFirst.mockResolvedValue({
      id: "c1",
      code: "123456",
      url: "/callback",
      attempts: 2,
    });
    mockPrisma.desktopLoginCode.update.mockResolvedValue({});

    const result = await consumeDesktopCode("user@test.com", "000000");

    expect(result).toBeNull();
    expect(mockPrisma.desktopLoginCode.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { attempts: { increment: 1 } },
    });
  });

  it("treats a code as invalid once it is locked out, even if correct", async () => {
    const { consumeDesktopCode } = await import("@/lib/desktopCodes");

    mockPrisma.desktopLoginCode.findFirst.mockResolvedValue({
      id: "c1",
      code: "123456",
      url: "/callback",
      attempts: 5,
    });

    const result = await consumeDesktopCode("user@test.com", "123456");

    expect(result).toBeNull();
    // No consume/increment when already locked out.
    expect(mockPrisma.desktopLoginCode.update).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/controlPlane", () => ({
  revokePeerByPublicKey: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
}));

function device(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    name: `Device ${id}`,
    publicKey: `pk_${id}`,
    status: "active",
    createdAt: new Date(),
    ...overrides,
  };
}

describe("enforceDeviceLimitForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when device count is within the limit", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { revokePeerByPublicKey } = await import("@/lib/controlPlane");

    vi.mocked(prisma.device.findMany).mockResolvedValue([device("a")] as any);

    const { enforceDeviceLimitForUser } = await import(
      "@/lib/deviceRevocation"
    );
    const result = await enforceDeviceLimitForUser("user123", 1);

    expect(result.revoked).toBe(0);
    expect(revokePeerByPublicKey).not.toHaveBeenCalled();
    expect(prisma.device.delete).not.toHaveBeenCalled();
  });

  it("revokes the NEWEST devices beyond the limit, keeping the oldest", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { revokePeerByPublicKey } = await import("@/lib/controlPlane");

    // findMany is ordered oldest-first; a is oldest, c is newest.
    vi.mocked(prisma.device.findMany).mockResolvedValue([
      device("a"),
      device("b"),
      device("c"),
    ] as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      email: "u@test.com",
      name: "U",
    } as any);

    const { enforceDeviceLimitForUser } = await import(
      "@/lib/deviceRevocation"
    );
    const result = await enforceDeviceLimitForUser("user123", 1);

    expect(result.revoked).toBe(2);
    // Oldest (a) kept; b and c (newest) revoked.
    expect(revokePeerByPublicKey).toHaveBeenCalledWith("pk_b");
    expect(revokePeerByPublicKey).toHaveBeenCalledWith("pk_c");
    expect(revokePeerByPublicKey).not.toHaveBeenCalledWith("pk_a");
    expect(prisma.device.delete).toHaveBeenCalledWith({ where: { id: "b" } });
    expect(prisma.device.delete).toHaveBeenCalledWith({ where: { id: "c" } });
  });

  it("sends device_revoked email for active devices but not pending ones", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { sendEmail } = await import("@/lib/email");

    vi.mocked(prisma.device.findMany).mockResolvedValue([
      device("a"),
      device("b", { status: "pending" }),
      device("c", { status: "active" }),
    ] as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      email: "u@test.com",
      name: "U",
    } as any);

    const { enforceDeviceLimitForUser } = await import(
      "@/lib/deviceRevocation"
    );
    await enforceDeviceLimitForUser("user123", 1);

    // b is pending → no email; c is active → email sent.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "u@test.com", template: "device_revoked" }),
    );
  });

  it("skips emails entirely when sendEmail option is false", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { sendEmail } = await import("@/lib/email");

    vi.mocked(prisma.device.findMany).mockResolvedValue([
      device("a"),
      device("b"),
    ] as any);

    const { enforceDeviceLimitForUser } = await import(
      "@/lib/deviceRevocation"
    );
    await enforceDeviceLimitForUser("user123", 1, { sendEmail: false });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("still deletes the DB row when control-plane revocation fails", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { revokePeerByPublicKey } = await import("@/lib/controlPlane");

    vi.mocked(prisma.device.findMany).mockResolvedValue([
      device("a"),
      device("b"),
    ] as any);
    vi.mocked(revokePeerByPublicKey).mockRejectedValueOnce(
      new Error("control plane down"),
    );

    const { enforceDeviceLimitForUser } = await import(
      "@/lib/deviceRevocation"
    );
    await enforceDeviceLimitForUser("user123", 1, { sendEmail: false });

    expect(prisma.device.delete).toHaveBeenCalledWith({ where: { id: "b" } });
  });
});

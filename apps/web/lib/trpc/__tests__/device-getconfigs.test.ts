import { describe, it, expect, vi, beforeEach } from "vitest";
import { createContext } from "../init";
import { appRouter } from "../routers/_app";
import type { Session } from "next-auth";

vi.mock("@/lib/auth", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/controlPlane", () => ({
  addPeerForDevice: vi.fn(),
  revokePeerByPublicKey: vi.fn(),
  revokePeersForUser: vi.fn(),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

describe("device.getConfigs (downloadable profiles for third-party clients)", () => {
  const mockSession: Session = {
    user: { id: "user123", email: "t@t.com", name: "T" } as any,
    expires: new Date(Date.now() + 86400000).toISOString(),
  };

  const mockPrisma = {
    subscription: { findFirst: vi.fn() },
    device: { findUnique: vi.fn(), update: vi.fn() },
    vpnServer: { findUnique: vi.fn() },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetRateLimits } = await import("@/lib/trpc/rateLimit");
    __resetRateLimits();
    mockPrisma.subscription.findFirst.mockResolvedValue({
      id: "s",
      userId: "user123",
      tier: "pro",
      status: "active",
    });
  });

  async function caller() {
    const { getSession } = await import("@/lib/auth");
    vi.mocked(getSession).mockResolvedValue(mockSession);
    const ctx = await createContext();
    ctx.prisma = mockPrisma as any;
    ctx.session = mockSession;
    return appRouter.createCaller(ctx);
  }

  it("returns all profiles incl. a valid Apple .mobileconfig and rotates the key", async () => {
    mockPrisma.device.findUnique.mockResolvedValue({
      id: "dev1",
      userId: "user123",
      serverId: "srv1",
      publicKey: "OLDPUBKEY",
      assignedIp: "10.8.0.5",
      name: "Laptop",
      status: "active",
    });
    mockPrisma.vpnServer.findUnique.mockResolvedValue({
      id: "srv1",
      publicKey: "SERVERPUBKEY",
      publicIp: "1.2.3.4",
      wgEndpoint: "1.2.3.4",
      wgPort: 51820,
      ovpnEndpoint: "1.2.3.4",
      ovpnPort: 1194,
      ovpnCaBundle: null,
      ovpnPeerFingerprint: null,
      ikev2Remote: "1.2.3.4:500",
      metadata: {
        ikev2CaBundle:
          "-----BEGIN CERTIFICATE-----\nMIIBdummycertbody\n-----END CERTIFICATE-----",
      },
    });
    mockPrisma.device.update.mockResolvedValue({});

    const { addPeerForDevice, revokePeerByPublicKey } = await import(
      "@/lib/controlPlane"
    );
    vi.mocked(addPeerForDevice).mockResolvedValue(undefined as any);
    vi.mocked(revokePeerByPublicKey).mockResolvedValue(undefined as any);

    const c = await caller();
    const res = await c.device.getConfigs({ deviceId: "dev1" });

    // WireGuard profile is complete.
    expect(res.wireguardConfig).toContain("[Interface]");
    expect(res.wireguardConfig).toContain("PublicKey = SERVERPUBKEY");
    expect(res.wireguardConfig).toContain("10.8.0.5/32");

    // Apple .mobileconfig is a valid IKEv2/EAP plist with the embedded CA.
    expect(res.appleMobileConfig).toContain("<plist");
    expect(res.appleMobileConfig).toContain("com.apple.vpn.managed");
    expect(res.appleMobileConfig).toContain("ExtendedAuthEnabled");
    expect(res.appleMobileConfig).toContain(
      `<string>${res.vpnCredentials.username}</string>`,
    );
    expect(res.appleMobileConfig).toContain("com.apple.security.root");
    expect(res.appleMobileConfig).toContain("MIIBdummycertbody");

    // Key rotation + peer re-registration happened.
    expect(revokePeerByPublicKey).toHaveBeenCalledWith("OLDPUBKEY");
    expect(addPeerForDevice).toHaveBeenCalledTimes(1);
    expect(mockPrisma.device.update).toHaveBeenCalled();
  });

  it("rejects a device the user does not own", async () => {
    mockPrisma.device.findUnique.mockResolvedValue({
      id: "dev1",
      userId: "SOMEONE_ELSE",
      serverId: "srv1",
      publicKey: "k",
      name: "x",
    });
    const c = await caller();
    await expect(c.device.getConfigs({ deviceId: "dev1" })).rejects.toThrow();
  });
});

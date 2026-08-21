import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch
global.fetch = vi.fn();

// Set test env vars
process.env.CONTROL_PLANE_API_URL = "https://api.test.com";
process.env.CONTROL_PLANE_API_KEY = "test-api-key";

describe("Control Plane Client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("addPeerForDevice", () => {
    it("should add peer successfully", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        text: async () => "OK",
      } as any);

      const { addPeerForDevice } = await import("@/lib/controlPlane");

      await expect(
        addPeerForDevice({
          publicKey: "test-key",
          userId: "user123",
          allowedIps: ["10.8.0.10/32"],
        }),
      ).resolves.toBeUndefined();

      expect(fetch).toHaveBeenCalledWith(
        "https://api.test.com/peers",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-api-key": "test-api-key",
          }),
        }),
      );
    });

    it("should throw on non-200 response", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      } as any);

      const { addPeerForDevice } = await import("@/lib/controlPlane");

      await expect(
        addPeerForDevice({
          publicKey: "test-key",
          userId: "user123",
          allowedIps: ["10.8.0.10/32"],
        }),
      ).rejects.toThrow("addPeer failed with status 500");
    });
  });

  describe("revokePeersForUser", () => {
    it("should revoke all user peers", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        text: async () => "OK",
      } as any);

      const { revokePeersForUser } = await import("@/lib/controlPlane");

      await expect(revokePeersForUser("user123")).resolves.toBeUndefined();

      expect(fetch).toHaveBeenCalledWith(
        "https://api.test.com/peers/revoke-for-user",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ userId: "user123" }),
        }),
      );
    });
  });

  describe("revokePeerByPublicKey", () => {
    it("should revoke single peer", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        text: async () => "OK",
      } as any);

      const { revokePeerByPublicKey } = await import("@/lib/controlPlane");

      await expect(
        revokePeerByPublicKey("test-public-key"),
      ).resolves.toBeUndefined();

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/peers/test-public-key"),
        expect.objectContaining({
          method: "DELETE",
        }),
      );
    });
  });

  describe("error handling", () => {
    it("should throw if control plane not configured", async () => {
      process.env.CONTROL_PLANE_API_URL = "";

      vi.resetModules();
      const { addPeerForDevice } = await import("@/lib/controlPlane");

      await expect(
        addPeerForDevice({
          publicKey: "test-key",
          userId: "user123",
          allowedIps: ["10.8.0.10/32"],
        }),
      ).rejects.toThrow("Control plane not configured");

      // Restore
      process.env.CONTROL_PLANE_API_URL = "https://api.test.com";
    });
  });
});

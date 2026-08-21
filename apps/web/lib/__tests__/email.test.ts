import { describe, it, expect, vi, beforeEach } from "vitest";

const mockEmailSend = vi.fn().mockResolvedValue({ id: "email-123" });

vi.mock("resend", () => ({
  // Use a regular function (not an arrow) so it can be used as a constructor:
  // email.ts calls `new Resend(...)`, and Vitest 4 enforces real `new`
  // semantics — arrow functions cannot be constructed.
  Resend: vi.fn(function () {
    return {
      emails: {
        send: mockEmailSend,
      },
    };
  }),
}));

// Set test env vars
process.env.RESEND_API_KEY = "re_test_123";
process.env.EMAIL_FROM = "test@vpnvpn.dev";

describe("Email utilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEmailSend.mockClear();
  });

  it("should send welcome email", async () => {
    const { sendEmail } = await import("@/lib/email");

    await sendEmail({
      to: "user@test.com",
      template: "welcome",
      data: {
        name: "Test User",
        dashboardUrl: "http://localhost:3000/dashboard",
      },
    });

    expect(mockEmailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@test.com",
        subject: "Welcome to vpnVPN",
      }),
    );
  });

  it("should send subscription active email", async () => {
    const { sendEmail } = await import("@/lib/email");

    await sendEmail({
      to: "user@test.com",
      template: "subscription_active",
      data: {
        name: "Test User",
        plan: "Pro",
        deviceLimit: "5",
        nextBillingDate: "2024-12-31",
        dashboardUrl: "http://localhost:3000/dashboard",
      },
    });

    expect(mockEmailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@test.com",
        subject: "Your vpnVPN subscription is active",
      }),
    );
  });

  it("should send subscription cancelled email", async () => {
    const { sendEmail } = await import("@/lib/email");

    await sendEmail({
      to: "user@test.com",
      template: "subscription_cancelled",
      data: {
        name: "Test User",
        pricingUrl: "http://localhost:3000/pricing",
      },
    });

    expect(mockEmailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@test.com",
        subject: "Your vpnVPN subscription has been cancelled",
      }),
    );
  });

  it("should send payment failed dunning email", async () => {
    const { sendEmail } = await import("@/lib/email");

    await sendEmail({
      to: "user@test.com",
      template: "payment_failed",
      data: {
        name: "Test User",
        amount: "$30.00",
        billingUrl: "http://localhost:3000/account",
      },
    });

    expect(mockEmailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@test.com",
        subject: "Action required: your vpnVPN payment failed",
      }),
    );
  });

  it("should send payment receipt email", async () => {
    const { sendEmail } = await import("@/lib/email");

    await sendEmail({
      to: "user@test.com",
      template: "payment_receipt",
      data: {
        name: "Test User",
        amount: "$30.00",
        plan: "Pro",
        invoiceNumber: "INV-0042",
        hostedInvoiceUrl: "https://stripe.test/inv/42",
        invoicePdf: "https://stripe.test/inv/42.pdf",
        billingUrl: "http://localhost:3000/account",
      },
    });

    expect(mockEmailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@test.com",
        subject: "Your vpnVPN payment receipt",
      }),
    );
    const sent = mockEmailSend.mock.calls[0][0];
    // Amount, plan and invoice links are present in both bodies.
    expect(sent.html).toContain("$30.00");
    expect(sent.html).toContain("Pro");
    expect(sent.html).toContain("https://stripe.test/inv/42");
    expect(sent.html).toContain("https://stripe.test/inv/42.pdf");
    expect(sent.text).toContain("$30.00");
    expect(sent.text).toContain("https://stripe.test/inv/42");
  });

  it("should send device added security alert", async () => {
    const { sendEmail } = await import("@/lib/email");

    await sendEmail({
      to: "user@test.com",
      template: "device_added",
      data: {
        name: "Test User",
        deviceName: "MacBook Pro",
        dashboardUrl: "http://localhost:3000/devices",
      },
    });

    expect(mockEmailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@test.com",
        subject: "New device added to your vpnVPN account",
      }),
    );
  });

  it("should send device revoked security alert", async () => {
    const { sendEmail } = await import("@/lib/email");

    await sendEmail({
      to: "user@test.com",
      template: "device_revoked",
      data: {
        name: "Test User",
        deviceName: "MacBook Pro",
        dashboardUrl: "http://localhost:3000/devices",
      },
    });

    expect(mockEmailSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@test.com",
        subject: "Device removed from your vpnVPN account",
      }),
    );
  });

  it("skips marketing email (welcome) when marketing preference is off", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPreferences: { marketing: false },
    } as any);

    const { sendEmail } = await import("@/lib/email");
    await sendEmail({
      to: "user@test.com",
      template: "welcome",
      data: { name: "Test User" },
    });

    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  it("skips security email (device_added) when security preference is off", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPreferences: { security: false },
    } as any);

    const { sendEmail } = await import("@/lib/email");
    await sendEmail({
      to: "user@test.com",
      template: "device_added",
      data: { name: "Test User", deviceName: "Laptop" },
    });

    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  it("still sends transactional email when its preference is enabled", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPreferences: { transactional: true },
    } as any);

    const { sendEmail } = await import("@/lib/email");
    await sendEmail({
      to: "user@test.com",
      template: "subscription_active",
      data: { name: "Test User", plan: "Pro" },
    });

    expect(mockEmailSend).toHaveBeenCalled();
  });

  it("skips payment_receipt when the transactional preference is off (receipts are not dunning)", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPreferences: { transactional: false },
    } as any);

    const { sendEmail } = await import("@/lib/email");
    await sendEmail({
      to: "user@test.com",
      template: "payment_receipt",
      data: { name: "Test User", amount: "$30.00", plan: "Pro" },
    });

    expect(mockEmailSend).not.toHaveBeenCalled();
  });

  it("always sends auth-critical otp_code even when all preferences are off", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPreferences: {
        marketing: false,
        transactional: false,
        security: false,
      },
    } as any);

    const { sendEmail } = await import("@/lib/email");
    await sendEmail({
      to: "user@test.com",
      template: "otp_code",
      data: { code: "123456", expiresMinutes: 10 },
    });

    expect(mockEmailSend).toHaveBeenCalled();
  });

  it("always sends billing-critical payment_failed even when transactional is off", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      notificationPreferences: { transactional: false },
    } as any);

    const { sendEmail } = await import("@/lib/email");
    await sendEmail({
      to: "user@test.com",
      template: "payment_failed",
      data: { name: "Test User", amount: "$30.00" },
    });

    expect(mockEmailSend).toHaveBeenCalled();
  });

  it("sends when the recipient has no preferences row (opt-out default)", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as any);

    const { sendEmail } = await import("@/lib/email");
    await sendEmail({
      to: "user@test.com",
      template: "welcome",
      data: { name: "Test User" },
    });

    expect(mockEmailSend).toHaveBeenCalled();
  });

  it("should handle missing API key gracefully", async () => {
    process.env.RESEND_API_KEY = "";

    // Re-import to get new instance without API key
    vi.resetModules();
    const { sendEmail } = await import("@/lib/email");

    // Should not throw
    await expect(
      sendEmail({
        to: "user@test.com",
        template: "welcome",
        data: { name: "Test" },
      }),
    ).resolves.toBeUndefined();

    // Restore
    process.env.RESEND_API_KEY = "re_test_123";
  });
});

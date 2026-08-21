import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/controlPlane", () => ({
  revokePeersForUser: vi.fn(),
  revokePeerByPublicKey: vi.fn(),
}));

vi.mock("@/lib/deviceRevocation", () => ({
  enforceDeviceLimitForUser: vi.fn().mockResolvedValue({ revoked: 0 }),
}));

vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn(),
}));

function makeRequest(body: string, sig: string | null) {
  const headers = new Headers();
  if (sig !== null) headers.set("stripe-signature", sig);
  return new Request("https://example.com/api/webhooks/stripe", {
    method: "POST",
    headers,
    body,
  });
}

describe("Stripe webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  });

  it("returns 400 when the signature is missing", async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", null));
    expect(res.status).toBe(400);
  });

  it("returns 400 when signature verification fails", async () => {
    const { stripe } = await import("@/lib/stripe");
    vi.mocked(stripe.webhooks.constructEvent).mockImplementation(() => {
      throw new Error("Invalid signature");
    });

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "bad-sig"));
    expect(res.status).toBe(400);
  });

  it("sends a dunning email on invoice.payment_failed", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");
    const { sendEmail } = await import("@/lib/email");

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      type: "invoice.payment_failed",
      data: {
        object: {
          customer: "cus_123",
          amount_due: 3000,
          currency: "usd",
        },
      },
    } as any);

    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      name: "Test User",
    } as any);

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "test@test.com",
        template: "payment_failed",
      }),
    );
  });

  it("enforces the new tier device limit on an active subscription update (downgrade)", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");
    const { enforceDeviceLimitForUser } = await import(
      "@/lib/deviceRevocation"
    );

    // Active subscription on the basic tier → limit 1.
    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: "active",
          items: { data: [{ price: { id: "price_basic_test" } }] },
        },
      },
    } as any);

    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      name: "Test User",
    } as any);
    vi.mocked(prisma.subscription.upsert).mockResolvedValue({} as any);

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(200);
    // basic tier device limit is 1.
    expect(enforceDeviceLimitForUser).toHaveBeenCalledWith("user123", 1);
  });

  it("resolves a yearly price ID to the correct tier", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");
    const { enforceDeviceLimitForUser } = await import(
      "@/lib/deviceRevocation"
    );

    // Active subscription on the PRO yearly price → pro tier, device limit 5.
    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: "active",
          items: { data: [{ price: { id: "price_pro_yearly_test" } }] },
        },
      },
    } as any);

    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      name: "Test User",
    } as any);
    let upsertArgs: any;
    vi.mocked(prisma.subscription.upsert).mockImplementation((async (
      a: any,
    ) => {
      upsertArgs = a;
      return {} as any;
    }) as any);

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(200);
    // Pro tier device limit is 5.
    expect(enforceDeviceLimitForUser).toHaveBeenCalledWith("user123", 5);
    // The persisted tier should be "pro" even though the price ID was yearly.
    expect(upsertArgs.create.tier).toBe("pro");
    expect(upsertArgs.update.tier).toBe("pro");
  });

  it("prunes devices to the free limit on subscription cancellation", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");
    const { revokePeersForUser } = await import("@/lib/controlPlane");
    const { enforceDeviceLimitForUser } = await import(
      "@/lib/deviceRevocation"
    );

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: "canceled",
          items: { data: [{ price: { id: "price_pro_test" } }] },
        },
      },
    } as any);

    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      name: "Test User",
    } as any);
    vi.mocked(prisma.subscription.upsert).mockResolvedValue({} as any);

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(200);
    expect(revokePeersForUser).toHaveBeenCalledWith("user123");
    // Free tier limit is 1, and the per-device email is suppressed.
    expect(enforceDeviceLimitForUser).toHaveBeenCalledWith("user123", 1, {
      sendEmail: false,
    });
  });

  it("sends a receipt email on invoice.payment_succeeded for a paid invoice", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");
    const { sendEmail } = await import("@/lib/email");

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      type: "invoice.payment_succeeded",
      data: {
        object: {
          customer: "cus_123",
          amount_paid: 3000,
          currency: "usd",
          number: "INV-0042",
          hosted_invoice_url: "https://stripe.test/inv/42",
          invoice_pdf: "https://stripe.test/inv/42.pdf",
          lines: { data: [{ price: { id: "price_pro_test" } }] },
        },
      },
    } as any);

    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      name: "Test User",
    } as any);

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "test@test.com",
        template: "payment_receipt",
        data: expect.objectContaining({
          amount: "$30.00",
          plan: "Pro",
          invoiceNumber: "INV-0042",
          hostedInvoiceUrl: "https://stripe.test/inv/42",
          invoicePdf: "https://stripe.test/inv/42.pdf",
        }),
      }),
    );
  });

  it("skips the receipt email for $0 invoices (free tier / trials)", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");
    const { sendEmail } = await import("@/lib/email");

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      type: "invoice.payment_succeeded",
      data: {
        object: {
          customer: "cus_123",
          amount_paid: 0,
          currency: "usd",
        },
      },
    } as any);

    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      name: "Test User",
    } as any);

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not return 500 when the receipt email send fails (no replay)", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");
    const { sendEmail } = await import("@/lib/email");

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      type: "invoice.payment_succeeded",
      data: {
        object: {
          customer: "cus_123",
          amount_paid: 1000,
          currency: "usd",
          lines: { data: [{ price: { id: "price_basic_test" } }] },
        },
      },
    } as any);

    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      name: "Test User",
    } as any);
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("Resend down"));

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(200);
  });

  it("acks a duplicate event ID without re-processing (idempotency)", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");
    const { sendEmail } = await import("@/lib/email");

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      id: "evt_dup",
      type: "invoice.payment_failed",
      data: {
        object: { customer: "cus_123", amount_due: 1000, currency: "usd" },
      },
    } as any);

    // Unique violation on the dedup insert → already processed.
    vi.mocked(prisma.stripeEvent.create).mockRejectedValue({ code: "P2002" });

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    // Nothing was re-processed.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("records the event ID before processing and keeps it on success", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      id: "evt_ok",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: "active",
          items: { data: [{ price: { id: "price_basic_test" } }] },
        },
      },
    } as any);

    vi.mocked(prisma.stripeEvent.create).mockResolvedValue({} as any);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      name: "Test User",
    } as any);
    vi.mocked(prisma.subscription.upsert).mockResolvedValue({} as any);

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(200);
    expect(prisma.stripeEvent.create).toHaveBeenCalledWith({
      data: { id: "evt_ok", type: "customer.subscription.updated" },
    });
    expect(prisma.stripeEvent.delete).not.toHaveBeenCalled();
  });

  it("clears the dedup record on a retryable failure so the replay is processed", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      id: "evt_retry",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: "active",
          items: { data: [{ price: { id: "price_basic_test" } }] },
        },
      },
    } as any);

    vi.mocked(prisma.stripeEvent.create).mockResolvedValue({} as any);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      name: "Test User",
    } as any);
    // The state write fails → retryable → 500 + dedup row removed.
    vi.mocked(prisma.subscription.upsert).mockRejectedValue(
      new Error("db down"),
    );

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(500);
    expect(prisma.stripeEvent.delete).toHaveBeenCalledWith({
      where: { id: "evt_retry" },
    });
  });

  it("returns 500 (retryable) when the dedup insert itself fails non-uniquely", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");
    const { sendEmail } = await import("@/lib/email");

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      id: "evt_dbdown",
      type: "invoice.payment_failed",
      data: {
        object: { customer: "cus_123", amount_due: 1000, currency: "usd" },
      },
    } as any);

    vi.mocked(prisma.stripeEvent.create).mockRejectedValue(
      new Error("db down"),
    );

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    expect(res.status).toBe(500);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not return 500 when the dunning email send fails (no replay)", async () => {
    const { stripe } = await import("@/lib/stripe");
    const { prisma } = await import("@/lib/prisma");
    const { sendEmail } = await import("@/lib/email");

    vi.mocked(stripe.webhooks.constructEvent).mockReturnValue({
      type: "invoice.payment_failed",
      data: {
        object: { customer: "cus_123", amount_due: 1000, currency: "usd" },
      },
    } as any);

    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "user123",
      email: "test@test.com",
      name: "Test User",
    } as any);
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("Resend down"));

    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const res = await POST(makeRequest("{}", "good-sig"));

    // Side-effect failures must not trigger a Stripe replay.
    expect(res.status).toBe(200);
  });
});

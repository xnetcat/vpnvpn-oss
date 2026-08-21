import { describe, it, expect, vi, beforeEach } from "vitest";
import { createContext } from "../init";
import { appRouter } from "../routers/_app";
import type { Session } from "next-auth";

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
}));

describe("Billing Router", () => {
  const mockSession: Session = {
    user: { id: "user123", email: "test@test.com", name: "Test User" },
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };

  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    subscription: {
      findFirst: vi.fn(),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { __resetRateLimits } = await import("@/lib/trpc/rateLimit");
    __resetRateLimits();
  });

  describe("billing.createCheckoutSession", () => {
    it("should create a checkout session", async () => {
      const { getSession } = await import("@/lib/auth");
      const { stripe } = await import("@/lib/stripe");

      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        email: "test@test.com",
        name: "Test User",
        stripeCustomerId: "cus_123",
      });

      vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({
        url: "https://checkout.stripe.com/pay/cs_test_123",
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.billing.createCheckoutSession({
        priceId: "price_123",
      });

      expect(result.url).toBe("https://checkout.stripe.com/pay/cs_test_123");
      expect(result.type).toBe("checkout");
      expect(stripe.checkout.sessions.create).toHaveBeenCalled();
    });

    it("returns a billing-portal session for an existing subscriber instead of a second checkout", async () => {
      const { getSession } = await import("@/lib/auth");
      const { stripe } = await import("@/lib/stripe");

      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        email: "test@test.com",
        name: "Test User",
        stripeCustomerId: "cus_123",
      });
      // Active subscription already on file for this user. `Once` so the
      // implementation doesn't leak into later tests (clearAllMocks only
      // clears call history, not mockResolvedValue implementations).
      mockPrisma.subscription.findFirst.mockResolvedValueOnce({
        id: "sub_db_1",
        userId: "user123",
        stripeSubscriptionId: "sub_stripe_1",
        status: "active",
      });

      vi.mocked(stripe.billingPortal.sessions.create).mockResolvedValue({
        url: "https://billing.stripe.com/session/portal_existing",
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.billing.createCheckoutSession({
        priceId: "price_pro_test",
      });

      // Portal URL is returned with the discriminator…
      expect(result).toEqual({
        url: "https://billing.stripe.com/session/portal_existing",
        type: "portal",
      });
      expect(stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
        customer: "cus_123",
        return_url: "http://localhost:3000/account",
      });
      // …and crucially, NO second Checkout subscription is ever created.
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("returns a portal session for a past_due subscriber too", async () => {
      const { getSession } = await import("@/lib/auth");
      const { stripe } = await import("@/lib/stripe");

      vi.mocked(getSession).mockResolvedValue(mockSession);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        stripeCustomerId: "cus_123",
      });
      mockPrisma.subscription.findFirst.mockResolvedValueOnce({
        id: "sub_db_2",
        userId: "user123",
        stripeSubscriptionId: "sub_stripe_2",
        status: "past_due",
      });
      vi.mocked(stripe.billingPortal.sessions.create).mockResolvedValue({
        url: "https://billing.stripe.com/session/portal_pastdue",
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.billing.createCheckoutSession({
        priceId: "price_basic_test",
      });

      expect(result.type).toBe("portal");
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    });

    it("should create Stripe customer if not exists", async () => {
      const { getSession } = await import("@/lib/auth");
      const { stripe } = await import("@/lib/stripe");

      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        email: "test@test.com",
        name: "Test User",
        stripeCustomerId: null,
      });

      vi.mocked(stripe.customers.create).mockResolvedValue({
        id: "cus_new",
      } as any);

      vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({
        url: "https://checkout.stripe.com/pay/cs_test_123",
      } as any);

      mockPrisma.user.update.mockResolvedValue({
        id: "user123",
        stripeCustomerId: "cus_new",
      });

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      await caller.billing.createCheckoutSession({
        priceId: "price_123",
      });

      expect(stripe.customers.create).toHaveBeenCalled();
      expect(mockPrisma.user.update).toHaveBeenCalled();
    });

    it("uses the yearly price ID when interval=year for a configured tier", async () => {
      const { getSession } = await import("@/lib/auth");
      const { stripe } = await import("@/lib/stripe");

      vi.mocked(getSession).mockResolvedValue(mockSession);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        email: "test@test.com",
        name: "Test User",
        stripeCustomerId: "cus_123",
      });
      vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({
        url: "https://checkout.stripe.com/pay/cs_test_year",
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      // Pass the BASIC monthly price ID; year interval should map to its yearly ID.
      const result = await caller.billing.createCheckoutSession({
        priceId: "price_basic_test",
        interval: "year",
      });

      expect(result.url).toBe("https://checkout.stripe.com/pay/cs_test_year");
      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: "price_basic_yearly_test", quantity: 1 }],
        }),
      );
    });

    it("rejects interval=year for a tier without a configured yearly price", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockSession);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        email: "test@test.com",
        name: "Test User",
        stripeCustomerId: "cus_123",
      });

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      // Enterprise has no yearly price configured in the test environment.
      await expect(
        caller.billing.createCheckoutSession({
          priceId: "price_enterprise_test",
          interval: "year",
        }),
      ).rejects.toThrow("Yearly billing is not available for this plan");
    });

    it("still uses the monthly price when interval=month (default behavior)", async () => {
      const { getSession } = await import("@/lib/auth");
      const { stripe } = await import("@/lib/stripe");

      vi.mocked(getSession).mockResolvedValue(mockSession);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        stripeCustomerId: "cus_123",
      });
      vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({
        url: "https://checkout.stripe.com/pay/cs_test_month",
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      await caller.billing.createCheckoutSession({
        priceId: "price_basic_test",
        interval: "month",
      });

      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          line_items: [{ price: "price_basic_test", quantity: 1 }],
        }),
      );
    });
  });

  describe("billing.createPortalSession", () => {
    it("should create a portal session", async () => {
      const { getSession } = await import("@/lib/auth");
      const { stripe } = await import("@/lib/stripe");

      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        email: "test@test.com",
        name: "Test User",
        stripeCustomerId: "cus_123",
      });

      vi.mocked(stripe.billingPortal.sessions.create).mockResolvedValue({
        url: "https://billing.stripe.com/session/portal_123",
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.billing.createPortalSession();

      expect(result.url).toBe("https://billing.stripe.com/session/portal_123");
    });

    it("should fail without Stripe customer", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        email: "test@test.com",
        name: "Test User",
        stripeCustomerId: null,
      });

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      await expect(caller.billing.createPortalSession()).rejects.toThrow(
        "No Stripe customer found",
      );
    });
  });

  describe("billing.listInvoices", () => {
    it("returns mapped invoices for a customer", async () => {
      const { getSession } = await import("@/lib/auth");
      const { stripe } = await import("@/lib/stripe");
      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        stripeCustomerId: "cus_123",
      });

      vi.mocked(stripe.invoices.list).mockResolvedValue({
        data: [
          {
            id: "in_1",
            number: "INV-1",
            status: "paid",
            amount_paid: 3000,
            amount_due: 3000,
            currency: "usd",
            created: 1700000000,
            hosted_invoice_url: "https://stripe.test/inv/1",
            invoice_pdf: "https://stripe.test/inv/1.pdf",
          },
        ],
      } as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.billing.listInvoices();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("in_1");
      expect(result[0].amountPaid).toBe(3000);
      expect(stripe.invoices.list).toHaveBeenCalledWith({
        customer: "cus_123",
        limit: 24,
      });
    });

    it("returns empty list when there is no Stripe customer", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.user.findUnique.mockResolvedValue({
        id: "user123",
        stripeCustomerId: null,
      });

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.billing.listInvoices();
      expect(result).toEqual([]);
    });
  });

  describe("billing.cancelSubscription", () => {
    it("sets cancel_at_period_end on the active subscription", async () => {
      const { getSession } = await import("@/lib/auth");
      const { stripe } = await import("@/lib/stripe");
      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: "sub_db_1",
        stripeSubscriptionId: "sub_stripe_1",
      });
      vi.mocked(stripe.subscriptions.update).mockResolvedValue({} as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.billing.cancelSubscription();

      expect(result.success).toBe(true);
      expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_stripe_1", {
        cancel_at_period_end: true,
      });
    });

    it("throws when no active subscription exists", async () => {
      const { getSession } = await import("@/lib/auth");
      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.subscription.findFirst.mockResolvedValue(null);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      await expect(caller.billing.cancelSubscription()).rejects.toThrow(
        "No active subscription found",
      );
    });
  });

  describe("billing.resumeSubscription", () => {
    it("clears cancel_at_period_end on the active subscription", async () => {
      const { getSession } = await import("@/lib/auth");
      const { stripe } = await import("@/lib/stripe");
      vi.mocked(getSession).mockResolvedValue(mockSession);

      mockPrisma.subscription.findFirst.mockResolvedValue({
        id: "sub_db_1",
        stripeSubscriptionId: "sub_stripe_1",
      });
      vi.mocked(stripe.subscriptions.update).mockResolvedValue({} as any);

      const ctx = await createContext();
      ctx.prisma = mockPrisma as any;
      ctx.session = mockSession;

      const caller = appRouter.createCaller(ctx);
      const result = await caller.billing.resumeSubscription();

      expect(result.success).toBe(true);
      expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_stripe_1", {
        cancel_at_period_end: false,
      });
    });
  });
});

import { z } from "zod";
import { router, protectedProcedure } from "../init";
import { rateLimit } from "../rateLimit";
import { TRPCError } from "@trpc/server";
import { stripe } from "@/lib/stripe";
import { TIERS, getTierFromPriceId } from "@/lib/tiers";
import { WEB_ENV } from "@/env";

export const billingRouter = router({
  createCheckoutSession: protectedProcedure
    .use(rateLimit({ name: "billing.createCheckoutSession", limit: 10 }))
    .input(
      z.object({
        priceId: z.string().optional(),
        interval: z.enum(["month", "year"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!WEB_ENV.STRIPE_SECRET_KEY) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stripe not configured",
        });
      }

      const monthlyPriceId = input.priceId || TIERS.pro.priceId;

      if (!monthlyPriceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No price ID provided",
        });
      }

      // Resolve the final price ID for the requested billing interval. Yearly
      // requires the tier to have a configured yearly price ID, otherwise we
      // reject rather than silently fall back to monthly.
      let priceId = monthlyPriceId;
      if (input.interval === "year") {
        const tier = getTierFromPriceId(monthlyPriceId);
        const yearlyPriceId = TIERS[tier].yearlyPriceId;
        if (!yearlyPriceId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Yearly billing is not available for this plan",
          });
        }
        priceId = yearlyPriceId;
      }

      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.userId },
      });

      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "User not found",
        });
      }

      // Existing subscribers must change plans through the billing portal.
      // Creating a second Checkout subscription would double-bill them, so we
      // return a portal session instead and let the client redirect there.
      const existingSubscription = await ctx.prisma.subscription.findFirst({
        where: {
          userId: ctx.userId,
          status: { in: ["active", "trialing", "past_due"] },
        },
        orderBy: { updatedAt: "desc" },
      });

      if (existingSubscription?.stripeSubscriptionId && user.stripeCustomerId) {
        const portal = await stripe.billingPortal.sessions.create({
          customer: user.stripeCustomerId,
          return_url: `${WEB_ENV.NEXTAUTH_URL}/account`,
        });
        return { url: portal.url, type: "portal" as const };
      }

      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email ?? undefined,
          name: user.name ?? undefined,
          metadata: { userId: user.id },
        });
        await ctx.prisma.user.update({
          where: { id: user.id },
          data: { stripeCustomerId: customer.id },
        });
        customerId = customer.id;
      }

      const baseUrl = WEB_ENV.NEXTAUTH_URL;
      const checkout = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        customer: customerId,
        success_url: `${baseUrl}/dashboard?checkout=success`,
        cancel_url: `${baseUrl}/pricing?checkout=cancelled`,
        allow_promotion_codes: true,
        metadata: { userId: ctx.userId },
      });

      if (!checkout.url) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "No checkout URL generated",
        });
      }

      return { url: checkout.url, type: "checkout" as const };
    }),

  createPortalSession: protectedProcedure
    .use(rateLimit({ name: "billing.createPortalSession", limit: 10 }))
    .mutation(async ({ ctx }) => {
      if (!WEB_ENV.STRIPE_SECRET_KEY) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stripe not configured",
        });
      }

      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.userId },
      });

      if (!user?.stripeCustomerId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No Stripe customer found",
        });
      }

      const baseUrl = WEB_ENV.NEXTAUTH_URL;
      const portal = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${baseUrl}/account`,
      });

      return { url: portal.url };
    }),

  // Payment history from Stripe for the current user.
  listInvoices: protectedProcedure.query(async ({ ctx }) => {
    if (!WEB_ENV.STRIPE_SECRET_KEY) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stripe not configured",
      });
    }

    const user = await ctx.prisma.user.findUnique({
      where: { id: ctx.userId },
    });

    if (!user?.stripeCustomerId) {
      // No Stripe customer yet → no payment history.
      return [];
    }

    const invoices = await stripe.invoices.list({
      customer: user.stripeCustomerId,
      limit: 24,
    });

    return invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amountPaid: inv.amount_paid,
      amountDue: inv.amount_due,
      currency: inv.currency,
      created: inv.created,
      hostedInvoiceUrl: inv.hosted_invoice_url,
      invoicePdf: inv.invoice_pdf,
    }));
  }),

  // Schedule cancellation at the end of the current billing period.
  cancelSubscription: protectedProcedure
    .use(rateLimit({ name: "billing.cancelSubscription", limit: 10 }))
    .mutation(async ({ ctx }) => {
      if (!WEB_ENV.STRIPE_SECRET_KEY) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stripe not configured",
        });
      }

      const subscription = await ctx.prisma.subscription.findFirst({
        where: {
          userId: ctx.userId,
          status: { in: ["active", "trialing"] },
        },
        orderBy: { updatedAt: "desc" },
      });

      if (!subscription?.stripeSubscriptionId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active subscription found",
        });
      }

      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });

      return { success: true };
    }),

  // Undo a scheduled cancellation.
  resumeSubscription: protectedProcedure
    .use(rateLimit({ name: "billing.resumeSubscription", limit: 10 }))
    .mutation(async ({ ctx }) => {
      if (!WEB_ENV.STRIPE_SECRET_KEY) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stripe not configured",
        });
      }

      const subscription = await ctx.prisma.subscription.findFirst({
        where: {
          userId: ctx.userId,
          status: { in: ["active", "trialing"] },
        },
        orderBy: { updatedAt: "desc" },
      });

      if (!subscription?.stripeSubscriptionId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "No active subscription found",
        });
      }

      await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: false,
      });

      return { success: true };
    }),
});

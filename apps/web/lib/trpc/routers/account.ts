import { router, protectedProcedure } from "../init";
import { rateLimit } from "../rateLimit";
import { z } from "zod";
import { stripe } from "@/lib/stripe";
import { revokePeersForUser } from "@/lib/controlPlane";
import { WEB_ENV } from "@/env";

export const accountRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userId;

    const [subscription, user, notificationPreferences] = await Promise.all([
      ctx.prisma.subscription.findFirst({
        where: { userId },
        orderBy: { updatedAt: "desc" },
      }),
      ctx.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true },
      }),
      ctx.prisma.notificationPreferences.findUnique({
        where: { userId },
      }),
    ]);

    return {
      subscription,
      user,
      notificationPreferences,
    };
  }),

  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(255).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;
      await ctx.prisma.user.update({
        where: { id: userId },
        data: { name: input.name ?? null },
      });
      return { success: true };
    }),

  updateNotifications: protectedProcedure
    .input(
      z.object({
        marketing: z.boolean(),
        transactional: z.boolean(),
        security: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;

      await ctx.prisma.notificationPreferences.upsert({
        where: { userId },
        update: {
          marketing: input.marketing,
          transactional: input.transactional,
          security: input.security,
        },
        create: {
          userId,
          marketing: input.marketing,
          transactional: input.transactional,
          security: input.security,
        },
      });

      return { success: true };
    }),

  // GDPR data export: return the user's data as a downloadable JSON object.
  exportData: protectedProcedure
    .use(rateLimit({ name: "account.exportData", limit: 5 }))
    .query(async ({ ctx }) => {
      const userId = ctx.userId;

      const [user, devices, subscriptions, notificationPreferences] =
        await Promise.all([
          ctx.prisma.user.findUnique({
            where: { id: userId },
            select: {
              id: true,
              name: true,
              email: true,
              emailVerified: true,
              image: true,
              role: true,
              stripeCustomerId: true,
              createdAt: true,
              updatedAt: true,
            },
          }),
          ctx.prisma.device.findMany({ where: { userId } }),
          ctx.prisma.subscription.findMany({ where: { userId } }),
          ctx.prisma.notificationPreferences.findUnique({ where: { userId } }),
        ]);

      return {
        exportedAt: new Date().toISOString(),
        profile: user,
        devices,
        subscriptions,
        notificationPreferences,
      };
    }),

  // GDPR account deletion: revoke VPN peers, cancel Stripe subscriptions, then
  // delete the user (DB cascades remove devices/subscriptions/sessions/etc.).
  deleteAccount: protectedProcedure
    .use(rateLimit({ name: "account.deleteAccount", limit: 3 }))
    .input(z.object({ confirm: z.literal(true) }))
    .mutation(async ({ ctx }) => {
      const userId = ctx.userId;

      const user = await ctx.prisma.user.findUnique({
        where: { id: userId },
        include: {
          subscriptions: {
            where: { status: { in: ["active", "trialing", "past_due"] } },
          },
        },
      });

      if (!user) {
        return { success: true };
      }

      // Revoke all VPN peers so access is cut off immediately. Best-effort: a
      // control-plane hiccup must not block account deletion.
      try {
        await revokePeersForUser(userId);
      } catch (err) {
        console.error("[account.deleteAccount] revoke peers failed", {
          userId,
          err,
        });
      }

      // Cancel any active Stripe subscriptions so the customer isn't billed
      // after deletion. Best-effort per subscription.
      if (WEB_ENV.STRIPE_SECRET_KEY) {
        for (const sub of user.subscriptions) {
          if (!sub.stripeSubscriptionId) continue;
          try {
            await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
          } catch (err) {
            console.error(
              "[account.deleteAccount] cancel subscription failed",
              {
                userId,
                subscriptionId: sub.stripeSubscriptionId,
                err,
              },
            );
          }
        }
      }

      // Delete the user; cascades clean up related rows.
      await ctx.prisma.user.delete({ where: { id: userId } });

      return { success: true };
    }),
});

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { prisma } from "@/lib/prisma";
import { revokePeersForUser } from "@/lib/controlPlane";
import { enforceDeviceLimitForUser } from "@/lib/deviceRevocation";
import { sendEmail } from "@/lib/email";
import {
  getTierFromPriceId,
  getTierConfig,
  TIERS,
  type Tier,
} from "@/lib/tiers";
import { WEB_ENV } from "@/env";

export const dynamic = "force-dynamic";

// Read the current-period-end timestamp robustly across Stripe API versions.
// In older versions it lives on the subscription object; in recent versions it
// moved to the subscription item. Guard both so currentPeriodEnd isn't silently
// null after an API-version bump.
function getCurrentPeriodEnd(sub: Stripe.Subscription): Date | null {
  const subLevel = (sub as unknown as { current_period_end?: number })
    .current_period_end;
  if (typeof subLevel === "number") {
    return new Date(subLevel * 1000);
  }
  const itemLevel = (
    sub.items?.data?.[0] as unknown as { current_period_end?: number }
  )?.current_period_end;
  if (typeof itemLevel === "number") {
    return new Date(itemLevel * 1000);
  }
  return null;
}

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = WEB_ENV.STRIPE_WEBHOOK_SECRET;
  if (!sig || !webhookSecret) {
    return NextResponse.json(
      { error: "Missing signature/secret" },
      { status: 400 },
    );
  }
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err: unknown) {
    const error = err as Error;
    return NextResponse.json(
      { error: `Webhook Error: ${error.message}` },
      { status: 400 },
    );
  }

  // Idempotency: record the event ID before processing. Stripe replays reuse
  // the same event ID, so a unique violation here means this event was already
  // handled — ack it without re-running side effects (emails would otherwise
  // be re-sent on replay). Retry interaction: when processing fails retryably
  // below, the row is deleted again before returning 500, so the Stripe retry
  // passes this insert and is processed normally.
  let dedupRecorded = false;
  if (event.id) {
    try {
      await prisma.stripeEvent.create({
        data: { id: event.id, type: event.type },
      });
      dedupRecorded = true;
      // Opportunistic retention: prune dedup rows past the replay horizon
      // (Stripe retries an event for at most ~3 days, so 30 days is amply
      // safe). Fire and forget — cleanup must never delay or fail the webhook.
      const retentionCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      void prisma.stripeEvent
        .deleteMany({ where: { createdAt: { lt: retentionCutoff } } })
        .catch(() => {});
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        // Already processed (or being processed by another instance).
        return NextResponse.json({ received: true, duplicate: true });
      }
      // The dedup store is unavailable — genuinely retryable.
      console.error("[webhook] failed to record event for dedup", {
        eventId: event.id,
        err,
      });
      return NextResponse.json(
        { error: "Webhook handler failed" },
        { status: 500 },
      );
    }
  }

  // Tracks whether a genuinely retryable failure occurred (e.g. the DB write of
  // subscription state). Side effects (emails, peer revoke) are best-effort and
  // must NOT cause Stripe to replay — replaying could double-apply state.
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const subscriptionId: string | undefined =
          typeof session.subscription === "string"
            ? session.subscription
            : (session.subscription as Stripe.Subscription | null)?.id;
        const customerId: string | undefined =
          typeof session.customer === "string" ? session.customer : undefined;
        const userId: string | undefined = session.metadata?.userId;
        if (!subscriptionId || !customerId) break;

        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const priceId = sub.items?.data?.[0]?.price?.id;
        const status = sub.status;
        const tier = priceId ? getTierFromPriceId(priceId) : "basic";
        const currentPeriodEnd = getCurrentPeriodEnd(sub);

        let user = null;
        if (userId) {
          user = await prisma.user.findUnique({ where: { id: userId } });
        }
        if (!user && customerId) {
          user = await prisma.user.findFirst({
            where: { stripeCustomerId: customerId },
          });
        }
        if (!user) {
          // A paid checkout we can't attribute to any user would otherwise
          // vanish silently — log loudly, but still ack so Stripe doesn't
          // replay an event we can never process.
          console.error("[webhook] no user found for event; dropping", {
            eventType: event.type,
            customerId,
            subscriptionId,
            metadataUserId: userId,
          });
          break;
        }

        // 1) Persist subscription state FIRST (retryable on failure).
        await prisma.subscription.upsert({
          where: { stripeSubscriptionId: subscriptionId },
          update: {
            status,
            priceId: priceId ?? "",
            tier,
            currentPeriodEnd: currentPeriodEnd ?? undefined,
            userId: user.id,
          },
          create: {
            userId: user.id,
            stripeSubscriptionId: subscriptionId,
            priceId: priceId ?? "",
            status,
            tier,
            currentPeriodEnd: currentPeriodEnd ?? undefined,
          },
        });

        // 2) Side effects — each isolated; failures don't trigger a replay.
        const isActive = status === "active" || status === "trialing";
        if (!isActive) {
          try {
            await revokePeersForUser(user.id);
          } catch (e) {
            console.error("[webhook] revoke peers after checkout failed", {
              userId: user.id,
              error: e,
            });
          }
          // Peers are revoked on the control plane; prune the excess DB device
          // rows down to the free-tier limit (1). Skip the per-device email —
          // a cancellation/lapse email is the right signal here.
          try {
            await enforceDeviceLimitForUser(user.id, TIERS.free.deviceLimit, {
              sendEmail: false,
            });
          } catch (e) {
            console.error("[webhook] prune devices after checkout failed", {
              userId: user.id,
              error: e,
            });
          }
        } else {
          // Active: if the chosen tier's device limit is below the user's
          // current device count, revoke the newest devices beyond the limit.
          try {
            await enforceDeviceLimitForUser(
              user.id,
              getTierConfig(tier).deviceLimit,
            );
          } catch (e) {
            console.error(
              "[webhook] enforce device limit after checkout failed",
              {
                userId: user.id,
                error: e,
              },
            );
          }
        }

        if (isActive && user.email) {
          try {
            const tierConfig = getTierConfig(tier);
            await sendEmail({
              to: user.email,
              template: "subscription_active",
              data: {
                name: user.name,
                plan: tierConfig.name,
                deviceLimit: tierConfig.deviceLimit.toString(),
                nextBillingDate: currentPeriodEnd?.toLocaleDateString(),
                dashboardUrl: `${WEB_ENV.NEXTAUTH_URL}/dashboard`,
              },
            });
          } catch (e) {
            console.error("[webhook] subscription_active email failed", {
              userId: user.id,
              error: e,
            });
          }
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subObj = event.data.object as Stripe.Subscription;
        const subscriptionId = subObj.id;
        const customerId: string | undefined =
          typeof subObj.customer === "string"
            ? subObj.customer
            : subObj.customer?.id;
        if (!customerId) break;

        const priceId = subObj.items?.data?.[0]?.price?.id;
        const status = subObj.status;
        const tier = priceId ? getTierFromPriceId(priceId) : "basic";
        const currentPeriodEnd = getCurrentPeriodEnd(subObj);

        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: customerId },
        });
        if (!user) {
          console.error("[webhook] no user found for event; dropping", {
            eventType: event.type,
            customerId,
            subscriptionId,
          });
          break;
        }

        // 1) Persist subscription state FIRST (retryable on failure).
        await prisma.subscription.upsert({
          where: { stripeSubscriptionId: subscriptionId },
          update: {
            status,
            priceId: priceId ?? "",
            tier,
            currentPeriodEnd: currentPeriodEnd ?? undefined,
            userId: user.id,
          },
          create: {
            userId: user.id,
            stripeSubscriptionId: subscriptionId,
            priceId: priceId ?? "",
            status,
            tier,
            currentPeriodEnd: currentPeriodEnd ?? undefined,
          },
        });

        // 2) Side effects — isolated, best-effort.
        const isActive = status === "active" || status === "trialing";
        if (!isActive) {
          try {
            await revokePeersForUser(user.id);
          } catch (e) {
            console.error("[webhook] revoke peers after sub update failed", {
              userId: user.id,
              error: e,
            });
          }

          // Peers revoked on the control plane; prune excess DB device rows to
          // the free-tier limit. No per-device email (the cancellation email
          // below covers the user-facing signal).
          try {
            await enforceDeviceLimitForUser(user.id, TIERS.free.deviceLimit, {
              sendEmail: false,
            });
          } catch (e) {
            console.error("[webhook] prune devices after sub update failed", {
              userId: user.id,
              error: e,
            });
          }

          if (user.email && event.type === "customer.subscription.deleted") {
            try {
              await sendEmail({
                to: user.email,
                template: "subscription_cancelled",
                data: {
                  name: user.name,
                  pricingUrl: `${WEB_ENV.NEXTAUTH_URL}/pricing`,
                },
              });
            } catch (e) {
              console.error("[webhook] subscription_cancelled email failed", {
                userId: user.id,
                error: e,
              });
            }
          }
        } else {
          // Active (e.g. plan downgrade pro→basic): revoke the newest devices
          // beyond the new tier's device limit, keeping the oldest registered.
          try {
            await enforceDeviceLimitForUser(
              user.id,
              getTierConfig(tier).deviceLimit,
            );
          } catch (e) {
            console.error(
              "[webhook] enforce device limit after sub update failed",
              {
                userId: user.id,
                error: e,
              },
            );
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId: string | undefined =
          typeof invoice.customer === "string"
            ? invoice.customer
            : invoice.customer?.id;
        if (!customerId) break;

        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: customerId },
        });
        if (!user?.email) break;

        // Dunning email — best-effort; a failed send must not trigger a replay.
        try {
          const amount =
            typeof invoice.amount_due === "number"
              ? new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: (invoice.currency || "usd").toUpperCase(),
                }).format(invoice.amount_due / 100)
              : undefined;
          await sendEmail({
            to: user.email,
            template: "payment_failed",
            data: {
              name: user.name,
              amount,
              billingUrl: `${WEB_ENV.NEXTAUTH_URL}/account`,
            },
          });
        } catch (e) {
          console.error("[webhook] payment_failed email failed", {
            userId: user.id,
            error: e,
          });
        }
        break;
      }
      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId: string | undefined =
          typeof invoice.customer === "string"
            ? invoice.customer
            : invoice.customer?.id;
        if (!customerId) break;

        // $0 invoices (free tier, trials, fully-discounted periods) get no
        // receipt — there is no payment to acknowledge.
        if (typeof invoice.amount_paid !== "number" || invoice.amount_paid <= 0)
          break;

        const user = await prisma.user.findFirst({
          where: { stripeCustomerId: customerId },
        });
        if (!user) {
          console.error("[webhook] no user found for event; dropping", {
            eventType: event.type,
            customerId,
          });
          break;
        }
        if (!user.email) break;

        // Receipt email — pure side effect, best-effort; a failed send must
        // not trigger a Stripe replay. Preference enforcement (transactional)
        // happens inside sendEmail.
        try {
          const amount = new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: (invoice.currency || "usd").toUpperCase(),
          }).format(invoice.amount_paid / 100);

          // Resolve the plan name: prefer the invoice line's price ID, fall
          // back to the subscription row we already persist.
          const linePriceId = (
            invoice.lines?.data?.[0] as
              | { price?: { id?: string } | null }
              | undefined
          )?.price?.id;
          let plan: string | undefined;
          if (linePriceId) {
            plan = getTierConfig(getTierFromPriceId(linePriceId)).name;
          } else {
            const subscriptionId: string | undefined =
              typeof invoice.subscription === "string"
                ? invoice.subscription
                : (invoice.subscription as Stripe.Subscription | null)?.id;
            if (subscriptionId) {
              const subRow = await prisma.subscription.findFirst({
                where: { stripeSubscriptionId: subscriptionId },
              });
              if (subRow?.tier) {
                plan = getTierConfig(subRow.tier as Tier).name;
              }
            }
          }

          await sendEmail({
            to: user.email,
            template: "payment_receipt",
            data: {
              name: user.name,
              amount,
              plan,
              invoiceNumber: invoice.number ?? undefined,
              hostedInvoiceUrl: invoice.hosted_invoice_url ?? undefined,
              invoicePdf: invoice.invoice_pdf ?? undefined,
              billingUrl: `${WEB_ENV.NEXTAUTH_URL}/account`,
            },
          });
        } catch (e) {
          console.error("[webhook] payment_receipt email failed", {
            userId: user.id,
            error: e,
          });
        }
        break;
      }
      default:
        break;
    }
  } catch (err) {
    // Reaching here means a non-isolated step failed (e.g. the DB upsert or a
    // Stripe API call). These are genuinely retryable, so ask Stripe to replay.
    console.error("[webhook] retryable error", err);
    // Clear the dedup record so the replay is not dropped as a duplicate.
    if (dedupRecorded && event.id) {
      try {
        await prisma.stripeEvent.delete({ where: { id: event.id } });
      } catch (delErr) {
        // Worst case: the retry will be acked as a duplicate and this event's
        // state change is lost until the next subscription event. Log loudly.
        console.error(
          "[webhook] failed to clear dedup record after retryable error; the Stripe retry will be treated as a duplicate",
          { eventId: event.id, delErr },
        );
      }
    }
    return NextResponse.json(
      { error: "Webhook handler failed" },
      { status: 500 },
    );
  }

  return NextResponse.json({ received: true });
}

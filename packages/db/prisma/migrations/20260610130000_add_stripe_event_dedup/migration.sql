-- Processed Stripe webhook events (idempotency / replay dedup). The webhook
-- handler inserts the event ID before processing; a unique violation means the
-- event was already handled, so Stripe replays are acked without re-running
-- side effects (e.g. transactional emails). Rows are removed again when
-- processing fails retryably, so Stripe's retry is processed normally.

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

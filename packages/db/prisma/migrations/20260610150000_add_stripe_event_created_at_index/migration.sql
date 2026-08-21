-- Index on StripeEvent.createdAt supporting retention cleanup: the webhook
-- handler opportunistically prunes dedup rows older than the replay horizon
-- (Stripe retries an event for at most ~3 days), keeping the table bounded.

-- CreateIndex
CREATE INDEX "StripeEvent_createdAt_idx" ON "StripeEvent"("createdAt");

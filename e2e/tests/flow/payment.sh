#!/usr/bin/env bash
# Production-flow phase 2: payment.
#
# Simulates Stripe activating a paid subscription by POSTing a correctly
# signed `customer.subscription.created` event (price -> tier "pro") to the
# web app's webhook endpoint. run-flow.sh then asserts the Subscription row
# (tier=pro, status=active) landed in Postgres.
set -euo pipefail
source /tests/flow/lib.sh

echo "[flow-payment] Activating pro subscription via signed Stripe webhook..."
send_subscription_webhook "customer.subscription.created" "active"
echo "[flow-payment] PASSED"

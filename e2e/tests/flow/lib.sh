#!/usr/bin/env bash
# Shared helpers for the production-flow E2E test (sourced by the phase
# scripts, executed inside the test-client container).
#
# Expects in the environment (exported by run-flow.sh via `compose exec -e`):
#   WEB_URL                 e.g. http://web:3000
#   CONTROL_PLANE_URL       e.g. http://control-plane:4000
#   API_KEY                 control-plane x-api-key
#   NODE_TOKEN              vpn-node bearer token (CONTROL_PLANE_BOOTSTRAP_TOKEN)
#   SERVER_ID               vpn-node server id (e2e-vpn-node)
#   SESSION_TOKEN           DB-seeded NextAuth session token (Bearer auth seam)
#   STRIPE_WEBHOOK_SECRET   secret the web app verifies webhook signatures with
#   STRIPE_PRICE_ID_PRO     price id that maps to tier "pro" in lib/tiers.ts
#   FLOW_CUSTOMER_ID        stripeCustomerId seeded on the test user
#   FLOW_SUB_ID             synthetic Stripe subscription id
#   STATE_DIR               writable dir shared with the host (/tests/flow/.state)

fail() {
    echo "[flow] ERROR: $*" >&2
    exit 1
}

# ---------------------------------------------------------------------------
# tRPC over HTTP (desktop-app seam): the web app honors DB-session Bearer
# tokens in apps/web/lib/trpc/init.ts. Procedures use the superjson
# transformer, so inputs are wrapped as {"json": <input>} and outputs live
# under .result.data.json.
# ---------------------------------------------------------------------------
trpc_call() { # $1 = procedure (e.g. device.register), $2 = JSON input
    curl -sS -X POST "$WEB_URL/api/trpc/$1" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $SESSION_TOKEN" \
        --data-binary "{\"json\":$2}"
}

trpc_data() { # $1 = raw tRPC response; prints .result.data.json or fails
    local resp="$1"
    if ! printf '%s' "$resp" | jq -e '.result.data.json' >/dev/null 2>&1; then
        echo "[flow] tRPC error response:" >&2
        printf '%s\n' "$resp" >&2
        return 1
    fi
    printf '%s' "$resp" | jq '.result.data.json'
}

# ---------------------------------------------------------------------------
# Stripe webhook seam: the web app verifies events with
# stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET). Stripe's
# v1 scheme is HMAC-SHA256(secret, "<timestamp>.<raw body>") sent as
# "Stripe-Signature: t=<timestamp>,v1=<hex hmac>", so a correctly-signed
# synthetic event needs no Stripe account at all.
#
# customer.subscription.* events are handled entirely from the payload (no
# Stripe API round-trip, unlike checkout.session.completed which calls
# stripe.subscriptions.retrieve), so they are the right vehicle for tests.
# ---------------------------------------------------------------------------
send_subscription_webhook() { # $1 = event type, $2 = subscription status
    local event_type="$1" status="$2"
    local ts period_end payload sig resp http_code body

    ts=$(date +%s)
    period_end=$((ts + 30 * 24 * 3600))

    payload=$(cat <<EOF
{
  "id": "evt_e2e_flow_${ts}",
  "object": "event",
  "api_version": "2024-06-20",
  "created": ${ts},
  "type": "${event_type}",
  "data": {
    "object": {
      "id": "${FLOW_SUB_ID}",
      "object": "subscription",
      "customer": "${FLOW_CUSTOMER_ID}",
      "status": "${status}",
      "current_period_end": ${period_end},
      "items": {
        "object": "list",
        "data": [
          {
            "id": "si_e2e_flow",
            "object": "subscription_item",
            "current_period_end": ${period_end},
            "price": { "id": "${STRIPE_PRICE_ID_PRO}", "object": "price" }
          }
        ]
      }
    }
  }
}
EOF
)

    sig=$(printf '%s.%s' "$ts" "$payload" \
        | openssl dgst -sha256 -hmac "$STRIPE_WEBHOOK_SECRET" \
        | awk '{print $NF}')

    resp=$(curl -sS -w '\n%{http_code}' -X POST "$WEB_URL/api/webhooks/stripe" \
        -H "Content-Type: application/json" \
        -H "Stripe-Signature: t=${ts},v1=${sig}" \
        --data-binary "$payload")
    http_code=$(printf '%s' "$resp" | tail -n1)
    body=$(printf '%s' "$resp" | sed '$d')

    if [ "$http_code" != "200" ]; then
        fail "webhook $event_type returned HTTP $http_code: $body"
    fi
    if ! printf '%s' "$body" | jq -e '.received == true' >/dev/null 2>&1; then
        fail "webhook $event_type was not acknowledged: $body"
    fi
    echo "[flow] webhook $event_type (status=$status) accepted by web app"
}

# Fetch the peer list the vpn-node itself syncs from the control plane
# (GET /server/peers, node bearer token).
node_synced_peers() {
    curl -sf -H "Authorization: Bearer $NODE_TOKEN" \
        "$CONTROL_PLANE_URL/server/peers?id=$SERVER_ID"
}

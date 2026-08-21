#!/bin/bash
# Provision a fresh Stripe sandbox for vpnVPN: products, prices, webhook
# endpoint, and billing-portal configuration, mirroring the canonical catalog.
#
# Sandbox CREATION is Dashboard-only (Stripe has no API for it):
#   Dashboard -> sandbox switcher (top-left) -> Create sandbox -> name it,
#   then in the new sandbox: Developers -> API keys -> copy the secret key.
#
# Usage:
#   STRIPE_NEW_KEY=sk_test_... bash scripts/provision-stripe-sandbox.sh [--webhook-url URL]
#
# Prints a ready-to-paste env block (price IDs, webhook signing secret).
# The webhook signing secret is shown ONCE here; it cannot be re-read later.
set -euo pipefail

KEY="${STRIPE_NEW_KEY:?Set STRIPE_NEW_KEY to the new sandbox secret key}"
WEBHOOK_URL="https://vpnvpn.dev/api/webhooks/stripe"
[ "${1:-}" = "--webhook-url" ] && WEBHOOK_URL="$2"

api() { curl -sS -u "$KEY:" "$@"; }
jqpy() { python3 -c "import json,sys;d=json.load(sys.stdin);$1"; }

guard=$(api https://api.stripe.com/v1/account | jqpy "print(d.get('id','ERR'))")
echo "# Provisioning sandbox account: $guard"
case "$KEY" in sk_test_*|rk_test_*) ;; *) echo "Refusing: key is not a test/sandbox key" >&2; exit 1;; esac

declare -a TIERS=("basic|vpn basic|basic access|1000" "pro|vpn pro|pro access|3000" "enterprise|vpn enterprise|enterprise access|100000")

ENV_OUT=""
declare -a CATALOG_ARGS=()
i=0
for t in "${TIERS[@]}"; do
  IFS='|' read -r tier name desc monthly <<< "$t"
  yearly=$((monthly * 10))   # yearly = 10x monthly ("2 months free")
  prod=$(api -X POST https://api.stripe.com/v1/products -d "name=$name" -d "description=$desc" | jqpy "print(d['id'])")
  pm=$(api -X POST https://api.stripe.com/v1/prices -d "product=$prod" -d "unit_amount=$monthly" -d "currency=usd" -d "recurring[interval]=month" | jqpy "print(d['id'])")
  py=$(api -X POST https://api.stripe.com/v1/prices -d "product=$prod" -d "unit_amount=$yearly" -d "currency=usd" -d "recurring[interval]=year" | jqpy "print(d['id'])")
  echo "# $name: $prod monthly=$pm yearly=$py"
  upper=$(echo "$tier" | tr '[:lower:]' '[:upper:]')
  ENV_OUT+="STRIPE_PRICE_ID_${upper}=${pm}\n"
  ENV_OUT+="STRIPE_PRICE_${upper}_YEARLY=${py}\n"
  CATALOG_ARGS+=(-d "features[subscription_update][products][$i][product]=$prod")
  CATALOG_ARGS+=(-d "features[subscription_update][products][$i][prices][0]=$pm")
  CATALOG_ARGS+=(-d "features[subscription_update][products][$i][prices][1]=$py")
  i=$((i+1))
done

wh=$(api -X POST https://api.stripe.com/v1/webhook_endpoints \
  -d "url=$WEBHOOK_URL" \
  -d "enabled_events[0]=checkout.session.completed" \
  -d "enabled_events[1]=customer.subscription.created" \
  -d "enabled_events[2]=customer.subscription.updated" \
  -d "enabled_events[3]=customer.subscription.deleted" \
  -d "enabled_events[4]=invoice.payment_failed" \
  -d "enabled_events[5]=invoice.payment_succeeded")
whsec=$(echo "$wh" | jqpy "print(d['secret'])")
echo "# webhook endpoint: $(echo "$wh" | jqpy "print(d['id'])") -> $WEBHOOK_URL"

# Billing portal: enable cancel, payment-method update, invoice history, and
# plan switching with prorations. `products` is REQUIRED when creating a new
# configuration with subscription_update enabled.
bpc=$(api "https://api.stripe.com/v1/billing_portal/configurations?is_default=true&limit=1" | jqpy "print(d['data'][0]['id'] if d.get('data') else '')")
PORTAL_ARGS=(
  -d "features[invoice_history][enabled]=true"
  -d "features[payment_method_update][enabled]=true"
  -d "features[subscription_cancel][enabled]=true"
  -d "features[subscription_cancel][mode]=at_period_end"
  -d "features[subscription_update][enabled]=true"
  -d "features[subscription_update][default_allowed_updates][0]=price"
  -d "features[subscription_update][proration_behavior]=create_prorations"
  "${CATALOG_ARGS[@]}"
  -d "business_profile[privacy_policy_url]=https://vpnvpn.dev/privacy"
  -d "business_profile[terms_of_service_url]=https://vpnvpn.dev/terms"
)
if [ -n "$bpc" ]; then
  api -X POST "https://api.stripe.com/v1/billing_portal/configurations/$bpc" "${PORTAL_ARGS[@]}" | jqpy "print('ERROR:',d['error']['message']) if 'error' in d else None"
else
  bpc=$(api -X POST "https://api.stripe.com/v1/billing_portal/configurations" "${PORTAL_ARGS[@]}" | jqpy "print(d['error']['message']) if 'error' in d else print(d['id'])")
fi
echo "# portal configuration: $bpc (plan switching enabled)"

echo
echo "# ---- env block (paste into Vercel production) ----"
echo "STRIPE_SECRET_KEY=$KEY"
echo "STRIPE_WEBHOOK_SECRET=$whsec"
printf "%b" "$ENV_OUT"

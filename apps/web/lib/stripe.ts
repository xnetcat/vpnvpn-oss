import Stripe from "stripe";
import { WEB_ENV } from "@/env";

let _stripe: Stripe | null = null;

export const stripe = new Proxy({} as Stripe, {
  get(_target, prop) {
    if (!_stripe) {
      _stripe = new Stripe(WEB_ENV.STRIPE_SECRET_KEY, {
        apiVersion: "2024-06-20",
      });
    }
    return (_stripe as any)[prop];
  },
});

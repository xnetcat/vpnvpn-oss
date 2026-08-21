export type Tier = "free" | "basic" | "pro" | "enterprise";

export interface TierConfig {
  name: string;
  price: number;
  priceId: string;
  yearlyPrice?: number;
  yearlyPriceId?: string;
  deviceLimit: number;
  features: string[];
}

import { WEB_ENV } from "@/env";

export const TIERS: Record<Tier, TierConfig> = {
  free: {
    name: "Free",
    price: 0,
    priceId: "",
    deviceLimit: 1,
    features: ["1 device", "Access to all servers", "Community support"],
  },
  basic: {
    name: "Basic",
    price: 10,
    priceId: WEB_ENV.STRIPE_PRICE_ID_BASIC,
    yearlyPrice: 100,
    yearlyPriceId: WEB_ENV.STRIPE_PRICE_BASIC_YEARLY,
    deviceLimit: 1,
    features: [
      "1 device",
      "Access to all servers",
      "Unlimited bandwidth",
      "Email support",
    ],
  },
  pro: {
    name: "Pro",
    price: 30,
    priceId: WEB_ENV.STRIPE_PRICE_ID_PRO,
    yearlyPrice: 300,
    yearlyPriceId: WEB_ENV.STRIPE_PRICE_PRO_YEARLY,
    deviceLimit: 5,
    features: [
      "5 devices",
      "Access to all servers",
      "Unlimited bandwidth",
      "Priority support",
      "Advanced metrics",
    ],
  },
  enterprise: {
    name: "Enterprise",
    price: 1000,
    priceId: WEB_ENV.STRIPE_PRICE_ID_ENTERPRISE,
    yearlyPrice: 10000,
    yearlyPriceId: WEB_ENV.STRIPE_PRICE_ENTERPRISE_YEARLY,
    deviceLimit: 999,
    features: [
      "Unlimited devices",
      "Access to all servers",
      "Unlimited bandwidth",
      "Dedicated support",
      "Advanced metrics",
      "Custom integrations",
    ],
  },
};

export type BillingInterval = "month" | "year";

export function getTierFromPriceId(priceId: string): Tier {
  for (const [tier, config] of Object.entries(TIERS)) {
    if (config.priceId === priceId) {
      return tier as Tier;
    }
    if (config.yearlyPriceId && config.yearlyPriceId === priceId) {
      return tier as Tier;
    }
  }
  console.error("[tiers] unknown Stripe price ID; falling back to basic", {
    priceId,
  });
  return "basic";
}

export function getTierConfig(tier: Tier): TierConfig {
  return TIERS[tier];
}

export function yearlyBillingEnabled(tier?: Tier): boolean {
  if (tier) {
    return Boolean(TIERS[tier].yearlyPriceId);
  }
  return Object.values(TIERS).some((config) => Boolean(config.yearlyPriceId));
}

import type { Metadata } from "next";
import { TIERS, yearlyBillingEnabled } from "@/lib/tiers";
import { getSession } from "@/lib/auth";
import PricingCards, { type PricingTier } from "@/components/PricingCards";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Simple VPN pricing: start free with 1 device, upgrade to Basic, Pro or Enterprise for more devices and priority support. Cancel anytime.",
};

export default async function PricingPage() {
  const session = await getSession();
  const isAuthed = Boolean((session?.user as any)?.id);

  const paidTiers: PricingTier[] = [
    TIERS.basic,
    TIERS.pro,
    TIERS.enterprise,
  ].map((tier) => ({
    name: tier.name,
    price: tier.price,
    priceId: tier.priceId,
    yearlyPrice: tier.yearlyPrice,
    yearlyEnabled: Boolean(tier.yearlyPriceId),
    features: tier.features,
  }));

  return (
    <main className="mx-auto max-w-7xl p-6 text-slate-50">
      <div className="mb-12 text-center">
        <h1 className="mb-4 text-4xl font-bold tracking-tight text-slate-50">
          Pricing that fits your rollout
        </h1>
        <p className="text-lg text-slate-400">
          Start free, upgrade when you need more. Cancel anytime.
        </p>
      </div>

      <PricingCards
        tiers={paidTiers}
        yearlyBillingEnabled={yearlyBillingEnabled()}
        isAuthed={isAuthed}
      />

      <div className="mt-12 text-center text-sm text-slate-500">
        <p>Cancel anytime. No add-on surprises.</p>
      </div>
    </main>
  );
}

"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import SubscribeButton from "@/components/SubscribeButton";

export interface PricingTier {
  name: string;
  price: number;
  priceId: string;
  yearlyPrice?: number;
  yearlyEnabled: boolean;
  features: string[];
}

export default function PricingCards({
  tiers,
  yearlyBillingEnabled,
  isAuthed,
}: {
  tiers: PricingTier[];
  yearlyBillingEnabled: boolean;
  isAuthed: boolean;
}) {
  const [interval, setInterval] = useState<"month" | "year">("month");

  return (
    <>
      {yearlyBillingEnabled && (
        <div className="mb-10 flex items-center justify-center gap-3">
          <span
            className={
              interval === "month" ? "text-slate-50" : "text-slate-400"
            }
          >
            Monthly
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={interval === "year"}
            aria-label="Toggle yearly billing"
            onClick={() =>
              setInterval((prev) => (prev === "month" ? "year" : "month"))
            }
            className="relative inline-flex h-6 w-11 items-center rounded-full bg-slate-700 transition-colors"
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-emerald-400 transition-transform ${
                interval === "year" ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
          <span
            className={interval === "year" ? "text-slate-50" : "text-slate-400"}
          >
            Yearly
          </span>
          <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-sm font-medium text-emerald-400">
            2 months free
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-4">
        {/* Free tier */}
        <div className="relative rounded-lg border border-slate-800 bg-slate-900/80 p-8 shadow-sm shadow-slate-900/40">
          <div className="text-center">
            <h2 className="mb-2 text-2xl font-semibold text-slate-50">Free</h2>
            <div className="mb-6">
              <span className="text-5xl font-bold text-slate-50">$0</span>
              <span className="text-slate-400">/month</span>
            </div>
          </div>

          <ul className="mb-8 space-y-4">
            {["1 device", "Access to all servers", "Community support"].map(
              (feature) => (
                <li key={feature} className="flex items-start gap-3">
                  <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                  <span className="text-slate-300">{feature}</span>
                </li>
              ),
            )}
          </ul>

          <a
            href={isAuthed ? "/dashboard" : "/auth/register"}
            className="block w-full rounded-md border border-slate-700 bg-slate-800 px-4 py-3 text-center font-medium text-slate-100 transition hover:bg-slate-700"
          >
            {isAuthed ? "Go to dashboard" : "Sign up free"}
          </a>
        </div>

        {/* Paid tiers */}
        {tiers.map((tier, idx) => {
          const isPopular = idx === 1;
          const showYearly =
            yearlyBillingEnabled && interval === "year" && tier.yearlyEnabled;
          const displayPrice =
            showYearly && tier.yearlyPrice != null
              ? tier.yearlyPrice
              : tier.price;
          const displayInterval = showYearly ? "year" : "month";
          return (
            <div
              key={tier.name}
              className={`relative rounded-lg border border-slate-800 bg-slate-900/80 p-8 shadow-sm shadow-slate-900/40 ${
                isPopular ? "ring-2 ring-emerald-500" : ""
              }`}
            >
              {isPopular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500 px-4 py-1 text-sm font-medium text-slate-950">
                  Most Popular
                </div>
              )}

              <div className="text-center">
                <h2 className="mb-2 text-2xl font-semibold text-slate-50">
                  {tier.name}
                </h2>
                <div className="mb-6">
                  <span className="text-5xl font-bold text-slate-50">
                    ${displayPrice}
                  </span>
                  <span className="text-slate-400">
                    /{showYearly ? "year" : "month"}
                  </span>
                  {showYearly && (
                    <div className="mt-1 text-sm font-medium text-emerald-400">
                      2 months free
                    </div>
                  )}
                </div>
              </div>

              <ul className="mb-8 space-y-4">
                {tier.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3">
                    <Check className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                    <span className="text-slate-300">{feature}</span>
                  </li>
                ))}
              </ul>

              <SubscribeButton
                priceId={tier.priceId}
                tierName={tier.name}
                isPopular={isPopular}
                interval={displayInterval}
                isAuthed={isAuthed}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

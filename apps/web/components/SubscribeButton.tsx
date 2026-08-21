"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { useRouter } from "next/navigation";

export default function SubscribeButton({
  priceId,
  tierName,
  isPopular,
  interval = "month",
  isAuthed = true,
}: {
  priceId: string;
  tierName: string;
  isPopular: boolean;
  interval?: "month" | "year";
  isAuthed?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState<"checkout" | "portal" | null>(
    null,
  );

  const signInUrl = `/auth/signin?callbackUrl=${encodeURIComponent("/pricing")}`;

  const createCheckout = trpc.billing.createCheckoutSession.useMutation({
    onSuccess: (data) => {
      setRedirecting(data.type);
      window.location.href = data.url;
    },
    onError: (error) => {
      // Session may have expired since the page rendered — send the user to
      // sign in and bring them back to pricing afterwards.
      if (error.data?.code === "UNAUTHORIZED") {
        router.push(signInUrl);
        return;
      }
      setError(`Failed to start checkout: ${error.message}`);
    },
  });

  const handleSubscribe = () => {
    setError(null);
    if (!isAuthed) {
      router.push(signInUrl);
      return;
    }
    createCheckout.mutate({ priceId, interval });
  };

  const busy = createCheckout.isPending || redirecting !== null;

  return (
    <div>
      <button
        type="button"
        onClick={handleSubscribe}
        disabled={busy}
        className={`w-full rounded-md px-4 py-3 font-medium transition disabled:opacity-50 ${
          isPopular
            ? "bg-emerald-500 text-slate-950 hover:bg-emerald-400"
            : "border border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700"
        }`}
        aria-label={`Subscribe to ${tierName}`}
      >
        {redirecting === "portal"
          ? "Opening billing portal..."
          : busy
            ? "Loading..."
            : "Get Started"}
      </button>
      {redirecting === "portal" && (
        <p className="mt-2 text-center text-xs text-slate-400">
          You already have a plan — manage it in the billing portal.
        </p>
      )}
      {error && (
        <p className="mt-2 text-center text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

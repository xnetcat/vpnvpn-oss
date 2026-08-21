"use client";

import { useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc/client";

function formatAmount(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

type Feedback = { kind: "success" | "error"; message: string } | null;

export default function BillingControls() {
  const [action, setAction] = useState<"cancel" | "resume" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const utils = trpc.useUtils();

  const invoices = trpc.billing.listInvoices.useQuery();

  const cancelSub = trpc.billing.cancelSubscription.useMutation({
    onSuccess: () => {
      setAction(null);
      setFeedback({
        kind: "success",
        message:
          "Your subscription will be cancelled at the end of the current billing period.",
      });
      utils.billing.listInvoices.invalidate();
    },
    onError: (error) => {
      setAction(null);
      setFeedback({
        kind: "error",
        message: `Failed to cancel subscription: ${error.message}`,
      });
    },
  });

  const resumeSub = trpc.billing.resumeSubscription.useMutation({
    onSuccess: () => {
      setAction(null);
      setFeedback({
        kind: "success",
        message: "Your subscription has been resumed.",
      });
      utils.billing.listInvoices.invalidate();
    },
    onError: (error) => {
      setAction(null);
      setFeedback({
        kind: "error",
        message: `Failed to resume subscription: ${error.message}`,
      });
    },
  });

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
      <h2 className="mb-4 text-lg font-semibold text-slate-50">
        Manage subscription
      </h2>

      {feedback && (
        <div
          role="status"
          className={`mb-4 rounded-md border px-4 py-3 text-sm ${
            feedback.kind === "success"
              ? "border-emerald-700 bg-emerald-500/10 text-emerald-200"
              : "border-rose-700 bg-rose-500/10 text-rose-200"
          }`}
        >
          {feedback.message}
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setFeedback(null);
            setAction("cancel");
            cancelSub.mutate();
          }}
          disabled={cancelSub.isPending}
          className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50"
        >
          {cancelSub.isPending && action === "cancel" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : null}
          Cancel at period end
        </button>
        <button
          type="button"
          onClick={() => {
            setFeedback(null);
            setAction("resume");
            resumeSub.mutate();
          }}
          disabled={resumeSub.isPending}
          className="inline-flex items-center gap-2 rounded-md border border-emerald-700 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/20 disabled:opacity-50"
        >
          {resumeSub.isPending && action === "resume" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : null}
          Resume subscription
        </button>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">
          Payment history
        </h3>
        <button
          type="button"
          onClick={() => invoices.refetch()}
          className="inline-flex items-center gap-1 text-xs text-slate-400 transition hover:text-slate-200"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${invoices.isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>

      {invoices.isLoading ? (
        <p className="text-sm text-slate-400">Loading payment history…</p>
      ) : invoices.data && invoices.data.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="min-w-full divide-y divide-slate-800 text-sm">
            <thead className="bg-slate-900/80 text-xs uppercase tracking-wide text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left">Date</th>
                <th className="px-4 py-2 text-left">Amount</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-right">Invoice</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {invoices.data.map((inv) => (
                <tr key={inv.id} className="text-slate-200">
                  <td className="px-4 py-2">
                    {new Date(inv.created * 1000).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2">
                    {formatAmount(
                      inv.amountPaid || inv.amountDue,
                      inv.currency,
                    )}
                  </td>
                  <td className="px-4 py-2 capitalize">{inv.status ?? "—"}</td>
                  <td className="px-4 py-2 text-right">
                    {inv.hostedInvoiceUrl ? (
                      <a
                        href={inv.hostedInvoiceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300"
                      >
                        View <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-400">No payment history yet.</p>
      )}
    </section>
  );
}

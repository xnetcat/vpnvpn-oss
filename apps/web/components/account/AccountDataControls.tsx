"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { AlertTriangle, Download, Loader2, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";

export default function AccountDataControls() {
  const [confirmText, setConfirmText] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);

  const exportData = trpc.account.exportData.useQuery(undefined, {
    enabled: false,
  });

  const deleteAccount = trpc.account.deleteAccount.useMutation({
    onSuccess: () => {
      // Sign the user out (clears the NextAuth JWT cookie via next-auth) then
      // send them home. The account row is already gone server-side.
      void signOut({ callbackUrl: "/" });
    },
    onError: (error) => {
      alert(`Failed to delete account: ${error.message}`);
    },
  });

  const handleExport = async () => {
    const result = await exportData.refetch();
    if (!result.data) {
      // Surface the server's message (e.g. the rate-limit "too many requests"
      // hint) so the user knows whether to retry now or wait.
      alert(
        result.error?.message ?? "Failed to export data. Please try again.",
      );
      return;
    }

    const blob = new Blob([JSON.stringify(result.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vpnvpn-account-export-${new Date()
      .toISOString()
      .slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDelete = () => {
    if (confirmText !== "DELETE") return;
    deleteAccount.mutate({ confirm: true });
  };

  return (
    <>
      {/* Data export */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
        <h2 className="mb-2 text-lg font-semibold text-slate-50">Your data</h2>
        <p className="mb-4 text-sm text-slate-400">
          Download a copy of all the data we hold about your account, including
          your profile, devices, subscriptions, and notification preferences.
        </p>
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={exportData.isFetching}
          className="inline-flex items-center gap-2 rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-700 disabled:opacity-50"
        >
          {exportData.isFetching ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          Export my data
        </button>
      </section>

      {/* Danger zone */}
      <section className="rounded-lg border border-rose-900/60 bg-rose-950/20 p-6 shadow-sm shadow-rose-950/40">
        <div className="mb-2 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-rose-400" />
          <h2 className="text-lg font-semibold text-rose-200">Danger zone</h2>
        </div>
        <p className="mb-4 text-sm text-rose-200/80">
          Deleting your account is permanent. We will revoke all VPN access,
          cancel any active subscription, and erase your data. This cannot be
          undone.
        </p>

        {!showConfirm ? (
          <button
            type="button"
            onClick={() => setShowConfirm(true)}
            className="inline-flex items-center gap-2 rounded-md border border-rose-500/50 bg-rose-500/10 px-4 py-2 text-sm font-medium text-rose-100 transition hover:bg-rose-500/20"
          >
            <Trash2 className="h-4 w-4" />
            Delete account
          </button>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm text-rose-200">
              Type <span className="font-mono font-semibold">DELETE</span> to
              confirm:
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="mt-1 block w-full rounded-md border border-rose-800 bg-slate-950 px-3 py-2 text-sm text-slate-50 shadow-sm focus:border-rose-500 focus:outline-none focus:ring-1 focus:ring-rose-500"
                placeholder="DELETE"
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleDelete}
                disabled={confirmText !== "DELETE" || deleteAccount.isPending}
                className="inline-flex items-center gap-2 rounded-md bg-rose-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {deleteAccount.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Permanently delete
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowConfirm(false);
                  setConfirmText("");
                }}
                className="rounded-md border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-slate-500"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

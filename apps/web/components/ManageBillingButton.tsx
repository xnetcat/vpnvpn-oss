"use client";

import { trpc } from "@/lib/trpc/client";

export default function ManageBillingButton() {
  const createPortal = trpc.billing.createPortalSession.useMutation({
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (error) => {
      alert(`Failed to open billing portal: ${error.message}`);
    },
  });

  const handleClick = () => {
    createPortal.mutate();
  };

  return (
    <button
      onClick={handleClick}
      disabled={createPortal.isPending}
      className="rounded-md bg-gray-900 px-4 py-2 text-white hover:bg-black disabled:opacity-50"
      aria-label="Manage billing"
    >
      {createPortal.isPending ? "Loading..." : "Manage billing"}
    </button>
  );
}

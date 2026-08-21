"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";

export default function RevokeDeviceButton({
  deviceId,
  deviceName,
}: {
  deviceId: string;
  deviceName: string;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const utils = trpc.useUtils();

  const revokeMutation = trpc.device.revoke.useMutation({
    onSuccess: () => {
      utils.device.list.invalidate();
      window.location.reload();
    },
    onError: (error) => {
      alert(`Failed to revoke device: ${error.message}`);
    },
  });

  const handleRevoke = async () => {
    try {
      await revokeMutation.mutateAsync({ deviceId });
    } finally {
      setShowConfirm(false);
    }
  };

  if (showConfirm) {
    return (
      <div className="inline-flex gap-2">
        <button
          onClick={handleRevoke}
          disabled={revokeMutation.isPending}
          className="text-red-600 hover:text-red-900 text-sm font-medium disabled:opacity-50"
        >
          {revokeMutation.isPending ? "Revoking..." : "Confirm"}
        </button>
        <button
          onClick={() => setShowConfirm(false)}
          disabled={revokeMutation.isPending}
          className="text-gray-600 hover:text-gray-900 text-sm font-medium"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setShowConfirm(true)}
      className="inline-flex items-center gap-1 text-red-600 hover:text-red-900"
      aria-label={`Revoke ${deviceName}`}
    >
      <Trash2 className="h-4 w-4" />
      <span className="text-sm font-medium">Revoke</span>
    </button>
  );
}

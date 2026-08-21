"use client";

import { Loader2, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";
import { trpc } from "@/lib/trpc/client";

type Props = {
  currentUserId: string;
};

export default function UserManagementTable({ currentUserId }: Props) {
  const utils = trpc.useUtils();
  const { data: users = [], isLoading } = trpc.admin.listUsers.useQuery();

  const updateRole = trpc.admin.updateUserRole.useMutation({
    onSuccess: () => utils.admin.listUsers.invalidate(),
    onError: (e) => alert(`Failed to update role: ${e.message}`),
  });

  const deleteUser = trpc.admin.deleteUser.useMutation({
    onSuccess: () => utils.admin.listUsers.invalidate(),
    onError: (e) => alert(`Failed to delete user: ${e.message}`),
  });

  const handleToggleRole = (id: string, role: string) => {
    const next = role === "admin" ? "user" : "admin";
    if (!confirm(`Change this user's role to "${next}"?`)) return;
    updateRole.mutate({ userId: id, role: next });
  };

  const handleDelete = (id: string, email: string | null) => {
    if (
      !confirm(
        `Permanently delete ${email ?? "this user"}? Their VPN access will be revoked and all data erased. This cannot be undone.`,
      )
    ) {
      return;
    }
    deleteUser.mutate({ userId: id });
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center text-slate-400">
        Loading users…
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/80 shadow-xl shadow-black/20 backdrop-blur">
      <table className="min-w-full divide-y divide-slate-800">
        <thead className="bg-slate-900/80">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
              Email
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
              Name
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
              Role
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
              Subscription
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
              Devices
            </th>
            <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-slate-400">
              Created
            </th>
            <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-slate-400">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800">
          {users.map((user) => {
            const isSelf = user.id === currentUserId;
            return (
              <tr key={user.id} className="bg-slate-950/40 hover:bg-slate-800/70">
                <td className="px-4 py-3 text-sm text-slate-100">
                  {user.email ?? "—"}
                </td>
                <td className="px-4 py-3 text-sm text-slate-200">
                  {user.name ?? "—"}
                </td>
                <td className="px-4 py-3 text-sm text-slate-200">{user.role}</td>
                <td className="px-4 py-3 text-sm text-slate-200">
                  {user.subscription
                    ? `${user.subscription.tier.toUpperCase()} • ${user.subscription.status}`
                    : "No subscription"}
                </td>
                <td className="px-4 py-3 text-sm text-slate-200">
                  {user.deviceCount}
                </td>
                <td className="px-4 py-3 text-sm text-slate-400">
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="inline-flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleToggleRole(user.id, user.role)}
                      disabled={isSelf || updateRole.isPending}
                      title={
                        isSelf
                          ? "You cannot change your own role"
                          : user.role === "admin"
                            ? "Demote to user"
                            : "Promote to admin"
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-slate-100 transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {user.role === "admin" ? (
                        <ShieldOff className="h-3.5 w-3.5" />
                      ) : (
                        <ShieldCheck className="h-3.5 w-3.5" />
                      )}
                      {user.role === "admin" ? "Make user" : "Make admin"}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(user.id, user.email)}
                      disabled={isSelf || deleteUser.isPending}
                      title={
                        isSelf ? "You cannot delete your own account" : "Delete user"
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-xs font-semibold text-rose-100 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {deleteUser.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
          {users.length === 0 && (
            <tr>
              <td
                colSpan={7}
                className="px-4 py-8 text-center text-sm text-slate-400"
              >
                No users found.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

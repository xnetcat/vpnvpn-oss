import { requireAdmin } from "@/lib/requireAdmin";
import { redirect } from "next/navigation";
import UserManagementTable from "@/components/admin/UserManagementTable";

export default async function AdminUsersPage() {
  const gate = await requireAdmin();
  if (!gate.ok) {
    redirect(gate.reason === "unauthenticated" ? "/api/auth/signin" : "/");
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 pb-10 pt-4 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
          Directory
        </p>
        <h1 className="text-2xl font-semibold text-slate-50">Users</h1>
        <p className="text-sm text-slate-400">
          Manage customers: change roles, review subscriptions and device
          counts, or remove accounts.
        </p>
      </div>

      <UserManagementTable currentUserId={gate.userId} />
    </main>
  );
}

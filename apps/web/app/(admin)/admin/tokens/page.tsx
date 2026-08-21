import { requireAdmin } from "@/lib/requireAdmin";
import { redirect } from "next/navigation";
import TokenList from "@/components/admin/TokenList";
import CreateTokenButton from "@/components/admin/CreateTokenButton";

export default async function AdminTokensPage() {
  const gate = await requireAdmin();
  if (!gate.ok) {
    redirect(gate.reason === "unauthenticated" ? "/api/auth/signin" : "/");
  }

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 pb-10 pt-4 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
            Tokens
          </p>
          <h1 className="text-2xl font-semibold text-slate-50">
            Server Tokens
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Manage registration tokens across all admins and system bootstrap
            tokens.
          </p>
        </div>
        <CreateTokenButton />
      </div>

      <TokenList />
    </main>
  );
}

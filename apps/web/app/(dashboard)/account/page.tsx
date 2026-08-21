import { requireUser } from "@/lib/requirePaidUser";
import { redirect } from "next/navigation";
import Link from "next/link";
import ManageBillingButton from "@/components/ManageBillingButton";
import BillingControls from "@/components/account/BillingControls";
import AccountDataControls from "@/components/account/AccountDataControls";
import { revalidatePath } from "next/cache";
import { createContext } from "@/lib/trpc/init";
import { appRouter } from "@/lib/trpc/routers/_app";

export default async function AccountPage() {
  const gate = await requireUser();
  if (!gate.ok) {
    redirect("/api/auth/signin");
  }

  const ctx = await createContext();
  const caller = appRouter.createCaller(ctx);
  const account = await caller.account.get();

  // The gate's tier is authoritative (free for non-subscribers). Only treat the
  // user as a paying subscriber when there is an active/trialing subscription.
  const isFreeTier = gate.tier === "free";

  async function updateProfile(formData: FormData) {
    "use server";

    const nameRaw = (formData.get("name") as string | null) ?? "";
    const name = nameRaw.trim() || null;

    const innerCtx = await createContext();
    const innerCaller = appRouter.createCaller(innerCtx);
    await innerCaller.account.updateProfile({ name });

    revalidatePath("/account");
  }

  async function updateNotifications(formData: FormData) {
    "use server";

    const marketing = formData.get("marketing") === "on";
    const transactional = formData.get("transactional") === "on";
    const security = formData.get("security") === "on";

    const innerCtx = await createContext();
    const innerCaller = appRouter.createCaller(innerCtx);
    await innerCaller.account.updateNotifications({
      marketing,
      transactional,
      security,
    });

    revalidatePath("/account");
  }

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-6 text-slate-50">
      <h1 className="mb-2 text-2xl font-semibold text-slate-50">
        Account &amp; Settings
      </h1>

      {/* Subscription */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
        <h2 className="mb-4 text-lg font-semibold text-slate-50">
          Subscription
        </h2>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-8">
            <div>
              <div className="text-sm text-slate-400">Plan</div>
              <div className="text-lg font-medium text-slate-50">
                {gate.tier.charAt(0).toUpperCase() + gate.tier.slice(1)}
              </div>
            </div>
            <div>
              <div className="text-sm text-slate-400">Status</div>
              <div className="text-lg font-medium capitalize text-slate-50">
                {isFreeTier
                  ? "Free"
                  : (account.subscription?.status ?? "unknown")}
              </div>
            </div>
            <div>
              <div className="text-sm text-slate-400">Renews</div>
              <div className="text-lg font-medium text-slate-50">
                {!isFreeTier && account.subscription?.currentPeriodEnd
                  ? new Date(
                      account.subscription.currentPeriodEnd,
                    ).toLocaleDateString()
                  : "—"}
              </div>
            </div>
          </div>
          {isFreeTier ? (
            <Link
              href="/pricing"
              className="inline-flex items-center justify-center rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-emerald-400"
            >
              Upgrade plan
            </Link>
          ) : (
            <ManageBillingButton />
          )}
        </div>
        {isFreeTier && (
          <p className="mt-4 text-sm text-slate-400">
            You&apos;re on the Free plan (1 device). Upgrade for more devices
            and priority support.
          </p>
        )}
      </section>

      {/* Billing management: cancel/resume + payment history (subscribers only) */}
      {!isFreeTier && <BillingControls />}

      {/* Profile */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
        <h2 className="mb-4 text-lg font-semibold text-slate-50">Profile</h2>
        <form action={updateProfile} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-200">
              Name
            </label>
            <input
              type="text"
              name="name"
              defaultValue={account.user?.name ?? ""}
              placeholder="Your name"
              className="mt-1 block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-50 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-200">
              Email
            </label>
            <div className="mt-1 text-sm text-slate-300">
              {account.user?.email ?? "Not set"}
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Email is managed by your identity provider (GitHub, Google, or
              magic link) and cannot be changed here.
            </p>
          </div>
          <button
            type="submit"
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400"
          >
            Save profile
          </button>
        </form>
      </section>

      {/* Notifications */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-6 shadow-sm shadow-slate-900/40">
        <h2 className="mb-4 text-lg font-semibold text-slate-50">
          Notification preferences
        </h2>
        <form action={updateNotifications} className="space-y-3">
          <label className="flex items-start gap-3 text-sm text-slate-200">
            <input
              type="checkbox"
              name="marketing"
              defaultChecked={
                account.notificationPreferences?.marketing ?? true
              }
              className="mt-1 h-4 w-4 rounded border-slate-700 text-emerald-500 focus:ring-emerald-500"
            />
            <span>
              Marketing updates{" "}
              <span className="text-slate-400">
                (occasional product announcements and changelogs)
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm text-slate-200">
            <input
              type="checkbox"
              name="transactional"
              defaultChecked={
                account.notificationPreferences?.transactional ?? true
              }
              className="mt-1 h-4 w-4 rounded border-slate-700 text-emerald-500 focus:ring-emerald-500"
            />
            <span>
              Transactional emails{" "}
              <span className="text-slate-400">
                (billing receipts, subscription changes, device added/removed)
              </span>
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm text-slate-200">
            <input
              type="checkbox"
              name="security"
              defaultChecked={account.notificationPreferences?.security ?? true}
              className="mt-1 h-4 w-4 rounded border-slate-700 text-emerald-500 focus:ring-emerald-500"
            />
            <span>
              Security alerts{" "}
              <span className="text-slate-400">
                (suspicious logins, abnormal VPN usage, and important security
                notices)
              </span>
            </span>
          </label>

          <button
            type="submit"
            className="mt-2 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400"
          >
            Save preferences
          </button>
        </form>
      </section>

      {/* Data export + account deletion */}
      <AccountDataControls />
    </main>
  );
}

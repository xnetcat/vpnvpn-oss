import { requireUser } from "@/lib/requirePaidUser";
import { redirect } from "next/navigation";
import { createContext } from "@/lib/trpc/init";
import { appRouter } from "@/lib/trpc/routers/_app";
import ServersTable, { type ServerRow } from "@/components/ServersTable";

async function getServers(): Promise<ServerRow[]> {
  const ctx = await createContext();
  const caller = appRouter.createCaller(ctx);
  const servers = await caller.servers.list();
  return servers;
}

export default async function ServersPage() {
  const gate = await requireUser();
  if (!gate.ok) {
    redirect("/api/auth/signin");
  }

  const servers = await getServers();

  return (
    <main className="mx-auto max-w-6xl space-y-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-50">Servers</h1>
        <p className="text-sm text-slate-400">
          Fleet health, regions, and live session load.
        </p>
      </div>
      <ServersTable servers={servers} />
    </main>
  );
}

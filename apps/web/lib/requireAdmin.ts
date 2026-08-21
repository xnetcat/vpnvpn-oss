import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";

export type AdminGateResult =
  | { ok: true; userId: string }
  | { ok: false; reason: "unauthenticated" | "forbidden" };

export async function requireAdmin(): Promise<AdminGateResult> {
  const session = await getSession();
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return { ok: false, reason: "unauthenticated" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user || user.role !== "admin") {
    return { ok: false, reason: "forbidden" };
  }

  return { ok: true, userId };
}

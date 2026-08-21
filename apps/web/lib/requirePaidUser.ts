import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/auth";
import { getTierConfig, type Tier } from "@/lib/tiers";

export type GateResult =
  | { ok: true; userId: string; tier: Tier; deviceLimit: number }
  | { ok: false; reason: "unauthenticated" };

/**
 * Dashboard access gate. Any authenticated user gets in:
 *  - admins → enterprise-level access (no subscription required),
 *  - subscribers → their subscription tier,
 *  - everyone else → the Free tier (1 device, all servers).
 *
 * Product decision: free, signed-up users can use the dashboard on the Free
 * tier and are nudged to upgrade. Only unauthenticated users are bounced.
 */
export const requireUser = async (): Promise<GateResult> => {
  const session = await getSession();
  const userId = (session?.user as any)?.id as string | undefined;
  if (!userId) return { ok: false, reason: "unauthenticated" };

  // Admin bypass: admins get enterprise-level access without a subscription.
  const role = (session?.user as any)?.role as string | undefined;
  if (role === "admin") {
    const tierConfig = getTierConfig("enterprise");
    return {
      ok: true,
      userId,
      tier: "enterprise",
      deviceLimit: tierConfig.deviceLimit,
    };
  }

  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: ["active", "trialing"] },
    },
  });

  // No active subscription → Free tier rather than a hard paywall.
  const tier = (sub?.tier || "free") as Tier;
  const tierConfig = getTierConfig(tier);

  return { ok: true, userId, tier, deviceLimit: tierConfig.deviceLimit };
};

/**
 * Backwards-compatible alias. Historically this redirected non-subscribers to
 * /pricing; it now resolves the Free tier instead. Kept so existing callers and
 * tests keep working.
 */
export const requirePaidUser = requireUser;

export const gateApiOr = async () => {
  const gate = await requireUser();
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason }, { status: 401 });
  }
  return null;
};

export const checkDeviceLimit = async (
  userId: string,
): Promise<{ canAdd: boolean; current: number; limit: number }> => {
  const gate = await requireUser();
  if (!gate.ok) {
    return { canAdd: false, current: 0, limit: 0 };
  }

  const deviceCount = await prisma.device.count({
    where: { userId },
  });

  return {
    canAdd: deviceCount < gate.deviceLimit,
    current: deviceCount,
    limit: gate.deviceLimit,
  };
};

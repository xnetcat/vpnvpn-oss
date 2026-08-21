"use server";

import { prisma } from "@/lib/prisma";
import { revokePeerByPublicKey } from "@/lib/controlPlane";
import { sendEmail } from "@/lib/email";
import { WEB_ENV } from "@/env";

/**
 * Enforce a device limit for a user by revoking the NEWEST-created devices
 * beyond `limit`. We keep the OLDEST registered devices (FIFO) — those are most
 * likely the user's primary, long-lived devices — and revoke the most recently
 * added ones.
 *
 * Each revocation mirrors the device.revoke tRPC mutation's path: best-effort
 * control-plane peer revocation, then DB delete, then a device_revoked email
 * (active devices only). Steps are isolated so a control-plane/email hiccup
 * never blocks DB cleanup.
 *
 * This composes with full cancellation (revokePeersForUser revokes peers on the
 * control plane but leaves DB rows): calling this with limit=1 after a
 * cancellation prunes the excess DB device rows too.
 *
 * Best-effort and idempotent: re-running after a partial failure simply revokes
 * whatever still exceeds the limit. Safe for the Stripe webhook's retry model.
 */
export async function enforceDeviceLimitForUser(
  userId: string,
  limit: number,
  opts: { sendEmail?: boolean } = {},
): Promise<{ revoked: number }> {
  const shouldEmail = opts.sendEmail ?? true;

  const devices = await prisma.device.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" }, // oldest first
  });

  if (devices.length <= limit) {
    return { revoked: 0 };
  }

  // Keep the oldest `limit` devices; revoke the rest (newest beyond the limit).
  const toRevoke = devices.slice(Math.max(0, limit));

  let user: { email: string | null; name: string | null } | null = null;
  if (shouldEmail) {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true },
    });
  }

  for (const device of toRevoke) {
    // 1) Best-effort control-plane peer revocation.
    try {
      await revokePeerByPublicKey(device.publicKey);
    } catch (err) {
      console.error("[deviceRevocation] control-plane revokePeer failed", {
        err,
        deviceId: device.id,
      });
    }

    // 2) Delete the DB record.
    await prisma.device.delete({ where: { id: device.id } });

    // 3) Notify the user (active devices only).
    if (shouldEmail && device.status !== "pending" && user?.email) {
      try {
        await sendEmail({
          to: user.email,
          template: "device_revoked",
          data: {
            name: user.name,
            deviceName: device.name,
            dashboardUrl: `${WEB_ENV.NEXTAUTH_URL}/devices`,
          },
        });
      } catch (err) {
        console.error("[deviceRevocation] device_revoked email failed", {
          err,
          deviceId: device.id,
        });
      }
    }
  }

  return { revoked: toRevoke.length };
}

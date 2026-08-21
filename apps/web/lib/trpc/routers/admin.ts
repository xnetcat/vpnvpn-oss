import { z } from "zod";
import { router, adminProcedure } from "../init";
import { TRPCError } from "@trpc/server";
import { revokePeersForUser } from "@/lib/controlPlane";
import { WEB_ENV } from "@/env";

function getControlPlaneConfig() {
  const base = WEB_ENV.CONTROL_PLANE_API_URL;
  const apiKey = WEB_ENV.CONTROL_PLANE_API_KEY;

  if (!base || !apiKey) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Control plane not configured",
    });
  }
  return { base: base.replace(/\/$/, ""), apiKey };
}

export const adminRouter = router({
  // Server management
  listServers: adminProcedure.query(async () => {
    const { base, apiKey } = getControlPlaneConfig();
    const url = `${base}/servers`;

    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[admin] GET /servers failed", {
        status: res.status,
        body: text,
      });
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch servers",
      });
    }

    const data = await res.json();
    return data || [];
  }),

  deleteServer: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { base, apiKey } = getControlPlaneConfig();
      const url = `${base}/servers/${encodeURIComponent(input.id)}`;

      const res = await fetch(url, {
        method: "DELETE",
        headers: { "x-api-key": apiKey },
      });

      if (res.status === 404) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Server not found",
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.error("[admin] DELETE /servers failed", {
          status: res.status,
          body: text,
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to delete server",
        });
      }

      return { status: "deleted" };
    }),

  // Token management
  listTokens: adminProcedure.query(async () => {
    const { base, apiKey } = getControlPlaneConfig();
    const url = `${base}/tokens`;

    const res = await fetch(url, {
      method: "GET",
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    });

    if (!res.ok) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch tokens",
      });
    }

    const data = await res.json();
    return data || [];
  }),

  createToken: adminProcedure
    .input(z.object({ label: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { base, apiKey } = getControlPlaneConfig();
      const url = `${base}/tokens`;

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ label: input.label }),
      });

      if (!res.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create token",
        });
      }

      const data = await res.json();
      return data;
    }),

  revokeToken: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const { base, apiKey } = getControlPlaneConfig();
      const url = `${base}/tokens/${encodeURIComponent(input.id)}`;

      const res = await fetch(url, {
        method: "DELETE",
        headers: { "x-api-key": apiKey },
      });

      if (!res.ok) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to revoke token",
        });
      }

      const data = await res.json();
      return data;
    }),

  // User management
  listUsers: adminProcedure.query(async ({ ctx }) => {
    const users = await ctx.prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        subscriptions: { orderBy: { updatedAt: "desc" }, take: 1 },
        devices: true,
      },
    });

    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt,
      deviceCount: u.devices.length,
      subscription: u.subscriptions[0]
        ? {
            tier: u.subscriptions[0].tier,
            status: u.subscriptions[0].status,
          }
        : null,
    }));
  }),

  updateUserRole: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        role: z.enum(["user", "admin"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Prevent an admin from demoting themselves (lockout protection).
      if (input.userId === ctx.userId && input.role !== "admin") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot remove your own admin role",
        });
      }

      await ctx.prisma.user.update({
        where: { id: input.userId },
        data: { role: input.role },
      });

      return { success: true };
    }),

  deleteUser: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      // Prevent an admin from deleting themselves (lockout protection).
      if (input.userId === ctx.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You cannot delete your own account from the admin panel",
        });
      }

      const user = await ctx.prisma.user.findUnique({
        where: { id: input.userId },
      });
      if (!user) {
        throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
      }

      // Revoke VPN peers first (best-effort) so access is cut immediately.
      try {
        await revokePeersForUser(input.userId);
      } catch (err) {
        console.error("[admin.deleteUser] revoke peers failed", {
          userId: input.userId,
          err,
        });
      }

      await ctx.prisma.user.delete({ where: { id: input.userId } });

      return { success: true };
    }),
});

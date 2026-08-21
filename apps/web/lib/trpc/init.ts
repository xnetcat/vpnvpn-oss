import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Session } from "next-auth";

export type Context = {
  session: Session | null;
  prisma: typeof prisma;
  req?: Request;
};

// Create context with optional request for Authorization header support
export const createContext = async (opts?: {
  req?: Request;
}): Promise<Context> => {
  const req = opts?.req;

  // Check for Authorization header first (desktop app)
  if (req) {
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);

      // Look up the session in the database
      const dbSession = await prisma.session.findUnique({
        where: { sessionToken: token },
        include: { user: true },
      });

      if (dbSession && dbSession.expires > new Date()) {
        // Create a NextAuth-compatible session object
        const session: Session = {
          user: {
            id: dbSession.user.id,
            role: (dbSession.user as any).role ?? "user",
            email: dbSession.user.email ?? undefined,
            name: dbSession.user.name ?? undefined,
            image: dbSession.user.image ?? undefined,
          } as any,
          expires: dbSession.expires.toISOString(),
        };

        return {
          session,
          prisma,
          req,
        };
      }
    }
  }

  // Fall back to NextAuth session (cookie-based)
  const session = await getSession();
  return {
    session,
    prisma,
    req,
  };
};

export const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

// Authenticated procedure
export const protectedProcedure = t.procedure.use(async (opts) => {
  const { ctx } = opts;
  if (!ctx.session?.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const userId = (ctx.session.user as any).id;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return opts.next({
    ctx: {
      ...ctx,
      userId,
    },
  });
});

// Paid user procedure
export const paidProcedure = protectedProcedure.use(async (opts) => {
  const { ctx } = opts;

  // Admin bypass: admins get enterprise-level access without a subscription
  const role = (ctx.session?.user as any)?.role;
  if (role === "admin") {
    return opts.next({
      ctx: {
        ...ctx,
        subscription: null,
        tier: "enterprise" as const,
      },
    });
  }

  const subscription = await ctx.prisma.subscription.findFirst({
    where: {
      userId: ctx.userId,
      status: { in: ["active", "trialing"] },
    },
  });

  // No subscription → free tier (1 device, all servers)
  if (!subscription) {
    return opts.next({
      ctx: {
        ...ctx,
        subscription: null,
        tier: "free" as const,
      },
    });
  }

  const tier = (subscription.tier || "basic") as "basic" | "pro" | "enterprise";

  return opts.next({
    ctx: {
      ...ctx,
      subscription,
      tier,
    },
  });
});

// Admin procedure
export const adminProcedure = protectedProcedure.use(async (opts) => {
  const { ctx } = opts;
  const user = await ctx.prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { role: true },
  });

  if (!user || user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }

  return opts.next({
    ctx: {
      ...ctx,
      isAdmin: true,
    },
  });
});

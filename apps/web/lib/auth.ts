import { PrismaAdapter } from "@auth/prisma-adapter";
import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import EmailProvider from "next-auth/providers/email";
import { getServerSession } from "next-auth";
import { prisma } from "@vpnvpn/db";
import { createDesktopCode } from "@/lib/desktopCodes";
import { stripe } from "@/lib/stripe";
import { WEB_ENV } from "@/env";

let _authOptions: NextAuthOptions | null = null;
function buildAuthOptions(): NextAuthOptions {
  if (_authOptions) return _authOptions;
  _authOptions = {
  adapter: PrismaAdapter(prisma),
  providers: [
    GitHubProvider({
      clientId: WEB_ENV.GITHUB_ID,
      clientSecret: WEB_ENV.GITHUB_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    GoogleProvider({
      clientId: WEB_ENV.GOOGLE_CLIENT_ID,
      clientSecret: WEB_ENV.GOOGLE_CLIENT_SECRET,
      allowDangerousEmailAccountLinking: true,
    }),
    EmailProvider({
      server: WEB_ENV.EMAIL_SERVER || "",
      from: WEB_ENV.EMAIL_FROM,
      async sendVerificationRequest({ identifier, url }) {
        try {
          let desktopUrl: string | undefined;
          let desktopCode: string | undefined;
          try {
            const parsed = new URL(url);
            const callbackUrlParam = parsed.searchParams.get("callbackUrl");
            const isDesktopFlow =
              callbackUrlParam &&
              decodeURIComponent(callbackUrlParam).includes("/desktop");
            if (isDesktopFlow) {
              const wrapped = encodeURIComponent(url);
              desktopUrl = `vpnvpn://auth/email-callback?next=${wrapped}`;
              desktopCode = await createDesktopCode(identifier, url);
            }
          } catch {}
          const { sendEmail } = await import("@/lib/email");
          await sendEmail({
            to: identifier,
            template: "magic_link",
            data: { url, desktopUrl, desktopCode },
          });
        } catch (error) {
          console.error("[auth] failed to send magic link email via Resend", { identifier, url, error });
          throw new Error("Failed to send magic link email");
        }
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as any).id;
        const dbUser = await prisma.user.findUnique({ where: { id: (user as any).id }, select: { role: true } });
        token.role = dbUser?.role ?? "user";
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token) {
        (session.user as any).id = token.id ?? token.sub;
        (session.user as any).role = token.role ?? "user";
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      try {
        const existing = await prisma.user.findUnique({ where: { id: user.id } });
        if (!existing) return;
        if (!existing.stripeCustomerId && WEB_ENV.STRIPE_SECRET_KEY) {
          const customer = await stripe.customers.create({
            email: existing.email ?? undefined,
            name: existing.name ?? undefined,
            metadata: { userId: existing.id },
          });
          await prisma.user.update({ where: { id: existing.id }, data: { stripeCustomerId: customer.id } });
        }
        if (existing.email) {
          const { sendEmail } = await import("@/lib/email");
          await sendEmail({
            to: existing.email,
            template: "welcome",
            data: { name: existing.name, dashboardUrl: `${WEB_ENV.NEXTAUTH_URL}/dashboard` },
          });
        }
      } catch (err) {
        console.error("createUser event error", err);
      }
    },
  },
  pages: { signIn: "/auth/signin", error: "/auth/signin" },
  secret: WEB_ENV.NEXTAUTH_SECRET,
  };
  return _authOptions;
}

export const authOptions: NextAuthOptions = new Proxy({} as NextAuthOptions, {
  get(_target, prop) { return (buildAuthOptions() as any)[prop]; },
  ownKeys() { return Reflect.ownKeys(buildAuthOptions()); },
  getOwnPropertyDescriptor(_target, prop) {
    const desc = Object.getOwnPropertyDescriptor(buildAuthOptions(), prop);
    if (desc) desc.configurable = true;
    return desc;
  },
  has(_target, prop) { return prop in buildAuthOptions(); },
});

export const getSession = () => getServerSession(authOptions);

import { vi, beforeEach } from "vitest";

// Set test environment variables
process.env.CONTROL_PLANE_API_URL = "https://api.test.com";
process.env.CONTROL_PLANE_API_KEY = "test-api-key";
process.env.NEXTAUTH_URL = "http://localhost:3000";
process.env.NEXTAUTH_SECRET = "nextauth_secret_test";
process.env.STRIPE_SECRET_KEY = "sk_test_123";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.STRIPE_PRICE_ID_BASIC = "price_basic_test";
process.env.STRIPE_PRICE_ID_PRO = "price_pro_test";
process.env.STRIPE_PRICE_ID_ENTERPRISE = "price_enterprise_test";
// Yearly price IDs are configured for basic & pro in tests, but intentionally
// UNSET for enterprise so the "yearly not configured" path is covered. The
// delete guards against a value leaking in from the repo .env via dotenv.
process.env.STRIPE_PRICE_BASIC_YEARLY = "price_basic_yearly_test";
process.env.STRIPE_PRICE_PRO_YEARLY = "price_pro_yearly_test";
delete process.env.STRIPE_PRICE_ENTERPRISE_YEARLY;
// Rate limiting must use the in-memory store in tests (the Redis path is
// covered with a stubbed client) — guard against a REDIS_URL from the repo .env.
delete process.env.REDIS_URL;
process.env.DESKTOP_BUCKET_URL = "https://bucket.test";
process.env.ENVIRONMENT = "staging";
process.env.EMAIL_FROM = "test@vpnvpn.dev";
process.env.RESEND_API_KEY = "re_test_123";
process.env.GITHUB_ID = "gh_id_test";
process.env.GITHUB_SECRET = "gh_secret_test";
process.env.GOOGLE_CLIENT_ID = "google_id_test";
process.env.GOOGLE_CLIENT_SECRET = "google_secret_test";

// Mock Prisma Client
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    subscription: {
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    stripeEvent: {
      create: vi.fn(),
      delete: vi.fn(),
      // Retention cleanup is fire-and-forget (`.catch()` chained), so the
      // mock must return a promise rather than undefined.
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    device: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
  },
}));

// Mock Stripe
vi.mock("@/lib/stripe", () => ({
  stripe: {
    customers: {
      create: vi.fn(),
    },
    checkout: {
      sessions: {
        create: vi.fn(),
      },
    },
    billingPortal: {
      sessions: {
        create: vi.fn(),
      },
    },
    subscriptions: {
      retrieve: vi.fn(),
      update: vi.fn(),
      cancel: vi.fn(),
    },
    invoices: {
      list: vi.fn(),
    },
    webhooks: {
      constructEvent: vi.fn(),
    },
  },
}));

// Mock Next.js server functions
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  useSearchParams: vi.fn(() => ({
    get: vi.fn(),
  })),
  usePathname: vi.fn(() => "/"),
}));

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = {
  desktopLoginCode: {
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  session: {
    create: vi.fn(),
  },
};

vi.mock("@vpnvpn/db", () => ({
  prisma: mockPrisma,
}));

function makeRequest(body: unknown) {
  return new Request("https://example.com/api/auth/otp/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("OTP verify per-code brute-force lockout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects and increments attempts on a wrong code", async () => {
    mockPrisma.desktopLoginCode.findFirst.mockResolvedValue({
      id: "c1",
      code: "123456",
      attempts: 1,
    });
    mockPrisma.desktopLoginCode.update.mockResolvedValue({});

    const { POST } = await import("@/app/api/auth/otp/verify/route");
    const res = await POST(
      makeRequest({ email: "user@test.com", code: "000000" }),
    );

    expect(res.status).toBe(401);
    expect(mockPrisma.desktopLoginCode.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { attempts: { increment: 1 } },
    });
  });

  it("rejects a correct code once the candidate is locked out", async () => {
    mockPrisma.desktopLoginCode.findFirst.mockResolvedValue({
      id: "c1",
      code: "123456",
      attempts: 5,
    });

    const { POST } = await import("@/app/api/auth/otp/verify/route");
    const res = await POST(
      makeRequest({ email: "user@test.com", code: "123456" }),
    );

    expect(res.status).toBe(401);
    // No state change once locked out.
    expect(mockPrisma.desktopLoginCode.update).not.toHaveBeenCalled();
  });

  it("rejects when no candidate code exists", async () => {
    mockPrisma.desktopLoginCode.findFirst.mockResolvedValue(null);

    const { POST } = await import("@/app/api/auth/otp/verify/route");
    const res = await POST(
      makeRequest({ email: "user@test.com", code: "123456" }),
    );

    expect(res.status).toBe(401);
  });
});

describe("OTP verify success path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a Bearer session token and sets NO session cookie", async () => {
    // NextAuth runs the JWT session strategy, so a raw DB session token under
    // the NextAuth cookie name could never be decoded by getServerSession —
    // it would only trick the middleware's cookie-presence check. Regression
    // guard: the success response must not set any cookie.
    mockPrisma.desktopLoginCode.findFirst.mockResolvedValue({
      id: "c1",
      code: "123456",
      attempts: 0,
    });
    mockPrisma.desktopLoginCode.update.mockResolvedValue({});
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "user123",
      email: "user@test.com",
      name: "Test User",
      emailVerified: new Date(),
    });
    mockPrisma.session.create.mockResolvedValue({});

    const { POST } = await import("@/app/api/auth/otp/verify/route");
    const res = await POST(
      makeRequest({ email: "user@test.com", code: "123456" }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.sessionToken).toBe("string");
    expect(body.sessionToken.length).toBeGreaterThan(0);
    expect(body.user.id).toBe("user123");

    // The session is created server-side for Bearer auth…
    expect(mockPrisma.session.create).toHaveBeenCalled();
    // …but no cookie is ever written.
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

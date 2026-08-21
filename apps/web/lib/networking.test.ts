import { describe, it, expect, vi } from "vitest";
import {
  allocateDeviceIp,
  firstFreeHostIndex,
  hostIndexOfIp,
  ipFromIndex,
  poolHostCount,
  type DeviceAllocatorPrisma,
} from "./networking";

describe("pool math", () => {
  it("counts hosts for a prefix", () => {
    expect(poolHostCount(24)).toBe(256);
    expect(poolHostCount(16)).toBe(65536);
    expect(poolHostCount(30)).toBe(4);
  });

  it("round-trips ip <-> index within the pool", () => {
    expect(ipFromIndex("10.8.0.0", 5)).toBe("10.8.0.5");
    expect(ipFromIndex("10.8.0.0", 256)).toBe("10.8.1.0");
    expect(hostIndexOfIp("10.8.0.5/32")).toBe(5);
    expect(hostIndexOfIp("10.8.0.5")).toBe(5);
  });

  it("rejects IPs outside the pool", () => {
    expect(hostIndexOfIp("192.168.0.1/32")).toBeNull();
    expect(hostIndexOfIp("not-an-ip")).toBeNull();
  });
});

describe("firstFreeHostIndex", () => {
  it("starts at .2 (skips network .0 and server .1)", () => {
    expect(firstFreeHostIndex(new Set())).toBe(2);
  });

  it("skips used indexes", () => {
    expect(firstFreeHostIndex(new Set([2, 3, 4]))).toBe(5);
  });

  it("returns null when the pool is exhausted", () => {
    // /30 has 4 addresses; usable host index range is just {2}.
    expect(firstFreeHostIndex(new Set(), 30)).toBe(2);
    expect(firstFreeHostIndex(new Set([2]), 30)).toBeNull();
  });
});

describe("allocateDeviceIp", () => {
  function makePrisma(
    initial: Record<string, string | null>
  ): { prisma: DeviceAllocatorPrisma; store: Record<string, string | null> } {
    const store = { ...initial };
    const prisma: DeviceAllocatorPrisma = {
      device: {
        findUnique: vi.fn(async ({ where }) => ({
          assignedIp: store[where.id] ?? null,
        })),
        findMany: vi.fn(async () => {
          // All non-null assigned IPs are considered on the same server here.
          return Object.values(store)
            .filter((ip): ip is string => ip != null)
            .map((assignedIp) => ({ assignedIp }));
        }),
        update: vi.fn(async ({ where, data }) => {
          // Enforce uniqueness like the DB constraint.
          if (Object.values(store).includes(data.assignedIp)) {
            throw { code: "P2002" };
          }
          store[where.id] = data.assignedIp;
          return {};
        }),
      },
    };
    return { prisma, store };
  }

  it("allocates the lowest free /32", async () => {
    const { prisma } = makePrisma({ "dev-1": null });
    const ip = await allocateDeviceIp(prisma, {
      serverId: "s1",
      deviceId: "dev-1",
    });
    expect(ip).toBe("10.8.0.2/32");
  });

  it("gives distinct IPs to distinct devices on the same server", async () => {
    const { prisma } = makePrisma({ "dev-1": null, "dev-2": null });
    const ip1 = await allocateDeviceIp(prisma, {
      serverId: "s1",
      deviceId: "dev-1",
    });
    const ip2 = await allocateDeviceIp(prisma, {
      serverId: "s1",
      deviceId: "dev-2",
    });
    expect(ip1).not.toBe(ip2);
    expect(ip1).toBe("10.8.0.2/32");
    expect(ip2).toBe("10.8.0.3/32");
  });

  it("reuses an existing allocation (idempotent)", async () => {
    const { prisma } = makePrisma({ "dev-1": "10.8.0.42/32" });
    const ip = await allocateDeviceIp(prisma, {
      serverId: "s1",
      deviceId: "dev-1",
    });
    expect(ip).toBe("10.8.0.42/32");
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it("retries past a taken slot (unique-constraint race)", async () => {
    const { prisma, store } = makePrisma({ "dev-1": null });
    // Simulate a concurrent allocation grabbing .2 between our read and write.
    const realUpdate = prisma.device.update;
    let first = true;
    prisma.device.update = vi.fn(
      async (args: { where: { id: string }; data: { assignedIp: string } }) => {
        if (first) {
          first = false;
          store["other"] = "10.8.0.2/32"; // someone else took .2
          throw { code: "P2002" };
        }
        return realUpdate(args);
      }
    );
    const ip = await allocateDeviceIp(prisma, {
      serverId: "s1",
      deviceId: "dev-1",
    });
    expect(ip).toBe("10.8.0.3/32");
  });
});

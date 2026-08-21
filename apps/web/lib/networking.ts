/**
 * Device tunnel-IP allocation.
 *
 * Each device gets a unique /32 from the VPN address pool. Allocation is
 * transactional and backed by a UNIQUE(serverId, assignedIp) constraint on the
 * Device table, so two devices on the same node can never receive the same IP
 * (the previous hash-into-/24 scheme had no collision detection and started
 * colliding after ~20 devices).
 *
 * Pool: 10.8.0.0/24 by default, matching the vpn-server WireGuard interface
 * (10.8.0.1/<prefix>). .1 is reserved for the server. This yields up to ~253
 * devices PER server (uniqueness is per-server, so different nodes reuse the
 * same space independently). To grow beyond that, widen BOTH this prefix and
 * the server's wg interface prefix together (e.g. to /16 → ~65k hosts/node).
 */

export const VPN_POOL_BASE = "10.8.0.0";
export const VPN_POOL_PREFIX = 24;
/** Host index reserved for the server's own wg interface (10.8.0.1). */
export const VPN_SERVER_HOST_INDEX = 1;

/** Total addresses in a pool of the given prefix (includes network+broadcast). */
export function poolHostCount(prefix: number): number {
  return 2 ** (32 - prefix);
}

function ipToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  return (
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    (parts[3] >>> 0)
  );
}

function intToIp(value: number): string {
  const v = value >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
}

/** Dotted IP for a host index within the pool (index 0 = network address). */
export function ipFromIndex(baseIp: string, index: number): string {
  return intToIp((ipToInt(baseIp) + index) >>> 0);
}

/** Host index of an IP within the pool, or null if outside it. May include /cidr. */
export function hostIndexOfIp(
  ip: string,
  baseIp: string = VPN_POOL_BASE,
  prefix: number = VPN_POOL_PREFIX
): number | null {
  const bare = ip.split("/")[0].trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return null;
  const index = (ipToInt(bare) - ipToInt(baseIp)) >>> 0;
  if (index < 0 || index >= poolHostCount(prefix)) return null;
  return index;
}

/**
 * First free host index in [2, lastUsable], skipping the network (.0),
 * broadcast (last), and the reserved server host (.1). Returns null when full.
 */
export function firstFreeHostIndex(
  used: Set<number>,
  prefix: number = VPN_POOL_PREFIX
): number | null {
  const total = poolHostCount(prefix);
  const lastUsable = total - 2; // exclude broadcast (total-1) and network (0)
  for (let i = VPN_SERVER_HOST_INDEX + 1; i <= lastUsable; i += 1) {
    if (!used.has(i)) return i;
  }
  return null;
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

// Minimal structural type so this stays unit-testable with a mock and doesn't
// hard-depend on the generated PrismaClient.
export interface DeviceAllocatorPrisma {
  device: {
    findUnique: (args: {
      where: { id: string };
      select: { assignedIp: true; serverId?: true };
    }) => Promise<{ assignedIp: string | null } | null>;
    findMany: (args: {
      where: { serverId: string; assignedIp: { not: null } };
      select: { assignedIp: true };
    }) => Promise<Array<{ assignedIp: string | null }>>;
    update: (args: {
      where: { id: string };
      data: { assignedIp: string };
    }) => Promise<unknown>;
  };
}

/**
 * Allocate (or reuse) a unique /32 for a device on a given server.
 *
 * The device row must already exist with its serverId set. If it already has an
 * assignedIp, that value is reused (idempotent). Otherwise the lowest free host
 * in the pool is claimed via an UPDATE guarded by the UNIQUE(serverId,
 * assignedIp) constraint, retrying on the race where two devices pick the same
 * free slot concurrently.
 */
export async function allocateDeviceIp(
  prisma: DeviceAllocatorPrisma,
  params: { serverId: string; deviceId: string }
): Promise<string> {
  const { serverId, deviceId } = params;

  const existing = await prisma.device.findUnique({
    where: { id: deviceId },
    select: { assignedIp: true },
  });
  if (existing?.assignedIp) return existing.assignedIp;

  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const rows = await prisma.device.findMany({
      where: { serverId, assignedIp: { not: null } },
      select: { assignedIp: true },
    });

    const used = new Set<number>();
    for (const row of rows) {
      if (!row.assignedIp) continue;
      const idx = hostIndexOfIp(row.assignedIp);
      if (idx != null) used.add(idx);
    }

    const freeIndex = firstFreeHostIndex(used);
    if (freeIndex == null) {
      throw new Error(
        `VPN address pool exhausted for server ${serverId} (pool ${VPN_POOL_BASE}/${VPN_POOL_PREFIX})`
      );
    }

    const ip = `${ipFromIndex(VPN_POOL_BASE, freeIndex)}/32`;
    try {
      await prisma.device.update({
        where: { id: deviceId },
        data: { assignedIp: ip },
      });
      return ip;
    } catch (err) {
      // Lost the race for this slot; recompute the used set and retry.
      if (isUniqueConstraintError(err)) continue;
      throw err;
    }
  }

  throw new Error("Failed to allocate a unique device IP after retries");
}

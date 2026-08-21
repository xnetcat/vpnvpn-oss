-- Security + scaling hardening migration.
--
-- 1. Per-server unique device IP allocation (replaces the collision-prone
--    hash-into-/24 scheme in apps/web/lib/networking.ts).
-- 2. Hot-path / online-window indexes.
-- 3. Metrics retention index.
-- 4. Desktop/OTP code brute-force lockout counter.
-- 5. Hash VPN node bearer tokens at rest (no plaintext tokens in the DB).

-- ---------------------------------------------------------------------------
-- 1. Device.assignedIp + per-server uniqueness
-- ---------------------------------------------------------------------------
ALTER TABLE "Device" ADD COLUMN "assignedIp" TEXT;
CREATE UNIQUE INDEX "Device_serverId_assignedIp_key" ON "Device"("serverId", "assignedIp");

-- ---------------------------------------------------------------------------
-- 2. Hot-path indexes
-- ---------------------------------------------------------------------------
-- Nodes poll GET /server/peers filtering on (serverId, active) every sync tick.
CREATE INDEX "VpnPeer_serverId_active_idx" ON "VpnPeer"("serverId", "active");
-- /servers and /metrics/targets filter servers by their online window.
CREATE INDEX "VpnServer_lastSeen_idx" ON "VpnServer"("lastSeen");

-- ---------------------------------------------------------------------------
-- 3. Metrics retention
-- ---------------------------------------------------------------------------
CREATE INDEX "VpnMetric_timestamp_idx" ON "VpnMetric"("timestamp");

-- ---------------------------------------------------------------------------
-- 4. Desktop/OTP login-code brute-force lockout
-- ---------------------------------------------------------------------------
ALTER TABLE "DesktopLoginCode" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 5. Hash VPN node tokens at rest
-- ---------------------------------------------------------------------------
-- pgcrypto provides digest() (sha256) and gen_random_uuid().
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "VpnToken" ADD COLUMN "id" TEXT;
ALTER TABLE "VpnToken" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "VpnToken" ADD COLUMN "tokenPrefix" TEXT;

-- Backfill: derive id, hash, and display prefix from the existing plaintext
-- token. The hash MUST match the control-plane's
-- crypto.createHash("sha256").update(token).digest("hex").
UPDATE "VpnToken" SET
  "id" = COALESCE("id", gen_random_uuid()::text),
  "tokenHash" = encode(digest("token", 'sha256'), 'hex'),
  "tokenPrefix" = substr("token", 1, 8)
WHERE "tokenHash" IS NULL;

ALTER TABLE "VpnToken" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "VpnToken" ALTER COLUMN "tokenHash" SET NOT NULL;
ALTER TABLE "VpnToken" ALTER COLUMN "tokenPrefix" SET NOT NULL;

-- Swap the primary key from the (now removed) plaintext token to id.
ALTER TABLE "VpnToken" DROP CONSTRAINT "VpnToken_pkey";
ALTER TABLE "VpnToken" ADD CONSTRAINT "VpnToken_pkey" PRIMARY KEY ("id");
CREATE UNIQUE INDEX "VpnToken_tokenHash_key" ON "VpnToken"("tokenHash");

ALTER TABLE "VpnToken" DROP COLUMN "token";

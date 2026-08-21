-- Add per-server connection fields
ALTER TABLE "VpnServer"
  ADD COLUMN "wgEndpoint" TEXT,
  ADD COLUMN "wgPort" INTEGER,
  ADD COLUMN "ovpnEndpoint" TEXT,
  ADD COLUMN "ovpnPort" INTEGER,
  ADD COLUMN "ovpnCaBundle" TEXT,
  ADD COLUMN "ovpnPeerFingerprint" TEXT,
  ADD COLUMN "ikev2Remote" TEXT;


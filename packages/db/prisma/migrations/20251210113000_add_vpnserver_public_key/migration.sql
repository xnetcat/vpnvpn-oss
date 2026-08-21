-- Add WireGuard server public key storage
ALTER TABLE "VpnServer" ADD COLUMN "publicKey" TEXT;

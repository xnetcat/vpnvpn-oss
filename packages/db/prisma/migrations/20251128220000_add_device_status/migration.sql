-- AlterTable: Add status and lastConnectedAt fields to Device
ALTER TABLE "Device" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "Device" ADD COLUMN "lastConnectedAt" TIMESTAMP(3);

-- CreateIndex: Index on status for faster queries
CREATE INDEX "Device_status_idx" ON "Device"("status");

-- Update existing devices to be "active" (they were already confirmed before this migration)
UPDATE "Device" SET "status" = 'active' WHERE "status" = 'pending';


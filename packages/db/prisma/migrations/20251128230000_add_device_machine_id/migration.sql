-- AlterTable: Add machineId field to Device
ALTER TABLE "Device" ADD COLUMN "machineId" TEXT;

-- CreateIndex: Index on userId + machineId for fast lookup
CREATE INDEX "Device_userId_machineId_idx" ON "Device"("userId", "machineId");









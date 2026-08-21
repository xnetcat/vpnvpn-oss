/*
  Warnings:

  - A unique constraint covering the columns `[username]` on the table `VpnPeer` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "VpnPeer" ADD COLUMN     "password" TEXT,
ADD COLUMN     "username" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "VpnPeer_username_key" ON "VpnPeer"("username");

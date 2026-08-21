-- Per-peer cumulative transfer samples pushed by VPN nodes alongside VpnMetric.
-- Raw cumulative-since-daemon-start counters; consumers compute reset-aware
-- deltas. No FK to VpnServer so ingestion never races registration and usage
-- history survives server deletion.

-- CreateTable
CREATE TABLE "PeerMetric" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "publicKey" TEXT,
    "username" TEXT,
    "rxBytes" BIGINT NOT NULL,
    "txBytes" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PeerMetric_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PeerMetric_serverId_timestamp_idx" ON "PeerMetric"("serverId", "timestamp");

-- CreateIndex
CREATE INDEX "PeerMetric_timestamp_idx" ON "PeerMetric"("timestamp");

-- CreateIndex
CREATE INDEX "PeerMetric_publicKey_timestamp_idx" ON "PeerMetric"("publicKey", "timestamp");

-- CreateIndex
CREATE INDEX "PeerMetric_username_timestamp_idx" ON "PeerMetric"("username", "timestamp");

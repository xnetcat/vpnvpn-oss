-- Add cumulative tunnel throughput counters (bytes) to VPN metrics so the
-- public transparency dashboard can report data served by the fleet. Nullable
-- so existing rows and nodes that do not report them remain valid.
ALTER TABLE "VpnMetric" ADD COLUMN "egressBytes" DOUBLE PRECISION;
ALTER TABLE "VpnMetric" ADD COLUMN "ingressBytes" DOUBLE PRECISION;

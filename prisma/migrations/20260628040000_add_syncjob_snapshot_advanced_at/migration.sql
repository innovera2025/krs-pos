-- Migration: add_syncjob_snapshot_advanced_at (krs-sync — write-back snapshot advance)
-- Additive only. One nullable column. No backfill, no constraint changes, no other table
-- alterations. Existing rows default snapshotAdvancedAt to NULL.
--
-- Purpose: the outbound dispatcher stamps this EXACTLY ONCE (guarded by `IS NULL`) when a
-- cash sale's write-back stock-cut is reflected into the global KrsStockSnapshot
-- (warehouseCode=''), so the next inbound auto-sync does not re-apply the KRS on-hand drop
-- as a fresh negative delta (which would double-count an already-decremented Product.stock).

-- AlterTable: exactly-once guard for the write-back's global snapshot advance.
ALTER TABLE "SyncJob" ADD COLUMN "snapshotAdvancedAt" TIMESTAMP(3);

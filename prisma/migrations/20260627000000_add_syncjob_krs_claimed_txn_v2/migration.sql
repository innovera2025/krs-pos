-- Migration: add_syncjob_krs_claimed_txn_v2 (krs-sync P0 — burned-anchor idempotency)
-- Additive only. One nullable column + one new enum value. No backfill, no constraint
-- changes, no other table alterations. Existing rows default krsClaimedTxnNo to NULL.

-- AlterTable: burned SaleInvoiceTrNo anchor for crash-window reclaim detection.
ALTER TABLE "SyncJob" ADD COLUMN "krsClaimedTxnNo" TEXT;

-- AlterEnum: NEEDS_RECONCILE — burned anchor held but existence check persistently
-- fails; operator must reconcile before re-entry (NOT auto-claimable).
ALTER TYPE "SyncJobStatus" ADD VALUE 'NEEDS_RECONCILE';

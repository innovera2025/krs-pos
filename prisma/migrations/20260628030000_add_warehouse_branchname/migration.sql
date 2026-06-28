-- Migration: add_warehouse_branchname (Branch/Warehouse program, Phase 4)
-- Additive only. One new nullable column on the POS "Warehouse" master holding the
-- real KRS Branch.BranchName (resolved via the KRS `Warehouse w LEFT JOIN Branch b
-- ON b.BranchCode = w.BranchCode` join). Lets checkout scope a cash sale's KRS
-- documents to the logged-in cashier's branch by its display name. No existing
-- table altered beyond this additive column; no backfill, no constraint changes.

-- AlterTable
ALTER TABLE "Warehouse" ADD COLUMN "branchName" TEXT;

-- Migration: add_warehouse_master (Branch/Warehouse program, Phase 1)
-- Additive only. One new table mirroring the KRS dbo.Warehouse master. No existing
-- table altered, no backfill, no constraint changes on other models. Existing flows
-- (checkout, stock, auth, product/stock) are untouched.

-- CreateTable
CREATE TABLE "Warehouse" (
    "warehouseCode" TEXT NOT NULL,
    "warehouseName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("warehouseCode")
);

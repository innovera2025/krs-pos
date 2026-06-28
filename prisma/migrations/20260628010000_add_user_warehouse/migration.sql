-- Migration: add_user_warehouse (Branch/Warehouse program, Phase 2)
-- Additive only. Adds a nullable "warehouseCode" column to "User" — the user's
-- assigned KRS WarehouseCode (e.g. "WH01"). No backfill, no FK, no constraint: the
-- users API validates the value against the Warehouse master on every write. The
-- branch is DERIVED from the Warehouse table for display — branchCode is never
-- stored here. Existing flows (checkout, stock, auth, session) are untouched; the
-- column is inert downstream until Phase 3+.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "warehouseCode" TEXT;

-- Migration: add_warehouse_stock (Branch/Warehouse program, Phase 5 — DISPLAY-ONLY)
--
-- Two changes:
--  1. NEW table "WarehouseStock" — per-(sku, warehouseCode) last-seen KRS on-hand,
--     rounded + floored >= 0, RAW KRS (not POS-sale-adjusted). Read by GET
--     /api/products to scope the product grid's stock badge to the logged-in user's
--     warehouse. Purely additive.
--  2. "KrsStockSnapshot" primary key migrated from a single key ("itemCode") to a
--     COMPOSITE key ("itemCode", "warehouseCode"). NO DATA LOSS — a new
--     "warehouseCode" column is added with DEFAULT '' (the all-warehouse sentinel
--     the prior single-key global engine implicitly used), so every existing row is
--     preserved and keeps participating in the existing global delta pass unchanged.
--     The lock sentinel row becomes (itemCode = '__LOCK__', warehouseCode = '').

-- CreateTable
CREATE TABLE "WarehouseStock" (
    "sku" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarehouseStock_pkey" PRIMARY KEY ("sku","warehouseCode")
);

-- CreateIndex: GET /api/products filters WarehouseStock by warehouseCode alone; the
-- composite PK (sku LEADING) can't serve it, so index warehouseCode to avoid a seq scan.
CREATE INDEX "WarehouseStock_warehouseCode_idx" ON "WarehouseStock"("warehouseCode");

-- AlterTable: KrsStockSnapshot single PK -> composite PK (no data loss)
ALTER TABLE "KrsStockSnapshot" ADD COLUMN "warehouseCode" TEXT NOT NULL DEFAULT '';
ALTER TABLE "KrsStockSnapshot" DROP CONSTRAINT "KrsStockSnapshot_pkey";
ALTER TABLE "KrsStockSnapshot" ADD CONSTRAINT "KrsStockSnapshot_pkey" PRIMARY KEY ("itemCode","warehouseCode");

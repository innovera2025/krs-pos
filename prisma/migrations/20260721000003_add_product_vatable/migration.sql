-- Migration: add_product_vatable (per-item-vat program — POS-side per-item VAT)
--
-- ADDITIVE only: one new defaulted BOOLEAN column on "Product" and one on "OrderItem".
-- No backfill and no destructive change — every existing row reads vatable = true, which
-- preserves the CURRENT uniform 7%-inclusive behavior exactly (all lines treated
-- VAT-applicable). Hand-authored (mirrors 20260721000002_add_orderitem_reward) for the
-- local DDL-less app-role fallback.
--
-- MONEY INVARIANT: VAT is INCLUSIVE, so this flag NEVER changes a bill's total — it only
-- changes the tax/ex-VAT SPLIT. `Product.vatable` = the KRS InventoryItem.itemvat flag
-- ("คิดภาษี" → true, "ไม่คิดภาษี" → false); `OrderItem.vatable` = the EFFECTIVE VAT
-- treatment snapshotted at sale time (false ONLY when VAT was actually not charged on
-- that line). Both DEFAULT true so pre-existing rows and every flag-off sale stay
-- byte-identical to today. The whole feature is dormant until PER_ITEM_VAT_ENABLED flips.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "vatable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "OrderItem" ADD COLUMN "vatable" BOOLEAN NOT NULL DEFAULT true;

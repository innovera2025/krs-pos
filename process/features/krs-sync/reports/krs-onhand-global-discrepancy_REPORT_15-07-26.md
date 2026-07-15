# KRS sp_Onhand global-vs-warehouse discrepancy — incident + patch (15-07-26)

**Status:** PATCHED on prod (data-level). Root cause is KRS-side, pending vendor. ⛔ **Do NOT run
the manual sync-stock (absolute overwrite) in the Data Flow tab until the vendor fixes sp_Onhand —
it would zero the patched stock back out.**

## Symptom
Shop (สาขาสุไหงโก-ลก, WH03) could add items to cart but checkout failed with สต็อกไม่เพียงพอ
(INSUFFICIENT_STOCK). Example bill: Yummy Bites F01-0217 ×3 + Pramy F14-0662 ×1.

## Root cause
KRS `sp_Onhand` is **internally inconsistent**: the all-warehouse call (`@Warehouse=NULL`) returned
**0** for items where the warehouse-scoped call (`@Warehouse='WH03'`) returned real stock
(F01-0217: global 0 vs WH03 **52**). Some items are consistent (F14-0662: 8 = 8).

- POS checkout guards/decrements the **global** `Product.stock`, fed by the global sp_Onhand result
  → 0 → unsellable. The product grid shows the **per-warehouse** mirror (`WarehouseStock`) for
  warehouse-assigned users → stock visible → cart allows adding. Hence the mismatch UX.
- **667 of ~972 products** were affected (global 0, warehouse sum > 0).
- The auto-sync delta engine was NOT at fault: it faithfully mirrored the (wrong) global answer
  every run (`updated 0, skipped 972, delta 0`).

## Patch applied (prod, 2026-07-15 ~07:28 UTC, backup first: `backups/krs-pos-20260715-072800.dump`)
One transaction, superuser psql inside the db container:

1. `Product.stock += ROUND(Σ WarehouseStock.qty − global KrsStockSnapshot.lastQty)` capped to int,
   only where `Σ warehouse > global baseline` (667 rows, +13,644 units).
2. Global snapshot baseline (`KrsStockSnapshot` rows with `warehouseCode = ''`) set to the same
   warehouse sum — **this is what makes the patch delta-safe**: the next auto-sync computes
   delta = 0 (no clobber); if KRS's global proc later heals to the true value, the delta engine
   adjusts from the new baseline without double-counting. POS-owned sale decrements are preserved
   (delta engine only ever applies KRS-originated movement).

Verified after: F01-0217 stock = 52, F14-0662 = 8 (untouched), remaining broken = 0.

## Hazards / follow-ups
- ⛔ Manual `POST /api/krs/sync-stock` (Data Flow tab) is an ABSOLUTE overwrite from the global
  sp_Onhand — pressing it re-breaks all 667 items until the vendor fix lands.
- 📨 **Vendor question Q9** (send together with the promotions Q1-Q8): "Why does
  `EXEC dbo.sp_Onhand @ItemCode=NULL, @Date=NULL, @Warehouse=NULL` return 0 (or no row) for items
  where `@Warehouse='WH03'` returns stock (example F01-0217 → 52)? ~667 items affected. Is the
  all-warehouse aggregate filtered by branch/DeptCode/doc-type differently from the scoped call?"
- If new discrepancies appear before the vendor fix (e.g. new goods receive at a branch not
  reflected globally), re-running the same patch SQL is safe and idempotent (condition
  `Σ warehouse > global baseline`).
- Longer-term (existing branch-warehouse backlog): branch-scoped checkout stock would decouple
  selling from the global aggregate entirely.

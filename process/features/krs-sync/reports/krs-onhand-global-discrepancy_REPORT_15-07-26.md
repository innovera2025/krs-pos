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

## Patch history (prod, 2026-07-15, backup first: `backups/krs-pos-20260715-072800.dump`)

**Attempt 1 (~07:28 UTC) — FAILED, reverted by the delta engine within ~2 minutes.** It bumped
`Product.stock` AND raised the global snapshot baseline (`lastQty`) to the warehouse sum. Because
KRS's global sp_Onhand still reports 0, the next auto-sync computed
`delta = 0 − 52 = −52` per item and subtracted it all back (log:
`updated: 667, totalDelta: -13644`), resetting both stock and baselines to 0.
**Lesson (hard rule): the snapshot baseline must ALWAYS mirror what KRS actually last reported —
never a wished-for value. Any gap between baseline and KRS's real answer becomes a phantom
"movement" the engine applies.**

**Attempt 2 (~07:45 UTC) — DURABLE.** Stock-only patch, baselines untouched:
`Product.stock += ROUND(Σ WarehouseStock.qty − global lastQty)` where
`Σ warehouse > global baseline AND stock < ROUND(Σ warehouse)` (667 rows). Baseline stays 0 =
exactly what KRS reports → every subsequent run computes delta 0 → the patched stock persists,
and POS sale decrements apply on top normally. Re-runnable/idempotent.

Verified after: F01-0217 stock = 52 (stable across sync runs), F14-0662 = 8 (untouched),
remaining broken = 0.

## Hazards / follow-ups
- ⛔ Manual `POST /api/krs/sync-stock` (Data Flow tab) is an ABSOLUTE overwrite from the global
  sp_Onhand — pressing it re-breaks all 667 items until the vendor fix lands.
- 📨 **Vendor question Q9** (send together with the promotions Q1-Q8): "Why does
  `EXEC dbo.sp_Onhand @ItemCode=NULL, @Date=NULL, @Warehouse=NULL` return 0 (or no row) for items
  where `@Warehouse='WH03'` returns stock (example F01-0217 → 52)? ~667 items affected. Is the
  all-warehouse aggregate filtered by branch/DeptCode/doc-type differently from the scoped call?"
- If new discrepancies appear before the vendor fix (e.g. new goods receive at a branch not
  reflected globally), re-run the **Attempt 2** stock-only SQL (safe, idempotent, baselines
  untouched).
- ⚠️ **When the vendor fixes the global sp_Onhand**: the first healed run will report the real
  quantities against a 0 baseline → the delta engine would ADD them on top of the patched stock
  (double count). At that moment, run the manual absolute sync-stock ONCE instead — that is the
  point where the button becomes the correct tool (it overwrites to the now-correct truth).
- Longer-term (existing branch-warehouse backlog): branch-scoped checkout stock would decouple
  selling from the global aggregate entirely.

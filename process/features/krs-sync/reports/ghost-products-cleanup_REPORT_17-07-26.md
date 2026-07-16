# Ghost products — POS kept items the KRS master had deleted (17-07-26)

**Status:** one-time cleanup DONE on prod (142 ghosts deactivated, 98 barcodes freed,
backup-first). Permanent importer reconciliation implemented same day (see below).

## Corrected root-cause narrative (supersedes the assumption in
`duplicate-barcode-items_REPORT_17-07-26.md`)

The earlier report assumed the KRS master still contained duplicate ItemCodes. The owner's
ERP screenshot proved otherwise: **KRS master is already clean** (one code per barcode,
e.g. `8850477029262` on `F01-0005`, master updated 14/07). The duplicates existed only in
POS: they are **ghosts** — ItemCodes that KRS once served and later DELETED/renumbered,
which POS kept forever because `importKrsProducts` only creates/updates by sku and never
reconciled deletions.

Evidence: POS active products 4,151 vs KRS `InventoryItem` 4,009 → diff = **142 ghosts**,
all stock 0, **98 still holding barcodes** — and holder-wins collision policy meant those
dead holders BLOCKED the live items from claiming their own barcodes (the scan-เจอ-หมด
incident).

## One-time cleanup (prod, 17-07-26, `scripts/krs-ghost-products-cleanup.cjs`)
Guarded write: (1) live diff against KRS at run time; (2) abort if the KRS list looks
partial (< 60% of POS active) — fail-open; (3) abort if any ghost holds stock; (4) one
transaction; idempotent. Result: 142 deactivated + barcodes nulled. Freed barcodes are
re-claimed by the live KRS items on the next product-import cycle automatically.
The earlier 40-pair barcode swap remains valid (those live items keep their barcodes).

## Permanent fix (code, same day)
- `Product.krsManaged Boolean @default(false)` — importer stamps `true` on every
  create/update; manual POS-created products stay `false` and are NEVER auto-deactivated.
- `importKrsProducts` reconciliation pass after each import: active `krsManaged` rows
  whose sku is absent from the fetched KRS list → `isActive=false, barcode=null`
  (barcode freed so live items can claim). Guards: skip entirely when the fetch looks
  partial (<60% of active krsManaged count) or had errors; never touch rows with stock>0
  (warn for manual review instead).
- Convergence: cycle 1 post-deploy stamps krsManaged on everything KRS serves; from
  cycle 2 the reconciler is fully armed. No backfill migration needed.

## Lessons
1. A sync that only upserts against a master that hard-deletes WILL accumulate ghosts —
   every importer needs a deletion-reconciliation story (with partial-fetch guards).
2. Unique-key collision policies (holder-wins) turn stale rows into active saboteurs:
   the dead row didn't just linger, it *blocked* the live row's barcode claim.
3. Verify assumptions against the SOURCE system before blaming it — the vendor's master
   was clean; the defect was ours.

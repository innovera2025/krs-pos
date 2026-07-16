# Duplicate KRS item codes sharing one barcode — scan found the stockless twin (17-07-26)

**Status:** POS-side PATCHED for 40 safe pairs (17-07-26, backup-first). Root cause is
duplicate item codes in the KRS master — ~57 more duplicate-name groups remain and will
resurface as stock arrives. **Owner to send the duplicate list to the KRS team for master
cleanup (deactivate/merge the dead codes).**

## Symptom
Scanning barcode `8850477029262` (Yummy Bites ไก่ 10g) showed "หมด" while keying the item
code `F01-0005` showed stock 40. Two POS rows existed for the same physical product:
`F01-0005` (stock 40, barcode NULL) and `F01-0210` (stock 0, holding the barcode).

## Root cause chain
1. The KRS item master contains the same physical product under TWO ItemCodes with the
   same barcode (`F01-0005` live with stock, `F01-0210` dead duplicate).
2. The POS product import (`importProducts.ts`) resolves barcode-unique collisions with a
   deliberate **holder-wins** policy (barcodeOwner seeded from existing DB rows; an
   incoming claim from a DIFFERENT sku is dropped to NULL). At first import the dead code
   happened to claim the barcode first — so the LIVE item lost its barcode and the scanner
   resolved to the stockless twin forever.

## POS-side patch (idempotent, re-runnable, durable)
One transaction (temp-table pair set → clear holder → assign to twin), backup first
(`backups/` 17-07-26). Strict safety criteria — a pair is fixed only when ALL hold:
- both rows active, EXACT same name, exactly 2 active rows with that name;
- the barcode-holder has stock 0 AND no positive `WarehouseStock` in any warehouse;
- the NULL-barcode twin has stock > 0.
Result: **40 pairs moved**. Verified: `F01-0005` now holds `8850477029262`, stock 40.
Durability: holder-wins means subsequent imports keep the corrected owner (the dead code's
incoming claim is now the one dropped to NULL).

## Remaining risk (~57 duplicate-name groups untouched)
Mostly both-zero-stock pairs or >2-row name groups — invisible today, but the moment KRS
receives stock into the live code, scanning breaks again for that item. The durable fix is
KRS-master cleanup; re-running the same patch SQL after stock arrives also works per pair.

## Operator notes
- List generator for the vendor (read-only psql): group active products by duplicate name,
  showing each sku + barcode-holder flag + stock (see command in the session log /
  regenerate ad-hoc).
- This class of issue is why the product card pill shows sku for some items and barcode
  for others (pill = barcode ?? sku): a NULL-barcode item displays its sku.

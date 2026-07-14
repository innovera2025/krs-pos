# KRS Discount Writeback Contract (net-out mapping) — 14-07-26

Feature: **promotions** · Phase: **1** (KRS discount-safety + net-out mapping)
Status: implemented behind `KRS_DISCOUNT_WRITE_ENABLED` (default `false`); vendor Q's open; sandbox unverified.

This document is the durable contract for how a POS bill that carries a **discount**
(manual line, manual bill, or — from Phase 6 — a promotion) is written back to KRS on the
**existing cash-sale writeback** (`src/lib/krs/writeback.ts`). It closes the pre-existing
hazard where a discounted bill wrote `Σ SalesInvoiceDtl.Amount` = **gross** while
`SalesInvoiceHdr.TotalAmount` = **net** (and `Dtl.DiscountAmount/DiscountPercent` were hardcoded 0),
i.e. an unreconciled bill (krs-sync backlog #2). All money is reasoned in **integer satang**.

---

## 1. Net-out mapping

The bill discount (all levels) is folded to a per-line **net** amount by the pricing engine
(`src/lib/pricing.ts` → `computeOrderTotals`), which allocates the bill-level discount across
lines by the largest-remainder method (already exact for VAT extraction). Each line then maps:

| Snapshot field (`SalePayloadItem`) | Source (integer satang) | KRS column (`SalesInvoiceDtl`) |
|---|---|---|
| `unitPrice` | catalog unit price (DB, not client) | `UnitPrice` (unchanged) |
| `quantity` | `OrderItem.quantity` | `MainQuantity` |
| `lineNet` | `pricing.lineNetSatang` (fully-net after bill-discount allocation) | `Amount = net / 100` |
| — | `gross = UnitPrice × Qty` | `DiscountAmount = (gross − net) / 100` |
| — | (deliberate literal) | `DiscountPercent = 0` always |
| `lineTotal` | `pricing.lineTotalSatang` (gross − line discount, pre-bill-alloc) | (not a Dtl column; balance/legacy only) |
| `lineDiscount` | combined manual+promo per-line discount | (informational; folded into `lineTotal`) |

`Hdr` / `TheJournal` / `InventoryFlow*` / `SalePurchaseTax` are **NOT touched** — the header
already carries net totals and VAT is already extracted on the net base.

### Identities (enforced, integer satang)

- **Per-line:** `UnitPrice × Qty − DiscountAmount == Amount`  (exact — `gross − (gross − net) == net`)
- **Cross-doc:** `Σ Dtl.Amount == Hdr.TotalAmount`  (from writeback gate (2c): `Σ net === total`)
- **Range:** `0 ≤ net[i] ≤ gross[i]`  → `DiscountAmount ∈ [0, gross]`  (gate (2d))
- **Header (unchanged):** `total == subtotal − discount`  (`discount` = combined bill discount; gate (2a))
- **Non-zero:** `total > 0`  (gate (2e); Q-ZERO pending)

### Why `DiscountPercent = 0` (deliberate, not a TODO)

A percent cannot exactly round-trip a satang-level discount: a 100%-free line would divide by a
zero base, and general lines carry rounding drift. `DiscountAmount` is therefore the **authoritative**
discount value and `DiscountPercent` carries none. (Vendor confirmation requested — Q-PCT below.)

### No-regression property

For a **zero-discount** payload, `gross == net` on every line, so `DiscountAmount = 0` and
`Amount = lineTotal` — the `Dtl` inserts are **byte-identical** to the pre-discount behavior.
A **legacy** payload (`lineNet == null`, enqueued before this field existed) is net-reconstructed
as `net := lineTotal` **only** when the whole bill has no discount (`salePayloadHasDiscount === false`);
a legacy payload that *does* carry a discount is refused (`KrsWriteError`, manual review) rather
than writing an unreconciled bill.

---

## 2. Worked example (recomputed against the real `computeTotals` allocator)

Cart:
- **A** = ฿100.00 × 2, line promo −฿20.00  → line gross 200.00, `lineTotal` **180.00**
- **B** = ฿55.50 × 1, manual line −฿0.50  → line gross 55.50, `lineTotal` **55.00**
- subtotal = **235.00**
- bill-level discount = promo −฿50.00 + manual −฿5.00 = **55.00** (`discount` = 55.00, `promoBillDiscount` = 50.00)

Largest-remainder allocation of the 55.00 bill discount across `lineTotal` [180.00, 55.00]:
- exact shares: A = 180.00/235.00 × 55.00 = 42.1276… → floor **42.12** (frac .766); B = 55.00/235.00 × 55.00 = 12.8723… → floor **12.87** (frac .234)
- leftover 1 satang → highest frac (A) → **allocated [42.13, 12.87]**
- `lineNet` = lineTotal − alloc = **[137.87, 42.13]**
- **total = 180.00**  (= subtotal 235.00 − discount 55.00 ✓)
- per-line inclusive VAT = round(net × 7/107) = [9.02, 2.76] → **VAT 11.78**

Resulting KRS rows:

| Dtl | UnitPrice | Qty | DiscountAmount (gross−net) | Amount (net) | check `UP×Qty−DA==Amt` |
|---|---|---|---|---|---|
| A | 100.00 | 2 | 62.13 (200.00−137.87) | 137.87 | 200.00−62.13 = 137.87 ✓ |
| B | 55.50 | 1 | 13.37 (55.50−42.13) | 42.13 | 55.50−13.37 = 42.13 ✓ |

`Hdr`: **TotalAmount 180.00** (= Σ Amount 137.87 + 42.13 ✓), **SubTotalAmnt / VATForValue 168.22**
(= total 180.00 − VAT 11.78), **VATAmount 11.78**.

> These numbers were regenerated with the actual `src/lib/pricing.ts` largest-remainder allocator
> (not hand-rounded). If the allocator is ever changed, regenerate this table.

---

## 3. Vendor questions (Q1–Q8)

Send after Phase 1 ships; they do NOT block other phases (the flag stays `false` until answered
+ sandbox-verified).

- **Q-AMOUNT (BLOCKING):** Is `SalesInvoiceDtl.Amount` the **final** line amount everywhere
  (`Amount = UnitPrice×Qty − DiscountAmount`), or does any KRS report/GL/print path compute
  `Amount − DiscountAmount` **again** (double-subtract)? If any path double-subtracts, our net-out
  mapping would under-report — we must instead put gross in `Amount` and let KRS subtract.
- **Q-HDR (BLOCKING):** Does a discounted **cash** sale need any `SalesInvoiceHdr` discount field
  populated (e.g. a header-level `DiscountAmount`/`TotalDiscount`), or may the header carry only the
  **net** totals it already does? Please provide a discounted-sale sample workbook (like `ขายสด.xlsx`)
  so we can diff a real discounted bill's columns.
- **Q-TAD:** Does `dbo.TaxAndDiscount` need a row for discounted sales, or is it unused for cash sales?
- **Q-PCT:** Is `DiscountPercent = 0` with `DiscountAmount > 0` legal — i.e. nothing recomputes the
  line amount from the percent? (We keep percent at 0 because it cannot round-trip a satang discount.)
- **Q-GL:** Is the GL for a discounted cash sale still exactly **3** `TheJournal` rows with **NET**
  revenue (D cash=total / C revenue=net−VAT / C VAT), or does KRS expect **gross** revenue plus a
  separate discount contra line?
- **Q-VAT:** Confirm output VAT / `SalePurchaseTax.BillAmount` is on the **discounted (net) base**
  (our current behavior), not the gross base.
- **Q-ZERO:** Does KRS accept `TotalAmount = 0` (a 100%-discount / fully-free bill)? We currently
  **refuse** total ≤ 0 pending this answer.
- **Q-REMARKS:** May we add `Remarks` (= POS `orderNumber`) to the `Hdr` insert subset for traceability?

---

## 4. Sandbox verification procedure

**Preconditions:** point the outbound writeback at the **sandbox** MS SQL target only
(`KRS_SANDBOX_*` set), then enable both flags **against the sandbox only**:
`KRS_OUTBOUND_ENABLED=true` + `KRS_DISCOUNT_WRITE_ENABLED=true`. Never against production.
The UNIQUE constraint on `KRS.SalesInvoiceHdr.TransactionNo` must exist (existing pre-enable gate).

### Test matrix (7 cases)

1. **Line promo only** — one line with a per-line promo discount, no bill discount.
2. **Bill promo only** — threshold/bill promo, no line discounts.
3. **Manual bill + promo bill stacked** — both bill-level slices present (`discount` = manual + promo).
4. **Manual line + line promo on the same line** — combined per-line discount folds into one `lineTotal`.
5. **100%-free line in a multi-line bill** — one line net 0 (`DiscountAmount == gross`), others normal;
   bill `total` still > 0.
6. **Plain no-discount regression** — MUST be **byte-identical** to the pre-change inserts.
7. **Reclaim** — kill the app between the phase-0 anchor burn and the phase-1 commit on a discounted
   bill; restart; verify exactly **one** KRS write (recovered to SYNCED, snapshot advanced once).

### Proof SELECTs (all diffs must be 0.00 / 0 rows)

(a) **Header/detail cross-foot** (per transaction `@n`):
```sql
SELECT h.TotalAmount - d.SumAmt,
       (d.SumGross - d.SumDisc) - h.TotalAmount
FROM SalesInvoiceHdr h
JOIN (SELECT TransactionNo,
             SUM(Amount) SumAmt,
             SUM(DiscountAmount) SumDisc,
             SUM(UnitPrice * MainQuantity) SumGross
      FROM SalesInvoiceDtl GROUP BY TransactionNo) d
  ON d.TransactionNo = h.TransactionNo
WHERE h.TransactionNo = @n;   -- both computed columns = 0.00
```

(b) **Per-line identity** (0 rows):
```sql
SELECT * FROM SalesInvoiceDtl
WHERE TransactionNo = @n
  AND ABS(UnitPrice * MainQuantity - DiscountAmount - Amount) > 0.005;   -- 0 rows
```

(c) **Journal balance** (= 0):
```sql
SELECT SUM(CASE WHEN DrCr = 'D' THEN Amount ELSE -Amount END)
FROM TheJournal WHERE SourceNo = @n;   -- 0
```

(d) **Tax log** (both = 0):
```sql
SELECT t.BillAmount - h.SubTotalAmnt, t.VATAmount - h.VATAmount
FROM SalePurchaseTax t
JOIN SalesInvoiceHdr h ON h.VoucherNo = t.VoucherNo
WHERE h.TransactionNo = @n;   -- both 0
```

Plus: the **owner/vendor opens each test bill in the KRS app UI** to confirm it renders correctly
(this answers **Q-AMOUNT** empirically — if the app shows the right net figures, `Amount` is read as final).

### Rollout

1. Deploy Phase 1 → discounted jobs are **HELD** (PENDING, `DISCOUNT_HELD` log); no KRS write.
2. Provision + point at sandbox; run the 7-case matrix; all proof SELECTs pass; owner/vendor UI check OK.
3. **OWNER** flips `KRS_DISCOUNT_WRITE_ENABLED=true` on production (an agent must **never** flip it —
   same invariant as `KRS_OUTBOUND_ENABLED`). Held discounted jobs then drain to SYNCED.

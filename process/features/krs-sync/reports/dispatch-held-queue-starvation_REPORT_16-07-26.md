# Dispatch queue starvation — held discounted bills blocked clean sales (16-07-26)

**Status:** FIXED + deployed 16-07-26 (`f688070`). Clean bills confirmed flowing
(`synced: 3` on the first post-fix run; SYNCED climbing).

## Symptom
Owner report: "ยอดขายวันนี้ไม่เข้า ERP" — ALL of today's SALE jobs sat PENDING with
`attempts = 0`, including bills with zero discount (e.g. POS-20260716-0013).

## Root cause (two layers)
1. **By design:** bills with any discount (manual line/bill discounts — the shop uses them
   heavily — and promotions) are HELD by the `DISCOUNT_HELD` gate until
   `KRS_DISCOUNT_WRITE_ENABLED` is flipped (pending vendor Q1-Q8 + sandbox). Correct.
2. **The bug:** `requeuePending()` returned held jobs to PENDING **without touching
   `nextAttemptAt`**, while the claim query is `ORDER BY "createdAt" ASC LIMIT 10`.
   The 10 oldest held bills were therefore re-claimed on every ~30s run
   (`claimed: 10, skipped: 10` forever) and every bill behind them — including clean
   zero-discount sales — was starved and never dispatched (head-of-line blocking).

## Fix (`src/lib/krs/dispatcher.ts`)
New `requeueHeld()` used only by the DISCOUNT_HELD branch: attempt-free requeue with
`nextAttemptAt = now + 5 min` (`DISCOUNT_HOLD_RECHECK_MS`). Held bills step aside so the
queue flows; each held bill consumes a claim slot once per 5 minutes instead of every run.
Post-flag-flip drain lag is bounded to ≤5 min (or use the admin manual dispatch after the
recheck stamp passes). The generic `requeuePending()` (outbound-disabled / unconfigured
paths) is unchanged — those are global gates where ordering cannot starve anyone.

## Verification (prod)
- Pre-fix: `krsDispatch {claimed: 10, synced: 0, skipped: 10}` on every run; today's clean
  bills PENDING with attempts 0.
- Post-fix: next run `{claimed: 10, synced: 3, failed: 0, skipped: 7}`; SALE status today
  moved to SYNCED 3 / PENDING 10 within one cycle, climbing as runs continue.
- Payload inspection method used for diagnosis (reusable): expand `payload->'items'` with
  `jsonb_array_elements` and compare `unitPrice×quantity` vs `lineTotal` per line — this is
  exactly what `salePayloadHasDiscount()` sees.

## Standing state after this fix
- Clean bills: sync in ~seconds (realtime, as before the promotions program).
- Discounted/promo bills: intentionally HELD (visible as รอส่ง in Sales History / Sync
  Activity) until the owner completes: vendor Q1-Q8 → sandbox matrix → flip
  `KRS_DISCOUNT_WRITE_ENABLED=true`. Then the held backlog drains automatically.

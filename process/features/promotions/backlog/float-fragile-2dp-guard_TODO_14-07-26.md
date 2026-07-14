<!-- Created 14-07-26 | Type: bug-in-existing-guard | Status: not started -->

# 2dp money guard rejects legitimate values (float-fragile) — TODO

## What's wrong

Both money-input validators use the same 2-decimal-place guard:

- `src/app/api/orders/route.ts:455` — `Math.round(discountValue * 100) !== discountValue * 100`
  (rejects `discountValue` with >2dp; checkout bill-level discount)
- `src/lib/schemas/promotion.ts:34` — `Math.round(v * 100) === v * 100` (deliberately mirrored,
  same guard, per that file's own comment: "the SAME guard the checkout money [validator uses]")

Both compare the **float** `v * 100` to `Math.round(v * 100)`. Because `v * 100` is IEEE-754 float
multiplication, plenty of legitimate 2-decimal-place baht values do NOT round-trip exactly, so the
guard rejects them as if they had more than 2 decimal places:

```
19.99 * 100 = 1998.9999999999998   → Math.round = 1999 → 1999 !== 1998.9999999999998 → REJECTED
0.07  * 100 = 7.000000000000001    → Math.round = 7    → 7 !== 7.000000000000001    → REJECTED
0.29  * 100 = 28.999999999999996   → Math.round = 29   → 29 !== 28.999999999999996  → REJECTED
```
(Verified with `node -e` on 2026-07-14; `10.10` and `100.01` happen to round-trip and pass — the
bug is value-dependent, not universal, which makes it easy to miss in ad-hoc testing.)

## Impact

- Checkout: a cashier entering a bill-level manual discount of exactly `19.99` (or `0.07`, `0.29`,
  etc.) gets `400 BAD_DISCOUNT` even though the value is a perfectly valid 2dp baht amount.
- Promotions: an ADMIN creating/editing a promotion with `percentOff`/`amountOffSatang`-equivalent
  baht input hitting one of these unlucky float values gets a Zod validation rejection for the same
  reason.

## Provenance

Pre-existing behavior inherited from the original checkout discount validator (predates the
promotions program). The promotions program (Phase 4, `src/lib/schemas/promotion.ts`) deliberately
**mirrored** the existing checkout guard byte-for-byte rather than fixing it, to keep the two
validators in lock-step — see the `promotion.ts` file header comment. This TODO documents the
shared bug so a fix lands in both places together instead of drifting.

## Suggested fix

Change the comparison to an integer/epsilon-tolerant form in **both** files together, e.g.:

```ts
Number.isInteger(Math.round(v * 100)) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6
```

or switch to string-based validation (count digits after the decimal point in the raw input string
before it is ever coerced to a JS number). Either approach must be applied to **both**
`src/app/api/orders/route.ts` (`discountValue` / `BAD_DISCOUNT`) and `src/lib/schemas/promotion.ts`
(all money fields using the shared guard) in the same change, per the "SAME guard" invariant the
promotion schema file already documents. Add a regression test asserting `19.99`, `0.07`, and `0.29`
are accepted by both validators.

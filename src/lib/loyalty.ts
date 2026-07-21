/**
 * Pure loyalty-points engine for the POS — loyalty program, Phase 1A.
 *
 * This module turns store loyalty CONFIG (earn rate, point value) plus a bill's
 * money figures into whole POINTS and satang-exact redemption VALUE. Like
 * `./promotionEngine` it is **isomorphic** and deliberately dependency-free (no
 * Prisma client, no mssql, no next, no `src/lib/schemas/*`): the identical code
 * runs in the POS **client** (to preview "you'll earn N points" / "this redeem is
 * worth ฿Y") and on the **server** (the authoritative recompute at checkout, Phase
 * 1B / Phase 2). Client and server therefore agree to the point and to the satang.
 *
 * All money is **integer satang** (1 baht = 100 satang), the same discipline
 * `./pricing` and `./promotionEngine` use — never IEEE-754 float baht for a stored
 * amount. Points are plain non-negative integers.
 *
 * **Never-zero-the-bill invariant** (`computeRedemption`): a points redemption is capped
 * so it can never drive the bill to exactly 0 — it always leaves at least 1 satang
 * payable (`redemptionSatang < remainingBillSatang`). A 0-total bill would dead-end the
 * checkout payment guard (BAD_AMOUNT) with no recovery, so the redeem bill-cap floors at
 * `floor((remaining − 1) / perPoint)` rather than `floor(remaining / perPoint)`.
 *
 * Clock-free by design: whether loyalty is *enabled* (the `loyaltyEnabled` switch)
 * and whether a customer *is a member* are fetch-boundary concerns owned by the API
 * layer; this engine only does the arithmetic it is handed. Every function is
 * defensive — a malformed / non-finite / negative input yields 0 rather than a
 * crash or a negative points/value, so a bad config row can never over-credit or
 * over-discount a sale.
 */

/** Clamp a value into the inclusive range [min, max]. Mirrors the private helper in
 *  `./pricing` / `./promotionEngine`; exported here for the redeem-preview UI. */
export function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Truncate to a non-negative integer; non-finite / negative → 0. */
function toNonNegativeInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Whole points EARNED on a sale, from the bill's net total (integer satang) and the
 * store earn rate (`earnBahtPerPoint`: baht spent to accrue 1 point).
 *
 *   points = earnBahtPerPoint > 0 ? floor((netTotalSatang / 100) / earnBahtPerPoint) : 0
 *
 * Floors, so ฿62.50 at ฿25/point earns 2 (not 2.5). Guards:
 *  - a non-finite / negative `netTotalSatang` → 0 (a refund/void never earns here).
 *  - a non-finite / non-positive `earnBahtPerPoint` → 0 (rate 0 = earning off;
 *    also protects against divide-by-zero).
 * The result is always a non-negative integer.
 */
export function pointsEarned(
  netTotalSatang: number,
  earnBahtPerPoint: number
): number {
  if (!Number.isFinite(netTotalSatang) || netTotalSatang <= 0) return 0;
  if (!Number.isFinite(earnBahtPerPoint) || earnBahtPerPoint <= 0) return 0;
  const points = Math.floor(netTotalSatang / 100 / earnBahtPerPoint);
  return points > 0 ? points : 0;
}

/**
 * The baht VALUE (integer satang) of redeeming `points`, at the store point value
 * (`redeemPointValueSatang`: satang per point), CLAMPED so it can never exceed the
 * bill `subtotalSatang` (you cannot redeem more than the bill is worth — a redeem is
 * a discount, never a payout).
 *
 *   value = clamp(points * redeemPointValueSatang, 0, subtotalSatang)
 *
 * Guards (each pushes the result toward 0, never negative):
 *  - non-finite / negative `points` or `redeemPointValueSatang` → the raw value is 0.
 *  - non-finite / negative `subtotalSatang` → clamped to 0 (nothing to discount).
 * Inputs are truncated to non-negative integers first so the product stays exact
 * integer satang even if a caller passes a fractional value.
 */
export function redemptionValueSatang(
  points: number,
  redeemPointValueSatang: number,
  subtotalSatang: number
): number {
  const pts = toNonNegativeInt(points);
  const perPoint = toNonNegativeInt(redeemPointValueSatang);
  const cap = toNonNegativeInt(subtotalSatang);
  return clamp(pts * perPoint, 0, cap);
}

/**
 * The fully-resolved outcome of a points-redemption REQUEST against a specific bill
 * (loyalty program, Phase 2). Pure, satang-exact, clock-free. See `computeRedemption`.
 */
export type RedemptionPlan = {
  /**
   * The points ACTUALLY spent = `min(requested, balance, maxByBillPoints)`. A whole
   * non-negative integer. This — not the raw request — is what the server decrements
   * and stamps onto `Order.pointsRedeemed`.
   */
  effectiveRedeemPoints: number;
  /**
   * The baht value (integer satang) of `effectiveRedeemPoints`, i.e.
   * `effectiveRedeemPoints × redeemPointValueSatang`. `≤ remainingSatang` BY
   * CONSTRUCTION (see `maxByBillPoints`), so folding it in as the third bill-discount
   * slice can never push the bill discount past the subtotal. Stamped onto
   * `Order.pointsRedemptionDiscount`.
   */
  redemptionSatang: number;
  /**
   * `floor((remainingSatang − 1) / redeemPointValueSatang)` — the MOST whole points the
   * bill's remaining value can absorb WHILE STILL LEAVING ≥1 satang payable (the
   * never-zero-the-bill invariant). The floor is the crux of the "points map EXACTLY to
   * value" rule: capping the spend here guarantees every redeemed point is worth the full
   * `redeemPointValueSatang`, so a fractional point is NEVER spent to cover a partial-satang
   * remainder. The `− 1` guarantees `redemptionSatang ≤ remaining − 1 < remaining`, so the
   * bill can never be zeroed. 0 when the point value is non-positive or the remaining bill
   * is ≤ 0 (the `Math.max(0, …)` guard).
   */
  maxByBillPoints: number;
  /**
   * `requested > balance` — the FRIENDLY pre-transaction overdraw signal. The real,
   * race-proof gate is the in-transaction atomic `updateMany WHERE pointsBalance >= n`
   * (`count === 1`) at checkout; this flag only lets the API return a clean 422 before
   * doing any work when the request is obviously over the last-read balance.
   */
  exceedsBalance: boolean;
  /**
   * `requested > 0 AND effectiveRedeemPoints < minRedeemPoints` — the store's redeem
   * floor was not met (either the request itself or the bill-capped effective spend is
   * below the minimum). The API returns 422 rather than silently zeroing the redeem, so
   * the client is told to redeem more (or clear) instead of seeing a phantom discount.
   */
  belowMin: boolean;
  /**
   * `minRedeemPoints > 0 AND maxByBillPoints < minRedeemPoints` — the REMAINING bill is too
   * small to EVER satisfy the store redeem floor, so a redeem should never have been offered
   * on it (distinct from `belowMin`, where the bill COULD support the floor but the request
   * was too small). The API uses this to return a clearer "bill too small" code instead of a
   * misleading "redeem more" message, and the client uses it to hide the redeem control.
   */
  billTooSmallForMin: boolean;
};

/**
 * Resolve a points-redemption REQUEST into the exact points spent + satang discount for
 * ONE bill (loyalty program, Phase 2). Pure, satang-exact, clock-free — the server calls
 * this AFTER the promo-threshold + manual bill discounts are known (so `remainingSatang`
 * is what a further bill discount can still cover) and BEFORE `computeOrderTotals`, then
 * folds `redemptionSatang` into the combined bill discount as the THIRD slice.
 *
 * Invariants (each defended by the guards below so a malformed config/request can never
 * over-credit, over-discount, or spend a fractional point):
 *  - `effectiveRedeemPoints = min(requested, balance, floor((remaining − 1) / perPoint))` —
 *    a whole non-negative integer, so points map EXACTLY to value (no fractional point).
 *  - `redemptionSatang = effectiveRedeemPoints × perPoint`, and `< remainingSatang` — the
 *    never-zero-the-bill invariant: the `remaining − 1` bill cap guarantees the bill always
 *    keeps ≥1 satang payable (a 0-total bill would dead-end the checkout payment guard). The
 *    clamp to `remaining` is belt-and-braces on top.
 *  - All inputs are truncated to non-negative integers first, so a non-finite/negative
 *    request, balance, remaining, point value, or minimum degrades to 0 rather than
 *    throwing or producing a negative discount.
 */
export function computeRedemption(
  requestedPoints: number,
  pointsBalance: number,
  remainingSatang: number,
  redeemPointValueSatang: number,
  minRedeemPoints: number
): RedemptionPlan {
  const requested = toNonNegativeInt(requestedPoints);
  const balance = toNonNegativeInt(pointsBalance);
  const remaining = toNonNegativeInt(remainingSatang);
  const perPoint = toNonNegativeInt(redeemPointValueSatang);
  const minRedeem = toNonNegativeInt(minRedeemPoints);

  // Cap points to what the REMAINING bill can absorb WHILE LEAVING ≥1 satang payable so
  // every redeemed point is worth the full `perPoint` AND the bill is never zeroed. Using
  // `remaining − 1` ⇒ `effectiveRedeemPoints × perPoint ≤ remaining − 1 < remaining` (the
  // never-zero-the-bill invariant); `floor` still guarantees no fractional point is spent to
  // cover a partial-satang remainder. `Math.max(0, …)` guards `remaining` 0/1 (→ cap 0).
  const maxByBillPoints =
    perPoint > 0 ? Math.max(0, Math.floor((remaining - 1) / perPoint)) : 0;
  const effectiveRedeemPoints = Math.min(requested, balance, maxByBillPoints);
  // `< remaining` by construction (the `− 1` cap); clamp is belt-and-braces against a bad
  // config row.
  const redemptionSatang = clamp(effectiveRedeemPoints * perPoint, 0, remaining);

  return {
    effectiveRedeemPoints,
    redemptionSatang,
    maxByBillPoints,
    exceedsBalance: requested > balance,
    belowMin: requested > 0 && effectiveRedeemPoints < minRedeem,
    // The REMAINING bill can't reach the store floor no matter what was requested — the
    // redeem control should never have been offered on it (FIX 3). Distinct from `belowMin`.
    billTooSmallForMin: minRedeem > 0 && maxByBillPoints < minRedeem,
  };
}

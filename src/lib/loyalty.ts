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

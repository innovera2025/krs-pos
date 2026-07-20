/**
 * Pure promotion engine for the POS cart — Phase 3.
 *
 * This module decides WHICH promotions apply to a cart and HOW BIG each discount
 * is, entirely in **integer satang** (1 baht = 100 satang) to avoid IEEE-754 float
 * drift on money — the exact discipline `./pricing` uses. It is **isomorphic** and
 * deliberately dependency-free (no Prisma client, no mssql, no next, no
 * `src/lib/schemas/*`): the same code runs in the POS **client** (to preview the
 * price a cashier sees) and in the **orders route** on the server (the
 * authoritative recompute). Client and server therefore agree to the satang.
 *
 * Parity guarantee — the whole reason this module exists. `applyPromotions`
 * produces a `combinedLineDiscountSatang` per line and a single `combinedBill`
 * bill-level discount that are fed **unchanged** into `./pricing`
 * (`computeTotals` on the client, `computeOrderTotals` on the server). The
 * `subtotalSatang` computed here uses the *identical* formula
 * `Σ max(gross − lineDiscount, 0)` as `computeTotals`, so
 * `application.subtotalSatang === computeTotals(...).subtotalSatang` **exactly**.
 * The orders route asserts this equality and returns 500 INTERNAL on mismatch.
 *
 * Calculation order (Money Contract — authoritative):
 *  1. per line: find the best line-level promo candidate (PRODUCT_DISCOUNT,
 *     FIXED_PRICE, BUY_X_GET_Y) from the line **gross** (catalog price × qty). The
 *     manual per-line discount does NOT shrink the promo base.
 *  2. combinedLineDiscountSatang = min(promoLine + manualLine, gross).
 *  3. subtotal = Σ max(gross − combined, 0)  (same formula as ./pricing).
 *  4. BILL_THRESHOLD promo: if subtotal ≥ minSubtotal → discount, clamped ≤ subtotal.
 *  5. manual bill discount on top (percent computed on the SAME subtotal), clamped
 *     ≤ subtotal − promoBill.
 *  6. combinedBill = { type: "amount", value: (promoBill + manualBill) / 100 } —
 *     handed to ./pricing, whose money math is NOT touched here.
 *
 * Time / `isActive` filtering deliberately does NOT happen in this module: it is
 * **clock-free**. Choosing which promotions are currently effective (active flag +
 * start/end window) is a fetch-boundary concern owned by the API layer; the engine
 * only ranks and applies whatever `ActivePromotion[]` it is handed.
 *
 * Determinism: the result is independent of the input `promotions` order — for
 * both line and bill promos the largest discount wins, and ties are broken by the
 * smallest promotion `id` (plain string compare). Malformed/incomplete promo
 * config (missing required fields, non-finite, out-of-range) yields a zero
 * candidate and is simply not applied; the API layer validates on write, the
 * engine is defensive so a bad row can never crash or over-discount a sale.
 */

import type { BillDiscount } from "./pricing";

/**
 * A promotion in the compact, client-safe DTO shape the engine consumes. All
 * money is **integer satang** (never Decimal/baht) so it serializes cleanly to the
 * POS client. Which optional fields are populated depends on `type`; the API layer
 * guarantees exactly one shape per type, but the engine treats every field
 * defensively (see the module header) and never trusts the promo to be well-formed.
 */
export type ActivePromotion = {
  id: string;
  name: string;
  type: "PRODUCT_DISCOUNT" | "FIXED_PRICE" | "BUY_X_GET_Y" | "BILL_THRESHOLD";
  /** Percentage off, 0 < p <= 100, <= 2dp (PRODUCT_DISCOUNT | BILL_THRESHOLD). */
  percentOff?: number;
  /** PRODUCT_DISCOUNT: satang off **per unit**. BILL_THRESHOLD: satang off the bill. */
  amountOffSatang?: number;
  /** FIXED_PRICE: the special per-unit price in satang. */
  fixedPriceSatang?: number;
  /** BUY_X_GET_Y: buy `buyQty`, then `getQty` units get the reward below. */
  buyQty?: number;
  getQty?: number;
  /**
   * BUY_X_GET_Y reward — % off the rewarded units. 1..100; 100 = the units are free.
   * EXACTLY ONE of `getDiscountPercent` / `getAmountOffSatang` drives the reward; the
   * engine reads AMOUNT mode iff `getAmountOffSatang` is non-null (percent otherwise).
   */
  getDiscountPercent?: number;
  /** BUY_X_GET_Y reward — satang off **per rewarded unit** (clamped to the unit price). */
  getAmountOffSatang?: number;
  /** BILL_THRESHOLD: minimum subtotal (satang) required for the bill discount. */
  minSubtotalSatang?: number;
  /** Products this promo is scoped to (types 1-3). Ignored for BILL_THRESHOLD. */
  productIds?: string[];
};

/**
 * One cart line as the engine sees it. `priceSatang` is the catalog unit price in
 * satang (server: from the DB, never the client). `manualLineDiscountSatang` is the
 * cashier's existing per-line "ส่วนลดรายการ"; it is already clamped upstream, but
 * the engine re-clamps it defensively (floored at 0, and folded into the combined
 * min against gross).
 */
export type PromoCartLine = {
  productId: string;
  priceSatang: number;
  quantity: number;
  manualLineDiscountSatang?: number;
};

/** The promotion actually applied (line- or bill-level), snapshotted for persistence. */
export type AppliedPromo = {
  promotionId: string;
  promotionName: string;
  /** The discount this promo contributes, in satang (already clamped to its cap). */
  discountSatang: number;
};

/** Full result of applying promotions to a cart. All money is integer satang. */
export type PromotionApplication = {
  /** Per-line breakdown, same order as the input `lines`. */
  lines: Array<{
    /** The line-level promo discount, 0 when no promo applied. */
    promoDiscountSatang: number;
    /** The winning line promo, or null when none applied. */
    promo: AppliedPromo | null;
    /**
     * `min(promoDiscount + manualLineDiscount, gross)`. This is fed unchanged into
     * `./pricing` as `lineDiscountSatang`, which is why the engine and pricing
     * subtotals match exactly.
     */
    combinedLineDiscountSatang: number;
  }>;
  /**
   * `Σ max(gross − combined, 0)`. Same formula as `computeTotals`' subtotal, so
   * `subtotalSatang === computeTotals(...).subtotalSatang` for the same lines.
   */
  subtotalSatang: number;
  /** The winning BILL_THRESHOLD promo, or null when none applied. */
  billPromo: AppliedPromo | null;
  /** The threshold promo's bill discount, clamped to the subtotal (satang). */
  promoBillDiscountSatang: number;
  /** The manual bill discount, resolved + clamped to (subtotal − promoBill) (satang). */
  manualBillDiscountSatang: number;
  /**
   * The single combined bill discount handed to `./pricing`:
   * `{ type: "amount", value: (promoBill + manualBill) / 100 }`.
   *
   * Round-trip proof: `computeTotals` recovers satang via `roundSatang(value*100)`.
   * For any integer satang `s`, `Math.round((s / 100) * 100) === s` throughout the
   * Decimal(10,2) range (a double carries ~15-16 significant digits; the
   * s → baht → satang float error is ≪ 0.5, so half-up rounding is exact). Thus
   * `computeTotals(...).billDiscountSatang === promoBill + manualBill` exactly.
   */
  combinedBill: BillDiscount;
};

// ---------------------------------------------------------------------------
// Local numeric helpers.
//
// `roundSatang` and `clamp` mirror the private helpers in `./pricing` byte-for-byte
// so the two modules round identically. They are replicated (not imported) because
// `./pricing` does not export them, and the Money Contract forbids editing
// pricing.ts from this phase.
// ---------------------------------------------------------------------------

/** Round half-up to an integer (satang are integers). Guards non-finite input. */
function roundSatang(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Clamp a value into the inclusive range [min, max]. */
function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Normalize a quantity the SAME way `computeTotals` does: trunc, floored at 0. */
function normalizeQty(q: number): number {
  return Number.isFinite(q) ? Math.max(Math.trunc(q), 0) : 0;
}

/** Normalize a unit price the SAME way `computeTotals` does: round half-up, floored at 0. */
function normalizePriceSatang(p: number): number {
  return Math.max(roundSatang(p), 0);
}

/** A valid discount percentage: finite and in (0, 100]. */
function isValidPercent(p: number | undefined): p is number {
  return typeof p === "number" && Number.isFinite(p) && p > 0 && p <= 100;
}

/** A valid positive integer count (buyQty / getQty). */
function isPositiveInt(n: number | undefined): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1;
}

/** Clamp a raw line-candidate into [0, gross]; non-finite / non-positive → 0. */
function clampToGross(candidate: number, gross: number): number {
  if (!Number.isFinite(candidate) || candidate <= 0) return 0;
  return Math.min(candidate, gross);
}

/** Clamp a raw bill-candidate into [0, subtotal]; non-finite / non-positive → 0. */
function clampToSubtotal(candidate: number, subtotal: number): number {
  if (!Number.isFinite(candidate) || candidate <= 0) return 0;
  return Math.min(candidate, subtotal);
}

/**
 * The raw line-level promo discount (satang) for a single line, BEFORE product
 * scoping and best-per-line selection (which live in `applyPromotions`). Exported
 * for unit tests and the POS UI (badge previews). Every result is clamped to
 * `[0, gross]`; a malformed/incomplete promo, a non-line type (BILL_THRESHOLD), or
 * a zero-gross line all yield 0.
 *
 * Per type (integer satang, half-up rounding once at the line level):
 *  - PRODUCT_DISCOUNT percent: `roundSatang(gross * percentOff / 100)` — never per unit.
 *  - PRODUCT_DISCOUNT amount:  `min(amountOffSatang * qty, gross)`.
 *  - FIXED_PRICE:              `max(price − fixedPriceSatang, 0) * qty` (fixed ≥ price → 0; never markup).
 *  - BUY_X_GET_Y:              `groups = floor(qty / (buyQty + getQty))`,
 *                              `rewardedUnits = groups * getQty`, then the reward on
 *                              those units — EXACTLY ONE of:
 *                                • percent: `roundSatang(rewardedUnits * price * getDiscountPercent / 100)`
 *                                  (getDiscountPercent 100 → exact, no rounding); or
 *                                • amount:  `min(getAmountOffSatang, price) * rewardedUnits`
 *                                  (per-unit ฿ off, clamped to the unit price so a line
 *                                  never goes negative). Amount mode iff getAmountOffSatang != null.
 */
export function linePromoCandidateSatang(
  promo: ActivePromotion,
  priceSatang: number,
  quantity: number
): number {
  const price = normalizePriceSatang(priceSatang);
  const qty = normalizeQty(quantity);
  const gross = price * qty;
  if (gross <= 0) return 0;

  switch (promo?.type) {
    case "PRODUCT_DISCOUNT": {
      // Exactly one of percent / amount is populated per the schema; the engine
      // prefers a valid percent, else falls back to a positive per-unit amount.
      if (isValidPercent(promo.percentOff)) {
        return clampToGross(roundSatang((gross * promo.percentOff) / 100), gross);
      }
      const perUnit = normalizePriceSatang(promo.amountOffSatang ?? 0);
      if (perUnit <= 0) return 0;
      return clampToGross(perUnit * qty, gross);
    }
    case "FIXED_PRICE": {
      const fixed = promo.fixedPriceSatang;
      // A missing/negative special price is malformed; a negative one would imply a
      // markup, which is forbidden — treat both as "not applicable".
      if (typeof fixed !== "number" || !Number.isFinite(fixed) || fixed < 0) {
        return 0;
      }
      const perUnitDrop = Math.max(price - roundSatang(fixed), 0);
      return clampToGross(perUnitDrop * qty, gross);
    }
    case "BUY_X_GET_Y": {
      const buy = promo.buyQty;
      const get = promo.getQty;
      if (!isPositiveInt(buy) || !isPositiveInt(get)) {
        return 0;
      }
      const groupSize = buy + get;
      const groups = Math.floor(qty / groupSize);
      const rewardedUnits = groups * get;
      if (rewardedUnits <= 0) return 0;

      // AMOUNT mode (iff getAmountOffSatang is set): a fixed ฿ off per rewarded unit,
      // clamped to the unit price so a rewarded line can never go negative. A
      // missing/non-finite/non-positive amount is malformed → 0 (no percent fallback:
      // the field's presence, not its validity, selects the mode).
      if (promo.getAmountOffSatang != null) {
        const perUnitDrop = Math.min(
          normalizePriceSatang(promo.getAmountOffSatang),
          price
        );
        if (perUnitDrop <= 0) return 0;
        return clampToGross(perUnitDrop * rewardedUnits, gross);
      }

      // PERCENT mode: at 100% the rewarded units are free — compute exactly (no
      // rounding); otherwise round the discounted portion once at the line level.
      const pct = promo.getDiscountPercent;
      if (!isValidPercent(pct)) return 0;
      const raw =
        pct === 100
          ? rewardedUnits * price
          : roundSatang((rewardedUnits * price * pct) / 100);
      return clampToGross(raw, gross);
    }
    default:
      // BILL_THRESHOLD (not a line promo) or an unknown type.
      return 0;
  }
}

/**
 * The raw BILL_THRESHOLD discount (satang) for a given subtotal, BEFORE best/tie
 * selection. Applicable iff `subtotal >= minSubtotalSatang`; otherwise (and for any
 * non-threshold or malformed promo) 0. Clamped to `[0, subtotal]`.
 *
 *  - amount:  `min(amountOffSatang, subtotal)`.
 *  - percent: `roundSatang(subtotal * percentOff / 100)`.
 */
function billPromoCandidateSatang(
  promo: ActivePromotion,
  subtotalSatang: number
): number {
  if (promo?.type !== "BILL_THRESHOLD") return 0;
  const min = promo.minSubtotalSatang;
  // A missing / non-finite / negative threshold is malformed → not applicable.
  if (typeof min !== "number" || !Number.isFinite(min) || min < 0) return 0;
  if (subtotalSatang < Math.trunc(min)) return 0;

  if (isValidPercent(promo.percentOff)) {
    return clampToSubtotal(
      roundSatang((subtotalSatang * promo.percentOff) / 100),
      subtotalSatang
    );
  }
  const amountOff = promo.amountOffSatang;
  if (typeof amountOff === "number" && Number.isFinite(amountOff) && amountOff > 0) {
    return clampToSubtotal(roundSatang(amountOff), subtotalSatang);
  }
  return 0;
}

/**
 * Resolve the manual bill discount to satang using the SAME formulas as
 * `computeTotals` step 3 (see pricing.ts:120-132), computed on the SAME subtotal:
 *  - amount:  `roundSatang(value * 100)`.
 *  - percent: `roundSatang(subtotal * clamp(value, 0, 100) / 100)`.
 * A non-finite / negative `value` is treated as 0 (pricing also validates upstream).
 * NOTE: not yet clamped to `(subtotal − promoBill)`; the caller does that.
 */
function manualBillRawSatang(
  manualBill: BillDiscount | undefined,
  subtotalSatang: number
): number {
  const rawValue =
    manualBill && Number.isFinite(manualBill.value) && manualBill.value >= 0
      ? manualBill.value
      : 0;
  if (manualBill?.type === "percent") {
    const pct = clamp(rawValue, 0, 100);
    return roundSatang((subtotalSatang * pct) / 100);
  }
  // Default to a flat-amount discount for "amount" and any missing/unknown type.
  return Math.max(roundSatang(rawValue * 100), 0);
}

/**
 * Pick the best candidate deterministically: largest `discountSatang` wins; on a
 * tie, the smallest `id` (plain string compare) wins. Candidates with a
 * non-positive discount are dropped (not applied). The selection sorts internally,
 * so the outcome is independent of the input `promotions` order.
 */
function pickBest(
  candidates: Array<{ promo: ActivePromotion; discount: number }>
): { promo: ActivePromotion; discount: number } | null {
  const viable = candidates.filter((c) => c.discount > 0);
  if (viable.length === 0) return null;
  viable.sort((a, b) => {
    if (b.discount !== a.discount) return b.discount - a.discount;
    if (a.promo.id < b.promo.id) return -1;
    if (a.promo.id > b.promo.id) return 1;
    return 0;
  });
  return viable[0];
}

/**
 * Apply promotions to a cart in integer satang, following the Money Contract order.
 * Pure, clock-free, order-independent. See the module header for the full contract.
 *
 * The output's `combinedLineDiscountSatang` (per line) and `combinedBill` are meant
 * to be fed directly into `./pricing` (`computeTotals` client-side,
 * `computeOrderTotals` server-side); `subtotalSatang` is guaranteed to equal what
 * those functions compute for the same lines.
 */
export function applyPromotions(
  lines: PromoCartLine[],
  promotions: ActivePromotion[],
  manualBill: BillDiscount
): PromotionApplication {
  const safeLines = Array.isArray(lines) ? lines : [];
  const safePromos = Array.isArray(promotions) ? promotions : [];

  // Split by role: line promos (types 1-3, product-scoped) vs bill promos.
  const linePromos = safePromos.filter(
    (p) =>
      p != null &&
      (p.type === "PRODUCT_DISCOUNT" ||
        p.type === "FIXED_PRICE" ||
        p.type === "BUY_X_GET_Y")
  );
  const billPromos = safePromos.filter(
    (p) => p != null && p.type === "BILL_THRESHOLD"
  );

  // 1-2. Per line: best product-scoped promo + combined line discount. Track each
  // line's gross so the subtotal (step 3) uses the identical formula as pricing.
  const perLine = safeLines.map((line) => {
    const price = normalizePriceSatang(line?.priceSatang ?? 0);
    const qty = normalizeQty(line?.quantity ?? 0);
    const gross = price * qty;

    // Only promos scoped to this product are candidates.
    const applicable = linePromos.filter(
      (p) => Array.isArray(p.productIds) && p.productIds.includes(line?.productId)
    );
    const best = pickBest(
      applicable.map((p) => ({
        promo: p,
        discount: linePromoCandidateSatang(p, price, qty),
      }))
    );

    const promoDiscountSatang = best ? best.discount : 0;
    const promo: AppliedPromo | null = best
      ? {
          promotionId: best.promo.id,
          promotionName: best.promo.name,
          discountSatang: best.discount,
        }
      : null;

    // Re-clamp the manual per-line discount defensively (floored at 0), then fold
    // promo + manual and cap at gross so a line can never go negative.
    const manualLine = Number.isFinite(line?.manualLineDiscountSatang)
      ? Math.max(Math.trunc(line!.manualLineDiscountSatang as number), 0)
      : 0;
    const combinedLineDiscountSatang = Math.min(
      promoDiscountSatang + manualLine,
      gross
    );

    return { promoDiscountSatang, promo, combinedLineDiscountSatang, gross };
  });

  // 3. Subtotal = Σ max(gross − combined, 0) — the SAME formula as computeTotals,
  // so this equals pricing's subtotal exactly for the same combined line discounts.
  const subtotalSatang = perLine.reduce(
    (sum, l) => sum + Math.max(l.gross - l.combinedLineDiscountSatang, 0),
    0
  );

  // 4. Bill threshold promo (best/tie-break identical to the line rule).
  const bestBill = pickBest(
    billPromos.map((p) => ({
      promo: p,
      discount: billPromoCandidateSatang(p, subtotalSatang),
    }))
  );
  const promoBillDiscountSatang = bestBill
    ? clampToSubtotal(bestBill.discount, subtotalSatang)
    : 0;
  const billPromo: AppliedPromo | null =
    bestBill && promoBillDiscountSatang > 0
      ? {
          promotionId: bestBill.promo.id,
          promotionName: bestBill.promo.name,
          discountSatang: promoBillDiscountSatang,
        }
      : null;

  // 5. Manual bill discount on top, clamped to what's left after the promo bill.
  const manualBillDiscountSatang = Math.min(
    manualBillRawSatang(manualBill, subtotalSatang),
    Math.max(subtotalSatang - promoBillDiscountSatang, 0)
  );

  // 6. One combined bill discount for pricing. See combinedBill's round-trip proof.
  const combinedBill: BillDiscount = {
    type: "amount",
    value: (promoBillDiscountSatang + manualBillDiscountSatang) / 100,
  };

  return {
    lines: perLine.map((l) => ({
      promoDiscountSatang: l.promoDiscountSatang,
      promo: l.promo,
      combinedLineDiscountSatang: l.combinedLineDiscountSatang,
    })),
    subtotalSatang,
    billPromo,
    promoBillDiscountSatang,
    manualBillDiscountSatang,
    combinedBill,
  };
}

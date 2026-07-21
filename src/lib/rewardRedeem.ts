/**
 * Pure reward-redemption resolver for the POS checkout — loyalty program, Phase 3B.
 *
 * A reward = "spend `pointsCost` points, get 1 unit of product P free". The free unit is
 * modeled as a PER-LINE DISCOUNT equal to P's current unit price, injected into the SAME
 * per-line discount input as the cashier's manual "ส่วนลดรายการ" BEFORE `applyPromotions`
 * runs — so the promotion engine's `subtotalSatang` already nets the reward and the
 * checkout drift guard (`totals.subtotalSatang === application.subtotalSatang`) holds
 * UNCHANGED. This module owns the pure part of that flow: validate that every redeemed
 * reward's product is in the cart with enough quantity, and compute the per-product
 * reward discount + attribution + the reward slice of the points spend.
 *
 * Like `./promotionEngine` / `./loyalty` it is **isomorphic** and dependency-free (no
 * Prisma, no next): the identical math runs in the POS client preview and in the
 * authoritative server recompute, so client and server agree to the satang and the point.
 *
 * All money is **integer satang** (1 baht = 100 satang); points are plain non-negative
 * integers. Defensive by construction — a malformed input degrades rather than throwing.
 *
 * INVARIANTS (relied on by the checkout route + adversarial review):
 *  - A reward whose product is NOT in the cart, OR whose product's cart quantity cannot
 *    cover one free unit PER redeemed reward on it, fails the WHOLE redemption
 *    (REWARD_PRODUCT_NOT_IN_CART, naming the offending reward). Two rewards on the same
 *    product require cart qty ≥ 2.
 *  - `discountByProduct[P] = (rewards on P) × P.unitPriceSatang` — the exact free-unit
 *    value the route injects as an extra per-line discount for P. The engine clamps
 *    combined line discount ≤ line gross, so a line can never go negative even if a manual
 *    discount is also present.
 *  - `totalRewardPoints = Σ reward.pointsCost` — the reward slice of the sale's points
 *    spend. The route adds this to the baht-redemption points and decrements the COMBINED
 *    total atomically (one `updateMany WHERE pointsBalance >= combined`), so the member's
 *    balance can never be over-committed across baht + reward redemption.
 */

/** One reward the member is redeeming this sale (resolved from the DB, price from the cart). */
export type RedeemedReward = {
  /** Reward config id (snapshotted onto the OrderItem — no FK). */
  id: string;
  /** Reward display name (Thai) — snapshotted onto the OrderItem for the receipt. */
  name: string;
  /** The free product's Product id. */
  productId: string;
  /** Points the member spends to claim this reward (whole, ≥ 1). */
  pointsCost: number;
};

/** The cart's per-product rollup the resolver validates against (server: DB prices). */
export type CartLineInfo = {
  /** Total quantity of this product across the cart (summed over any duplicate lines). */
  quantity: number;
  /** Current unit price in integer satang (from the DB — the free-unit value). */
  priceSatang: number;
};

/** Per-product attribution snapshot written onto that product's OrderItem line. */
export type RewardAttribution = {
  /** The first redeemed reward's id on this product (snapshot; no FK). */
  rewardId: string;
  /** The redeemed reward name(s) on this product — joined with " + " when more than one. */
  rewardName: string;
  /** The free-unit value on this product line in satang (Σ over rewards on it). */
  rewardDiscountSatang: number;
};

/** The fully-resolved reward redemption for a bill (all money integer satang). */
export type RewardRedemptionPlan = {
  /** productId → the extra per-line discount (satang) to inject before `applyPromotions`. */
  discountByProduct: Map<string, number>;
  /** productId → attribution snapshot for that product's OrderItem line. */
  attributionByProduct: Map<string, RewardAttribution>;
  /** Σ `pointsCost` across every redeemed reward — the reward slice of the points spend. */
  totalRewardPoints: number;
  /** Σ free-unit value across every redeemed reward, in satang (= Σ discountByProduct). */
  totalRewardSatang: number;
};

/** Discriminated result: a valid plan, or a named "product not in cart / not enough qty". */
export type RewardRedemptionResult =
  | { ok: true; plan: RewardRedemptionPlan }
  | { ok: false; code: "REWARD_PRODUCT_NOT_IN_CART"; rewardName: string };

/** Truncate to a non-negative integer; non-finite / negative → 0 (mirrors ./loyalty). */
function toNonNegativeInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * FIX A (adversarial review) — reward vs. line-level-promotion conflict detector.
 *
 * A reward's free unit is modeled as a per-line discount injected into the SAME
 * per-line input as a manual discount, and the promotion engine clamps the SUM of
 * (promo + injected) to the line gross. So a reward stacked on a product that ALSO
 * carries an active line-level promotion (PRODUCT_DISCOUNT / FIXED_PRICE /
 * BUY_X_GET_Y) competes for the same gross ceiling: the member spends full reward
 * points yet the reward delivers less than a whole free unit. For v1 the honest rule
 * is to DISALLOW that stacking (a proportional-value model is out of scope).
 *
 * Pure + order-preserving: returns the FIRST redeemed reward (in input order) whose
 * product is in `productIdsWithLinePromo`, so the route can name it in the 422; null
 * when no reward conflicts. `productIdsWithLinePromo` is the set of productIds scoped
 * to an active line-level promo this sale (a BILL_THRESHOLD promo is bill-level and is
 * intentionally NOT in that set — it never conflicts with a free line unit).
 */
export function findRewardLinePromoConflict(
  rewards: RedeemedReward[],
  productIdsWithLinePromo: ReadonlySet<string>
): RedeemedReward | null {
  const safe = Array.isArray(rewards) ? rewards : [];
  for (const r of safe) {
    if (
      r &&
      typeof r.productId === "string" &&
      r.productId !== "" &&
      productIdsWithLinePromo.has(r.productId)
    ) {
      return r;
    }
  }
  return null;
}

/**
 * Resolve a list of redeemed rewards against the cart. Pure, satang-exact, clock-free.
 *
 * Empty `rewards` → an empty, valid plan (0 discount, 0 points). Otherwise every reward's
 * product MUST appear in `cartByProduct` with quantity ≥ the number of rewards targeting
 * it; the FIRST product that fails fails the whole redemption with the offending reward's
 * name (so the checkout route returns a 422 the cashier can act on).
 */
export function computeRewardRedemption(
  rewards: RedeemedReward[],
  cartByProduct: ReadonlyMap<string, CartLineInfo>
): RewardRedemptionResult {
  const safeRewards = Array.isArray(rewards) ? rewards : [];

  // Group rewards by product IN INPUT ORDER (Map preserves insertion order), tracking the
  // count + ids + names + summed points per product so the qty check and the per-line
  // attribution are both derived from one pass.
  const byProduct = new Map<
    string,
    { count: number; ids: string[]; names: string[]; pointsSum: number; firstName: string }
  >();
  for (const r of safeRewards) {
    const productId = typeof r?.productId === "string" ? r.productId : "";
    if (productId === "") {
      // A reward with no resolvable product can never be satisfied by the cart.
      return { ok: false, code: "REWARD_PRODUCT_NOT_IN_CART", rewardName: r?.name ?? "" };
    }
    const points = toNonNegativeInt(r.pointsCost);
    const group = byProduct.get(productId);
    if (group) {
      group.count += 1;
      group.ids.push(r.id);
      group.names.push(r.name);
      group.pointsSum += points;
    } else {
      byProduct.set(productId, {
        count: 1,
        ids: [r.id],
        names: [r.name],
        pointsSum: points,
        firstName: r.name,
      });
    }
  }

  const discountByProduct = new Map<string, number>();
  const attributionByProduct = new Map<string, RewardAttribution>();
  let totalRewardPoints = 0;
  let totalRewardSatang = 0;

  for (const [productId, group] of byProduct) {
    const cartLine = cartByProduct.get(productId);
    // Not in the cart at all (undefined) OR not enough units to cover one free unit per
    // reward on this product → the redemption can't be honored. Named so the cashier knows
    // which reward to drop or which product to add.
    if (!cartLine || cartLine.quantity < group.count) {
      return {
        ok: false,
        code: "REWARD_PRODUCT_NOT_IN_CART",
        rewardName: group.firstName,
      };
    }
    // Every rewarded unit is worth the product's CURRENT unit price (satang). count × price
    // is the exact per-line discount the route injects for this product.
    const priceSatang = toNonNegativeInt(cartLine.priceSatang);
    const rewardDiscountSatang = group.count * priceSatang;
    discountByProduct.set(productId, rewardDiscountSatang);
    attributionByProduct.set(productId, {
      rewardId: group.ids[0],
      rewardName: group.names.join(" + "),
      rewardDiscountSatang,
    });
    totalRewardPoints += group.pointsSum;
    totalRewardSatang += rewardDiscountSatang;
  }

  return {
    ok: true,
    plan: {
      discountByProduct,
      attributionByProduct,
      totalRewardPoints,
      totalRewardSatang,
    },
  };
}

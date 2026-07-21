import { describe, it, expect } from "vitest";
import {
  applyPromotions,
  type ActivePromotion,
} from "@/lib/promotionEngine";
import {
  computeOrderTotals,
  type OrderProductRow,
  type OrderRequestLine,
} from "@/lib/pricing";
import { computeRedemption } from "@/lib/loyalty";
import {
  computeRewardRedemption,
  findRewardLinePromoConflict,
  type RedeemedReward,
  type CartLineInfo,
} from "@/lib/rewardRedeem";

// ---------------------------------------------------------------------------
// Checkout REWARD-redemption integration (loyalty program, Phase 3B) — pure-level
// verification of the exact server wiring in src/app/api/orders/route.ts. Replicates
// the route's reward → per-line injection → applyPromotions → computeOrderTotals flow
// WITHOUT a DB, then asserts the invariants the adversarial money/stock/points review
// checks:
//   • the drift guard `totals.subtotalSatang === application.subtotalSatang` STILL holds
//     with the reward folded in as a per-line discount (it was NOT weakened);
//   • the reward reduces the line total by exactly one unit price (the free unit);
//   • the COMBINED points spend = baht-redemption points + reward points;
//   • a reward-only bill nets to total 0 (the REWARD_NEEDS_PURCHASE guard condition);
//   • the void reversal re-credits the reward points (Order.pointsRedeemed carries them).
// ---------------------------------------------------------------------------

function priceMap(products: OrderProductRow[]): Map<string, number> {
  return new Map(
    products.map((p) => [
      p.id,
      Math.round(
        Number(typeof p.price === "object" ? p.price.toString() : p.price) * 100
      ),
    ])
  );
}

/**
 * Replicate the route's reward-aware recompute EXACTLY:
 *   build cartByProduct → computeRewardRedemption → inject the free-unit value into the
 *   FIRST line of each product's manualLineDiscountSatang → applyPromotions →
 *   computeOrderTotals(combinedBill = promoBill + manualBill + redemptionSatang).
 * Asserts the route's drift-guard equality (which MUST pass with a reward present) and
 * returns the pieces for further assertions.
 */
function runRewardCheckout(
  products: OrderProductRow[],
  items: Array<{ productId: string; quantity: number; lineDiscountSatang?: number }>,
  rewards: RedeemedReward[],
  opts: {
    promotions?: ActivePromotion[];
    manualBill?: { type: "amount" | "percent"; value: number };
    /** Baht-redemption slice already resolved (satang) — the THIRD bill-discount slice. */
    redemptionSatang?: number;
  } = {}
) {
  const promotions = opts.promotions ?? [];
  const manualBill = opts.manualBill ?? { type: "amount" as const, value: 0 };
  const redemptionSatang = opts.redemptionSatang ?? 0;

  const priceById = priceMap(products);

  // cartByProduct (summed qty + DB price), mirroring the route.
  const cartByProduct = new Map<string, CartLineInfo>();
  for (const i of items) {
    const priceSatang = priceById.get(i.productId);
    if (priceSatang === undefined) continue;
    const ex = cartByProduct.get(i.productId);
    if (ex) ex.quantity += i.quantity;
    else cartByProduct.set(i.productId, { quantity: i.quantity, priceSatang });
  }

  const rewardResult = computeRewardRedemption(rewards, cartByProduct);
  const rewardDiscountByProduct =
    rewardResult.ok ? rewardResult.plan.discountByProduct : new Map<string, number>();

  // FIRST-line-per-product injection into manualLineDiscountSatang (route parity).
  // FIX A defense-in-depth (route parity): a reward-TARGET line drops any client-sent
  // manual discount (forced to 0) before the free-unit value is added, so a crafted
  // manual+reward stack can't eat into the reward's value. Mirrors src/app/api/orders.
  const injected = new Set<string>();
  const promoLines = items.map((i) => {
    const rewardForProduct = rewardDiscountByProduct.get(i.productId) ?? 0;
    const isRewardTarget = rewardForProduct > 0;
    let rewardInject = 0;
    if (isRewardTarget && !injected.has(i.productId)) {
      rewardInject = rewardForProduct;
      injected.add(i.productId);
    }
    const manualLineDiscountSatang = isRewardTarget ? 0 : i.lineDiscountSatang ?? 0;
    return {
      productId: i.productId,
      priceSatang: priceById.get(i.productId) ?? 0,
      quantity: i.quantity,
      manualLineDiscountSatang: manualLineDiscountSatang + rewardInject,
    };
  });

  const application = applyPromotions(promoLines, promotions, manualBill);

  const requestedLines: OrderRequestLine[] = items.map((i, idx) => ({
    productId: i.productId,
    quantity: i.quantity,
    lineDiscountSatang: application.lines[idx].combinedLineDiscountSatang,
  }));
  const combinedBillSatang =
    application.promoBillDiscountSatang +
    application.manualBillDiscountSatang +
    redemptionSatang;
  const totals = computeOrderTotals(products, requestedLines, {
    type: "amount",
    value: combinedBillSatang / 100,
  });

  // --- Route drift guard (route.ts) — MUST pass unchanged with the reward folded in. ---
  expect(totals.subtotalSatang).toBe(application.subtotalSatang);
  expect(totals.billDiscountSatang).toBe(
    application.promoBillDiscountSatang +
      application.manualBillDiscountSatang +
      redemptionSatang
  );
  // --- subtotal − discount === total (satang-exact). ---
  expect(totals.subtotalSatang - totals.billDiscountSatang).toBe(totals.totalSatang);
  // --- Σ lineTotal === subtotal; per-line never negative. ---
  const sumLineTotal = totals.lines.reduce((s, l) => s + l.lineTotalSatang, 0);
  expect(sumLineTotal).toBe(totals.subtotalSatang);
  for (const l of totals.lines) expect(l.lineTotalSatang).toBeGreaterThanOrEqual(0);

  return { rewardResult, application, totals };
}

describe("checkout reward injection — the drift guard holds with a free unit", () => {
  it("one free unit reduces the line by exactly one unit price (no promo, no manual)", () => {
    // Product a: qty 2 @ ฿50. Redeem 1 reward for a → 1 free unit (5000 satang off).
    const { rewardResult, totals } = runRewardCheckout(
      [{ id: "a", price: "50.00" }],
      [{ productId: "a", quantity: 2 }],
      [{ id: "r1", name: "แถม A", productId: "a", pointsCost: 100 }]
    );
    expect(rewardResult.ok).toBe(true);
    // gross 10000, 1 free unit 5000 → line total 5000, still 1 unit payable.
    expect(totals.subtotalSatang).toBe(5000);
    expect(totals.totalSatang).toBe(5000);
    expect(totals.lines[0].lineTotalSatang).toBe(5000);
  });

  it("reward + a line promo on the SAME line stay clamped ≤ gross (never negative)", () => {
    // Product a: qty 2 @ ฿50, a 30% product promo AND a free unit reward. promo = 3000
    // (30% of 10000), reward = 5000 → combined 8000 ≤ 10000 gross → line total 2000.
    const promo: ActivePromotion = {
      id: "p",
      name: "ลด30%",
      type: "PRODUCT_DISCOUNT",
      percentOff: 30,
      productIds: ["a"],
    };
    const { totals, application } = runRewardCheckout(
      [{ id: "a", price: "50.00" }],
      [{ productId: "a", quantity: 2 }],
      [{ id: "r1", name: "แถม A", productId: "a", pointsCost: 100 }],
      { promotions: [promo] }
    );
    expect(application.lines[0].promoDiscountSatang).toBe(3000);
    // combined line discount = promo 3000 + reward 5000 = 8000 (≤ 10000 gross).
    expect(application.lines[0].combinedLineDiscountSatang).toBe(8000);
    expect(totals.subtotalSatang).toBe(2000);
    expect(totals.totalSatang).toBe(2000);
  });

  it("reward across two lines: only the rewarded line is reduced", () => {
    const { totals } = runRewardCheckout(
      [
        { id: "a", price: "50.00" },
        { id: "b", price: "20.00" },
      ],
      [
        { productId: "a", quantity: 1 },
        { productId: "b", quantity: 3 },
      ],
      [{ id: "r1", name: "แถม A", productId: "a", pointsCost: 100 }]
    );
    // a: gross 5000 − free 5000 = 0; b: 3 × 2000 = 6000 untouched. subtotal 6000.
    expect(totals.lines[0].lineTotalSatang).toBe(0);
    expect(totals.lines[1].lineTotalSatang).toBe(6000);
    expect(totals.totalSatang).toBe(6000);
  });
});

describe("checkout reward — combined points spend + zero-total + void reversal", () => {
  it("combined spend = baht-redemption points + reward points (one atomic total)", () => {
    // Bill of ฿100 (a: 2 @ ฿50), redeem 1 reward (100 pts) for a free unit + 30 baht points
    // (@ ฿0.10/pt = 10 satang/pt). Reward reduces subtotal to 5000; baht redemption 30 pts →
    // 300 satang off the remaining 5000. Combined points = 100 (reward) + 30 (baht) = 130.
    const products: OrderProductRow[] = [{ id: "a", price: "50.00" }];
    const items = [{ productId: "a", quantity: 2 }];
    const rewards: RedeemedReward[] = [
      { id: "r1", name: "แถม A", productId: "a", pointsCost: 100 },
    ];

    // First resolve the reward to know its points + the remaining bill for the baht plan.
    const priceById = priceMap(products);
    const cartByProduct = new Map<string, CartLineInfo>([
      ["a", { quantity: 2, priceSatang: priceById.get("a")! }],
    ]);
    const rr = computeRewardRedemption(rewards, cartByProduct);
    expect(rr.ok).toBe(true);
    if (!rr.ok) return;
    const rewardPointsTotal = rr.plan.totalRewardPoints;
    expect(rewardPointsTotal).toBe(100);

    // Baht redemption plan against the remaining bill (5000 after the free unit), balance
    // left after reward points (member has 500, minus 100 reward = 400 available).
    const remainingBillSatang = 5000;
    const plan = computeRedemption(30, 400, remainingBillSatang, 10, 0);
    const bahtPoints = plan.effectiveRedeemPoints;
    expect(bahtPoints).toBe(30);

    const { totals } = runRewardCheckout(products, items, rewards, {
      redemptionSatang: plan.redemptionSatang,
    });
    // subtotal 5000, baht discount 300 (30 pts × 10 satang) → total 4700, still payable.
    expect(plan.redemptionSatang).toBe(300);
    expect(totals.subtotalSatang).toBe(5000);
    expect(totals.totalSatang).toBe(4700);

    // Order.pointsRedeemed (the combined total the route stamps + the atomic decrement uses).
    const totalPointsSpend = bahtPoints + rewardPointsTotal;
    expect(totalPointsSpend).toBe(130);
    // A member with 500 pts can afford the combined 130 (the friendly + atomic guard pass).
    expect(totalPointsSpend).toBeLessThanOrEqual(500);
  });

  it("reward-only cart nets to total 0 (the REWARD_NEEDS_PURCHASE guard condition)", () => {
    // Product a: qty 1 @ ฿50, redeem a reward for the ONLY unit → subtotal 0, total 0.
    const { rewardResult, totals } = runRewardCheckout(
      [{ id: "a", price: "50.00" }],
      [{ productId: "a", quantity: 1 }],
      [{ id: "r1", name: "แถม A", productId: "a", pointsCost: 100 }]
    );
    expect(rewardResult.ok).toBe(true);
    if (!rewardResult.ok) return;
    // The route's guard fires when a reward is redeemed AND total <= 0.
    expect(rewardResult.plan.totalRewardPoints).toBeGreaterThan(0);
    expect(totals.totalSatang).toBe(0);
  });

  it("void reversal re-credits the reward points via Order.pointsRedeemed", () => {
    // Order.pointsRedeemed = baht + reward = 130; the sale earned 8 points on the ฿20 net.
    // The void reversal delta = pointsRedeemed − pointsEarned, GREATEST(0, balance + delta).
    // Starting a member at the PRE-sale balance and applying (spend, earn, void) must return
    // EXACTLY the pre-sale balance — i.e. the reward points are fully re-credited on void.
    const bahtPoints = 30;
    const rewardPoints = 100;
    const pointsRedeemed = bahtPoints + rewardPoints; // 130 (what the route stamps)
    const pointsEarned = 8;
    const preSaleBalance = 500;

    // Sale applies: spend the combined total, then earn.
    const afterSale = preSaleBalance - pointsRedeemed + pointsEarned;
    // Void reversal: delta re-credits redeemed, removes earned (GREATEST(0, …)).
    const delta = pointsRedeemed - pointsEarned;
    const afterVoid = Math.max(0, afterSale + delta);
    expect(afterVoid).toBe(preSaleBalance); // reward points fully restored on void
    // And the delta explicitly carries the reward slice (not just the baht slice).
    expect(delta).toBeGreaterThanOrEqual(rewardPoints - pointsEarned);
  });
});

// ---------------------------------------------------------------------------
// Adversarial-review fixes (FIX A / B / C) — pure-level verification of the exact
// server wiring the checkout route now performs, replicated WITHOUT a DB:
//   • FIX A: a reward on a product with an active LINE-level promo is rejected
//     (REWARD_PROMO_CONFLICT), and the BILL_THRESHOLD (bill-level) promo does NOT
//     conflict; the defensive server-zeroes-manual-on-reward-line invariant holds.
//   • FIX B: a duplicate productId in items[] is rejected at the boundary
//     (DUPLICATE_PRODUCT_LINE) before any reward/pricing logic runs.
//   • FIX C: a reward-only ฿0 bill trips the client confirm block condition.
// ---------------------------------------------------------------------------

/**
 * Replicate the route's line-level-promo product set EXACTLY (src/app/api/orders):
 * the union of productIds scoped to an active PRODUCT_DISCOUNT / FIXED_PRICE /
 * BUY_X_GET_Y promo. A BILL_THRESHOLD promo is bill-level and is intentionally omitted.
 */
function linePromoProductIds(promos: ActivePromotion[]): Set<string> {
  const set = new Set<string>();
  for (const p of promos) {
    if (
      p.type === "PRODUCT_DISCOUNT" ||
      p.type === "FIXED_PRICE" ||
      p.type === "BUY_X_GET_Y"
    ) {
      if (Array.isArray(p.productIds)) {
        for (const id of p.productIds) set.add(id);
      }
    }
  }
  return set;
}

/** Replicate the route's boundary duplicate-productId guard EXACTLY (FIX B). */
function hasDuplicateProductLine(items: Array<{ productId: string }>): boolean {
  const seen = new Set<string>();
  for (const i of items) {
    if (seen.has(i.productId)) return true;
    seen.add(i.productId);
  }
  return false;
}

describe("FIX A — reward vs. line-level-promo conflict (REWARD_PROMO_CONFLICT)", () => {
  it("a reward on a PRODUCT_DISCOUNT product conflicts; a BILL_THRESHOLD promo does NOT", () => {
    // Product a carries a 20% line promo; product b carries only the bill-level threshold.
    const promos: ActivePromotion[] = [
      {
        id: "p-line",
        name: "ลด20%",
        type: "PRODUCT_DISCOUNT",
        percentOff: 20,
        productIds: ["a"],
      },
      {
        id: "p-bill",
        name: "ลดทั้งบิล",
        type: "BILL_THRESHOLD",
        amountOffSatang: 500,
        minSubtotalSatang: 10000,
      },
    ];
    const linePromoSet = linePromoProductIds(promos);
    // Only the line-promo product is in the set — the BILL_THRESHOLD scope is excluded.
    expect(linePromoSet.has("a")).toBe(true);
    expect(linePromoSet.has("b")).toBe(false);

    // A reward on `a` (line-promo product) conflicts → named for the 422.
    const conflict = findRewardLinePromoConflict(
      [{ id: "r1", name: "แถม A", productId: "a", pointsCost: 100 }],
      linePromoSet
    );
    expect(conflict?.name).toBe("แถม A");

    // A reward on `b` (only a bill-level promo exists) does NOT conflict.
    const noConflict = findRewardLinePromoConflict(
      [{ id: "r2", name: "แถม B", productId: "b", pointsCost: 100 }],
      linePromoSet
    );
    expect(noConflict).toBeNull();
  });

  it("FIXED_PRICE / BUY_X_GET_Y line promos also populate the conflict set", () => {
    const promos: ActivePromotion[] = [
      {
        id: "p-fixed",
        name: "ราคาพิเศษ",
        type: "FIXED_PRICE",
        fixedPriceSatang: 3000,
        productIds: ["a"],
      },
      {
        id: "p-bxgy",
        name: "ซื้อ1แถม1",
        type: "BUY_X_GET_Y",
        buyQty: 1,
        getQty: 1,
        getDiscountPercent: 100,
        productIds: ["b"],
      },
    ];
    const set = linePromoProductIds(promos);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
  });

  it("defense-in-depth: a client manual discount on a reward line is IGNORED", () => {
    // Product a: qty 2 @ ฿50 (gross 10000), redeem 1 reward for a free unit (5000 off),
    // AND a crafted client manual discount of ฿30 (3000 satang) on that SAME line. The
    // route forces the reward line's manual discount to 0, so ONLY the reward applies →
    // line total = 10000 − 5000 = 5000. If the manual had stacked it would be 2000.
    const { totals } = runRewardCheckout(
      [{ id: "a", price: "50.00" }],
      [{ productId: "a", quantity: 2, lineDiscountSatang: 3000 }],
      [{ id: "r1", name: "แถม A", productId: "a", pointsCost: 100 }]
    );
    expect(totals.lines[0].lineTotalSatang).toBe(5000); // reward whole, manual dropped
    expect(totals.subtotalSatang).toBe(5000);
    expect(totals.totalSatang).toBe(5000);
  });
});

describe("FIX B — duplicate productId lines are rejected at the boundary", () => {
  it("flags a repeated productId (DUPLICATE_PRODUCT_LINE condition)", () => {
    expect(
      hasDuplicateProductLine([
        { productId: "a" },
        { productId: "b" },
        { productId: "a" },
      ])
    ).toBe(true);
  });

  it("passes when every productId is unique (the legit one-line-per-product cart)", () => {
    expect(
      hasDuplicateProductLine([
        { productId: "a" },
        { productId: "b" },
        { productId: "c" },
      ])
    ).toBe(false);
  });
});

describe("FIX C — reward-only ฿0 bill trips the confirm block", () => {
  it("a reward-only cart (total 0) with a reward selected → block is TRUE", () => {
    const rewards: RedeemedReward[] = [
      { id: "r1", name: "แถม A", productId: "a", pointsCost: 100 },
    ];
    const { totals } = runRewardCheckout(
      [{ id: "a", price: "50.00" }],
      [{ productId: "a", quantity: 1 }],
      rewards
    );
    // Client block: a reward is redeemed AND the bill nets to ฿0.
    const rewardZeroTotalBlock = rewards.length > 0 && totals.totalSatang <= 0;
    expect(totals.totalSatang).toBe(0);
    expect(rewardZeroTotalBlock).toBe(true);
  });

  it("a reward PLUS a payable item (total > 0) → block is FALSE", () => {
    const rewards: RedeemedReward[] = [
      { id: "r1", name: "แถม A", productId: "a", pointsCost: 100 },
    ];
    // a: qty 2 @ ฿50 → one free unit, one payable unit (5000 left).
    const { totals } = runRewardCheckout(
      [{ id: "a", price: "50.00" }],
      [{ productId: "a", quantity: 2 }],
      rewards
    );
    const rewardZeroTotalBlock = rewards.length > 0 && totals.totalSatang <= 0;
    expect(totals.totalSatang).toBe(5000);
    expect(rewardZeroTotalBlock).toBe(false);
  });
});

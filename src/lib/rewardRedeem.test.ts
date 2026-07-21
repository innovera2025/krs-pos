import { describe, it, expect } from "vitest";
import {
  computeRewardRedemption,
  findRewardLinePromoConflict,
  type RedeemedReward,
  type CartLineInfo,
} from "@/lib/rewardRedeem";

// ---------------------------------------------------------------------------
// Pure reward-redemption resolver (loyalty program, Phase 3B). Validates the
// "reward line discount by product" math + the "product in cart with enough qty"
// rule the checkout route relies on before injecting the free-unit value into the
// pricing pipeline. All money is integer satang; points are whole integers.
// ---------------------------------------------------------------------------

function reward(
  id: string,
  productId: string,
  pointsCost: number,
  name = id
): RedeemedReward {
  return { id, name, productId, pointsCost };
}

function cart(entries: Array<[string, number, number]>): Map<string, CartLineInfo> {
  // [productId, quantity, priceSatang]
  const m = new Map<string, CartLineInfo>();
  for (const [productId, quantity, priceSatang] of entries) {
    m.set(productId, { quantity, priceSatang });
  }
  return m;
}

describe("computeRewardRedemption", () => {
  it("empty rewards → a valid empty plan (byte-identical to no redemption)", () => {
    const res = computeRewardRedemption([], cart([["a", 3, 5000]]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.discountByProduct.size).toBe(0);
    expect(res.plan.attributionByProduct.size).toBe(0);
    expect(res.plan.totalRewardPoints).toBe(0);
    expect(res.plan.totalRewardSatang).toBe(0);
  });

  it("one reward, product in cart → discount = unit price, points = pointsCost", () => {
    const res = computeRewardRedemption(
      [reward("r1", "a", 120, "น้ำเปล่าฟรี")],
      cart([["a", 2, 5000]])
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The free-unit value is EXACTLY the product's current unit price (5000 satang).
    expect(res.plan.discountByProduct.get("a")).toBe(5000);
    expect(res.plan.totalRewardSatang).toBe(5000);
    expect(res.plan.totalRewardPoints).toBe(120);
    const attr = res.plan.attributionByProduct.get("a");
    expect(attr).toEqual({
      rewardId: "r1",
      rewardName: "น้ำเปล่าฟรี",
      rewardDiscountSatang: 5000,
    });
  });

  it("product NOT in the cart → REWARD_PRODUCT_NOT_IN_CART, names the reward", () => {
    const res = computeRewardRedemption(
      [reward("r1", "ghost", 50, "ของแถมผี")],
      cart([["a", 1, 5000]])
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("REWARD_PRODUCT_NOT_IN_CART");
    expect(res.rewardName).toBe("ของแถมผี");
  });

  it("two rewards on the SAME product with cart qty 2 → summed discount + joined name", () => {
    const res = computeRewardRedemption(
      [reward("r1", "a", 40, "แถม A"), reward("r2", "a", 60, "แถม B")],
      cart([["a", 2, 5000]])
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Two free units of the same product → 2 × price.
    expect(res.plan.discountByProduct.get("a")).toBe(10000);
    expect(res.plan.totalRewardSatang).toBe(10000);
    expect(res.plan.totalRewardPoints).toBe(100);
    const attr = res.plan.attributionByProduct.get("a");
    expect(attr?.rewardDiscountSatang).toBe(10000);
    expect(attr?.rewardId).toBe("r1"); // first reward's id
    expect(attr?.rewardName).toBe("แถม A + แถม B"); // joined
  });

  it("two rewards on the same product but cart qty 1 → NOT enough units", () => {
    const res = computeRewardRedemption(
      [reward("r1", "a", 40, "แถม A"), reward("r2", "a", 60, "แถม B")],
      cart([["a", 1, 5000]])
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe("REWARD_PRODUCT_NOT_IN_CART");
    // Named as the group's first reward.
    expect(res.rewardName).toBe("แถม A");
  });

  it("rewards across multiple products → per-product discounts + totals", () => {
    const res = computeRewardRedemption(
      [reward("r1", "a", 30), reward("r2", "b", 70)],
      cart([
        ["a", 1, 2500],
        ["b", 4, 9900],
      ])
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.discountByProduct.get("a")).toBe(2500);
    expect(res.plan.discountByProduct.get("b")).toBe(9900);
    expect(res.plan.totalRewardSatang).toBe(12400);
    expect(res.plan.totalRewardPoints).toBe(100);
  });

  it("totalRewardSatang always equals Σ discountByProduct values", () => {
    const res = computeRewardRedemption(
      [reward("r1", "a", 10), reward("r2", "a", 10), reward("r3", "b", 10)],
      cart([
        ["a", 2, 1234],
        ["b", 1, 5678],
      ])
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const sum = Array.from(res.plan.discountByProduct.values()).reduce(
      (s, v) => s + v,
      0
    );
    expect(res.plan.totalRewardSatang).toBe(sum);
    expect(sum).toBe(1234 * 2 + 5678);
  });
});

// ---------------------------------------------------------------------------
// FIX A (adversarial review) — reward vs. line-level-promo conflict detector. A
// reward can't be honestly stacked on a product that already carries an active
// line-level promo (they compete for the same line-gross ceiling), so the route
// rejects it with 422 REWARD_PROMO_CONFLICT naming the offending reward.
// ---------------------------------------------------------------------------
describe("findRewardLinePromoConflict", () => {
  it("empty promo set → no conflict (null)", () => {
    const rewards = [reward("r1", "a", 100), reward("r2", "b", 100)];
    expect(findRewardLinePromoConflict(rewards, new Set())).toBeNull();
  });

  it("no reward product is in the promo set → no conflict (null)", () => {
    const rewards = [reward("r1", "a", 100), reward("r2", "b", 100)];
    expect(findRewardLinePromoConflict(rewards, new Set(["x", "y"]))).toBeNull();
  });

  it("a reward on a promo'd product → returns that reward (named for the 422)", () => {
    const rewards = [reward("r1", "a", 100, "แถม A")];
    const hit = findRewardLinePromoConflict(rewards, new Set(["a"]));
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe("r1");
    expect(hit?.name).toBe("แถม A");
  });

  it("returns the FIRST conflicting reward in input order", () => {
    // b and c both conflict; b comes first in the input → it is named.
    const rewards = [
      reward("r1", "a", 100, "แถม A"),
      reward("r2", "b", 100, "แถม B"),
      reward("r3", "c", 100, "แถม C"),
    ];
    const hit = findRewardLinePromoConflict(rewards, new Set(["c", "b"]));
    expect(hit?.id).toBe("r2");
    expect(hit?.name).toBe("แถม B");
  });

  it("defensive: a reward with an empty productId never matches", () => {
    const rewards: RedeemedReward[] = [
      { id: "r1", name: "แถมผี", productId: "", pointsCost: 100 },
    ];
    expect(findRewardLinePromoConflict(rewards, new Set([""]))).toBeNull();
  });
});

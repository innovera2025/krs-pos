/**
 * Shared types + presentation helpers for the /members "ของรางวัล" (rewards) tab
 * (loyalty program, Phase 3A — CONFIG side only). The reward catalog is loyalty config, so
 * it lives alongside the members surfaces and reuses the GOLD loyalty accent (points
 * figures in gold; distinct from promo=mint, tax/manual=blue).
 *
 * The client `RewardDTO` MIRRORS THE API RESPONSE (src/lib/rewardSerialize.ts) — it is
 * re-declared here (not imported) so this client module never pulls the Node serializer
 * (and Prisma) into the browser bundle, exactly as `PromotionDTO` is separate from the
 * server's `AdminPromotionDTO`.
 */

// Re-export the gold loyalty accent + points formatter so the rewards tab imports one
// place (memberMeta owns the tokens).
export { GOLD, fmtPoints } from "@/components/members/memberMeta";

/** The product snapshot resolved at read time (current name + 2dp price). */
export type RewardProductDTO = {
  id: string;
  name: string;
  /** 2dp baht string (e.g. "59.00") — never a raw Decimal. */
  price: string;
  isActive: boolean;
};

/** A reward as returned by GET /api/rewards (and the detail / POST 201 / PATCH). */
export type RewardDTO = {
  id: string;
  name: string;
  pointsCost: number;
  productId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Current product snapshot, or null when the product was soft-deleted / is unknown. */
  product: RewardProductDTO | null;
};

/**
 * The one-line "สินค้าที่แจก" cell for the admin table — the resolved product name +
 * its current price, or a deleted-product fallback (defensive: a null product must never
 * throw in the table). e.g. "กาแฟเย็น · ฿59.00".
 */
export function rewardGiftLabel(reward: RewardDTO): string {
  if (!reward.product) return "สินค้าถูกลบ";
  return `${reward.product.name} · ฿${reward.product.price}`;
}

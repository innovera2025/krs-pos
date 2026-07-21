import type { Prisma, Reward } from "@prisma/client";
import { toSatang, satangToString } from "@/lib/orderSerialize";

/**
 * Shared reward wire-serialization (loyalty program, Phase 3A — CONFIG side only).
 *
 * Single source of truth for the DTO the reward API emits, so the collection route
 * (`/api/rewards`) and the item route (`/api/rewards/[id]`) stay byte-identical (mirrors
 * `promotionSerialize.ts`).
 *
 * Money discipline: the reward itself carries NO money — `pointsCost` is a plain Int that
 * rides straight through JSON. The referenced product is a PLAIN String snapshot (no FK),
 * so its CURRENT name + price are resolved at READ time and attached as a nested `product`
 * object. That price is a Prisma `Decimal(10,2)`, so it is rendered as a 2dp baht STRING
 * via the shared satang serializer — NEVER left as a raw Decimal (the trailing-zero
 * `toJSON` pitfall). When the referenced product is missing (soft-deleted / unknown id),
 * `product` is null so the surface can show a "สินค้าถูกลบ" fallback without throwing.
 */

/** The nested product snapshot resolved at read time (current name + 2dp-string price). */
export type RewardProductDTO = {
  id: string;
  name: string;
  price: string; // 2dp baht string (e.g. "59.00") — never a raw Decimal
  isActive: boolean;
};

/** The minimal product shape the serializer needs (a Prisma Product projection). */
export type RewardProductLike = {
  id: string;
  name: string;
  price: Prisma.Decimal | string | number; // normalized to satang via toSatang
  isActive: boolean;
};

/**
 * ADMIN / POS DTO — a full reward row plus its resolved product snapshot. No Decimal
 * leaks; dates are ISO strings.
 */
export type RewardDTO = {
  id: string;
  name: string;
  pointsCost: number;
  productId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Current product snapshot (name + 2dp price), or null when the product is gone. */
  product: RewardProductDTO | null;
};

/**
 * Serialize a Reward row + its resolved product (or null) into the wire DTO. The caller
 * looks the product up by `reward.productId` (a plain-String snapshot) and passes it in;
 * a null product yields `product: null` (the product was soft-deleted / never existed).
 */
export function serializeReward(
  reward: Reward,
  product: RewardProductLike | null
): RewardDTO {
  return {
    id: reward.id,
    name: reward.name,
    pointsCost: reward.pointsCost,
    productId: reward.productId,
    isActive: reward.isActive,
    createdAt: reward.createdAt.toISOString(),
    updatedAt: reward.updatedAt.toISOString(),
    product: product
      ? {
          id: product.id,
          name: product.name,
          price: satangToString(toSatang(product.price)),
          isActive: product.isActive,
        }
      : null,
  };
}

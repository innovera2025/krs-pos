import { Prisma } from "@prisma/client";

/**
 * Shared order wire-serialization (Financial/Inventory correctness — FIX 1).
 *
 * Every order response (GET/POST /api/orders AND every PATCH /api/orders/[id]
 * return site) must emit IDENTICAL money fields: 2dp baht STRINGS extracted via
 * integer satang. Relying on Prisma Decimal's implicit `toJSON()` is unsafe — it
 * drops trailing zeros ("65.00" -> "65", "0.00" -> "0"), so a PATCH that returned
 * a raw Prisma record produced malformed money strings that diverged from the
 * GET/POST contract (the Sales-History in-memory row then carried "65" instead of
 * "65.00"). This module is the single source of truth for that contract, mirroring
 * serializeShift() in shift/route.ts.
 *
 * The serializer is shape-tolerant by design: it accepts any order whose money
 * fields are Decimal | string | number and whose items/payments carry the money
 * fields it touches. This keeps it compatible with BOTH the ORDER_INCLUDE shape
 * (orders/route.ts) and the ORDER_DETAIL_INCLUDE shape (orders/[id]/route.ts)
 * without forcing the two route files to share an include constant.
 */

/** A Decimal-like / numeric money value as it arrives from Prisma. */
type Money = Prisma.Decimal | string | number | null | undefined;

/** Convert a Prisma Decimal | string | number to integer satang (exact). */
export function toSatang(v: Money): number {
  if (v === null || v === undefined) return 0;
  const str = typeof v === "object" ? v.toString() : String(v);
  const n = Number(str);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Format integer satang as a 2dp baht string (e.g. 19234 -> "192.34"). */
export function satangToString(satang: number): string {
  return (satang / 100).toFixed(2);
}

/** Render a single Money value as the 2dp baht string the wire contract expects. */
function money(v: Money): string {
  return satangToString(toSatang(v));
}

/** The minimal order shape the serializer needs (header + items + payments money). */
type SerializableOrder = {
  subtotal: Money;
  tax: Money;
  discount: Money;
  total: Money;
  amountPaid: Money;
  change: Money;
  // Bill-level promotion slice of `discount` (promotions program, Phase 6). A 2dp
  // Decimal(10,2) that must NOT leak as a raw Decimal (trailing-zero pitfall), so it
  // joins the money map. `billPromotionId`/`billPromotionName` are plain fields that
  // pass through the `...order` spread untouched.
  promoBillDiscount: Money;
  // Loyalty points earned on this sale (loyalty program, Phase 1B). A plain Int (NOT
  // money) — it needs no Decimal→string transform, so it rides the `...order` spread
  // through to the wire untouched. Declared here to make it an explicit part of the
  // serialized order contract (the receipt + POS read it as `order.pointsEarned`).
  pointsEarned: number;
  // Loyalty points redeemed on this sale (loyalty program, Phase 2). A plain Int, like
  // `pointsEarned` — rides the `...order` spread untouched. The receipt renders it as
  // "(−N แต้ม)" beside the redemption discount row.
  pointsRedeemed: number;
  // Baht slice of `discount` bought with redeemed points (loyalty program, Phase 2). A
  // 2dp Decimal(10,2) that MUST NOT leak as a raw Decimal (trailing-zero pitfall: "0"
  // instead of "0.00"), so it JOINS the money map below — mirroring `promoBillDiscount`.
  // The receipt derives the separate redemption row from it (and subtracts it from the
  // manual bill discount so the manual row never double-counts the redemption).
  pointsRedemptionDiscount: Money;
  items: Array<
    // `promoDiscount` is the per-line promo slice of `lineTotal` (2dp Decimal) — it
    // joins the item money map for the same trailing-zero reason. `rewardDiscount` is the
    // reward free-unit slice (loyalty program, Phase 3B), likewise a 2dp Decimal that MUST
    // NOT leak as a raw Decimal ("0" instead of "0.00"), so it joins the money map too.
    // `promotionId`/`promotionName`/`rewardId`/`rewardName` pass through the `...it` spread.
    {
      unitPrice: Money;
      lineTotal: Money;
      promoDiscount: Money;
      rewardDiscount: Money;
    } & Record<string, unknown>
  >;
  payments: Array<{ amount: Money } & Record<string, unknown>>;
} & Record<string, unknown>;

/** An order with all money fields rendered as 2dp strings (the wire contract). */
export type SerializedOrder<T extends SerializableOrder> = Omit<
  T,
  | "subtotal"
  | "tax"
  | "discount"
  | "total"
  | "amountPaid"
  | "change"
  | "promoBillDiscount"
  | "pointsRedemptionDiscount"
  | "items"
  | "payments"
> & {
  subtotal: string;
  tax: string;
  discount: string;
  total: string;
  amountPaid: string;
  change: string;
  promoBillDiscount: string;
  pointsRedemptionDiscount: string;
  items: Array<
    Omit<
      T["items"][number],
      "unitPrice" | "lineTotal" | "promoDiscount" | "rewardDiscount"
    > & {
      unitPrice: string;
      lineTotal: string;
      promoDiscount: string;
      rewardDiscount: string;
    }
  >;
  payments: Array<Omit<T["payments"][number], "amount"> & { amount: string }>;
};

/**
 * Serialize an order for the wire with EXPLICIT Decimal->string money fields.
 *
 * Applies to ALL order responses so GET/POST/PATCH emit identical 2dp-string
 * money fields (the contract OrderDTO expects). Generic over the concrete order
 * shape so both ORDER_INCLUDE and ORDER_DETAIL_INCLUDE payloads pass through with
 * their extra relations (cashier/customer/product) preserved.
 */
export function serializeOrder<T extends SerializableOrder>(
  order: T
): SerializedOrder<T> {
  return {
    ...order,
    subtotal: money(order.subtotal),
    tax: money(order.tax),
    discount: money(order.discount),
    total: money(order.total),
    amountPaid: money(order.amountPaid),
    change: money(order.change),
    // Promotions program (Phase 6): the bill-level promo slice is a 2dp string in the
    // same money contract; `billPromotionId`/`billPromotionName` flow through `...order`.
    promoBillDiscount: money(order.promoBillDiscount),
    // Loyalty redemption (loyalty program, Phase 2): the points-redemption slice of
    // `discount` as a 2dp string ("0.00" when none). Same trailing-zero fix as
    // `promoBillDiscount`; `pointsRedeemed` (Int) flows through `...order` untouched.
    pointsRedemptionDiscount: money(order.pointsRedemptionDiscount),
    items: order.items.map((it) => ({
      ...it,
      unitPrice: money(it.unitPrice),
      lineTotal: money(it.lineTotal),
      // Per-line promo slice as a 2dp string; `promotionId`/`promotionName` flow through `...it`.
      promoDiscount: money(it.promoDiscount),
      // Reward free-unit slice as a 2dp string (loyalty program, Phase 3B); "0.00" when no
      // reward on the line. `rewardId`/`rewardName` flow through `...it` untouched.
      rewardDiscount: money(it.rewardDiscount),
    })),
    payments: order.payments.map((p) => ({
      ...p,
      amount: money(p.amount),
    })),
  } as SerializedOrder<T>;
}

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
  items: Array<{ unitPrice: Money; lineTotal: Money } & Record<string, unknown>>;
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
  | "items"
  | "payments"
> & {
  subtotal: string;
  tax: string;
  discount: string;
  total: string;
  amountPaid: string;
  change: string;
  items: Array<
    Omit<T["items"][number], "unitPrice" | "lineTotal"> & {
      unitPrice: string;
      lineTotal: string;
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
    items: order.items.map((it) => ({
      ...it,
      unitPrice: money(it.unitPrice),
      lineTotal: money(it.lineTotal),
    })),
    payments: order.payments.map((p) => ({
      ...p,
      amount: money(p.amount),
    })),
  } as SerializedOrder<T>;
}

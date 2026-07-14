import type { Promotion } from "@prisma/client";
import type { ActivePromotion } from "@/lib/promotionEngine";

/**
 * Shared promotion wire-serialization (promotions program, Phase 4).
 *
 * Single source of truth for the two DTO shapes the promotion API emits, so the
 * collection route (`/api/promotions`) and the item route (`/api/promotions/[id]`)
 * stay byte-identical. Mirrors the `orderSerialize.ts` precedent.
 *
 * Money discipline:
 *  - satang Int columns (`amountOffSatang`, `fixedPriceSatang`, `minSubtotalSatang`)
 *    pass straight through as JSON numbers — they are already exact integers.
 *  - `percentOff` is a Prisma `Decimal(5,2)`; it is serialized via `Number(...)` to a
 *    plain number, NEVER left as a Decimal (whose `toJSON` drops trailing zeros — the
 *    trailing-zero pitfall that bit the order money strings). Percent has no
 *    trailing-zero contract here, so a number is the correct, pitfall-free shape.
 *  - dates → ISO strings.
 */

/**
 * ADMIN DTO — the full promotion row (strict-ADMIN surface: GET default / GET [id] /
 * POST 201 / PATCH). No Decimal leaks; dates are ISO strings.
 */
export type AdminPromotionDTO = {
  id: string;
  name: string;
  code: string | null;
  type: Promotion["type"];
  isActive: boolean;
  branchId: string;
  startsAt: string | null;
  endsAt: string | null;
  percentOff: number | null;
  amountOffSatang: number | null;
  fixedPriceSatang: number | null;
  buyQty: number | null;
  getQty: number | null;
  getDiscountPercent: number | null;
  minSubtotalSatang: number | null;
  productIds: string[];
  createdAt: string;
  updatedAt: string;
};

/** Serialize a full Promotion row for the strict-ADMIN management surface. */
export function serializeAdminPromotion(row: Promotion): AdminPromotionDTO {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    type: row.type,
    isActive: row.isActive,
    branchId: row.branchId,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    percentOff: row.percentOff !== null ? Number(row.percentOff) : null,
    amountOffSatang: row.amountOffSatang,
    fixedPriceSatang: row.fixedPriceSatang,
    buyQty: row.buyQty,
    getQty: row.getQty,
    getDiscountPercent: row.getDiscountPercent,
    minSubtotalSatang: row.minSubtotalSatang,
    productIds: row.productIds,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Serialize a Promotion row to the client-safe `ActivePromotion` DTO the POS engine
 * consumes (`GET /api/promotions?view=pos`). Emits ONLY the fields relevant to each
 * type — NO timestamps, code, isActive, branchId, or window instants leak to a cashier.
 * `productIds` is included for the line-level types (1-3) and omitted for BILL_THRESHOLD.
 */
export function serializePosPromotion(row: Promotion): ActivePromotion {
  const base = { id: row.id, name: row.name, type: row.type };

  switch (row.type) {
    case "PRODUCT_DISCOUNT": {
      const dto: ActivePromotion = { ...base, productIds: row.productIds };
      if (row.percentOff !== null) dto.percentOff = Number(row.percentOff);
      else if (row.amountOffSatang !== null) dto.amountOffSatang = row.amountOffSatang;
      return dto;
    }
    case "FIXED_PRICE": {
      const dto: ActivePromotion = { ...base, productIds: row.productIds };
      if (row.fixedPriceSatang !== null) dto.fixedPriceSatang = row.fixedPriceSatang;
      return dto;
    }
    case "BUY_X_GET_Y": {
      const dto: ActivePromotion = { ...base, productIds: row.productIds };
      if (row.buyQty !== null) dto.buyQty = row.buyQty;
      if (row.getQty !== null) dto.getQty = row.getQty;
      if (row.getDiscountPercent !== null) dto.getDiscountPercent = row.getDiscountPercent;
      return dto;
    }
    case "BILL_THRESHOLD": {
      const dto: ActivePromotion = { ...base };
      if (row.minSubtotalSatang !== null) dto.minSubtotalSatang = row.minSubtotalSatang;
      if (row.percentOff !== null) dto.percentOff = Number(row.percentOff);
      else if (row.amountOffSatang !== null) dto.amountOffSatang = row.amountOffSatang;
      return dto;
    }
    default:
      return base;
  }
}

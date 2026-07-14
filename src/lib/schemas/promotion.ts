import { z } from "zod";

/**
 * Promotion request schemas (promotions program, Phase 4).
 *
 * ⚠️ NODE-ONLY SERVER MODULE — do not import from a client/edge bundle (the sibling
 * `_shared.ts` note applies: these are used only from Node route handlers).
 *
 * FULL validation (not WRAP): unlike the orders POST schema (which is shape-only and
 * keeps money/precision guards manual in the route), the promotion create/patch
 * schemas own the complete SHAPE + VALUE contract. The route keeps only the checks a
 * schema CANNOT do: cross-field date-window ordering, product-existence against the
 * DB, `type`-immutability on PATCH, per-type field legality against the EXISTING row,
 * and P2002 → CODE_TAKEN mapping.
 *
 * Money is expressed in **BAHT numbers** at the boundary (what the admin UI sends) and
 * converted to **integer satang** in the route (`Math.round(v * 100)`), matching the
 * Promotion model's satang Int columns. Percentages are stored as-is in the Decimal(5,2)
 * `percentOff` column.
 *
 * 2-DECIMAL GUARD: `Math.round(v * 100) === v * 100` — the SAME guard the checkout money
 * boundary uses (`src/app/api/orders/route.ts` BAD_DISCOUNT precision check). It is kept
 * identical here on purpose so a baht value accepted as a promotion amount is accepted
 * the same way everywhere money enters the system. (Caveat: this exact expression is
 * float-fragile for some 2dp inputs — e.g. 19.99 — but mirroring the established checkout
 * guard is the deliberate, consistent choice over a divergent epsilon variant.)
 */

/** Decimal(10,2) / satang-Int cap in baht: 99,999,999.99. */
const AMOUNT_MAX = 99_999_999.99;

/** True when `v` carries at most 2 decimal places (repo-canonical checkout guard). */
function hasAtMostTwoDecimals(v: number): boolean {
  return Math.round(v * 100) === v * 100;
}

/**
 * A baht money amount: finite, strictly > 0, ≤ `max`, at most 2 decimal places. Used
 * for `amountOff`, `fixedPrice`, and `minSubtotal`; converted to satang in the route.
 */
function bahtMoney(max: number) {
  return z
    .number({ message: "ต้องเป็นจำนวนเงินที่ถูกต้อง" })
    .finite("ต้องเป็นจำนวนเงินที่ถูกต้อง")
    .gt(0, "จำนวนเงินต้องมากกว่า 0")
    .max(max, "จำนวนเงินเกินช่วงที่อนุญาต")
    .refine(hasAtMostTwoDecimals, {
      message: "รองรับทศนิยมไม่เกิน 2 ตำแหน่ง",
    });
}

/** A discount percentage: finite, > 0, ≤ 100, at most 2 decimal places. */
const percentOffSchema = z
  .number({ message: "ต้องเป็นเปอร์เซ็นต์ที่ถูกต้อง" })
  .finite("ต้องเป็นเปอร์เซ็นต์ที่ถูกต้อง")
  .gt(0, "เปอร์เซ็นต์ต้องมากกว่า 0")
  .max(100, "เปอร์เซ็นต์ต้องไม่เกิน 100")
  .refine(hasAtMostTwoDecimals, {
    message: "รองรับทศนิยมไม่เกิน 2 ตำแหน่ง",
  });

/**
 * Product scope for the line-level types (PRODUCT_DISCOUNT / FIXED_PRICE / BUY_X_GET_Y).
 * "cuid-ish" bounded strings (leniently validated as non-empty, ≤ 64 chars) — the ROUTE
 * does the authoritative existence check against the DB (→ 422 UNKNOWN_PRODUCT), so this
 * only bounds shape/size. Array length 1..200.
 */
const productIdsSchema = z
  .array(z.string().min(1, "รหัสสินค้าไม่ถูกต้อง").max(64, "รหัสสินค้ายาวเกินไป"))
  .min(1, "ต้องเลือกสินค้าอย่างน้อย 1 รายการ")
  .max(200, "เลือกสินค้าได้ไม่เกิน 200 รายการ");

/** A trimmed Thai display name, 1..200 chars. */
const nameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "กรุณากรอกชื่อโปรโมชัน").max(200, "ชื่อโปรโมชันยาวเกินไป"));

/**
 * CREATE `code`: optional coupon/reference code. Absent/blank → null (no code); a
 * provided string is trimmed and must be ≤ 50 chars. `.nullish().transform()` coerces an
 * absent key to null, which is the correct default at CREATE time.
 */
const createCodeSchema = z
  .string()
  .max(50, "รหัสโปรโมชันยาวเกินไป")
  .nullish()
  .transform((v) => {
    const t = typeof v === "string" ? v.trim() : "";
    return t.length > 0 ? t : null;
  });

/**
 * Base fields shared by every promotion type (spread into each discriminated-union
 * member). `startsAt`/`endsAt` are ISO datetime strings (UTC instants) or null; the
 * route converts them to `Date` and enforces the start < end ordering (BAD_DATE_WINDOW).
 */
const baseShape = {
  name: nameSchema,
  code: createCodeSchema,
  isActive: z.boolean().optional(),
  startsAt: z.iso.datetime({ message: "รูปแบบวันที่เริ่มไม่ถูกต้อง" }).nullish(),
  endsAt: z.iso.datetime({ message: "รูปแบบวันที่สิ้นสุดไม่ถูกต้อง" }).nullish(),
};

/**
 * XOR refinement for the "% off OR ฿ off" types: exactly one of `percentOff` /
 * `amountOff` must be present.
 */
const percentOrAmountXor = (d: { percentOff?: number; amountOff?: number }) =>
  (d.percentOff != null) !== (d.amountOff != null);
const XOR_MESSAGE = "ต้องระบุส่วนลดเป็นเปอร์เซ็นต์หรือจำนวนเงินอย่างใดอย่างหนึ่ง";

/** PRODUCT_DISCOUNT: product-scoped, % off OR ฿ off per unit. */
const productDiscountSchema = z
  .object({
    ...baseShape,
    type: z.literal("PRODUCT_DISCOUNT"),
    productIds: productIdsSchema,
    percentOff: percentOffSchema.optional(),
    amountOff: bahtMoney(AMOUNT_MAX).optional(),
  })
  .refine(percentOrAmountXor, { message: XOR_MESSAGE, path: ["percentOff"] });

/** FIXED_PRICE: product-scoped special per-unit price. */
const fixedPriceSchema = z.object({
  ...baseShape,
  type: z.literal("FIXED_PRICE"),
  productIds: productIdsSchema,
  fixedPrice: bahtMoney(AMOUNT_MAX),
});

/** BUY_X_GET_Y: product-scoped, buy `buyQty` get `getQty` at `getDiscountPercent` off. */
const buyXGetYSchema = z.object({
  ...baseShape,
  type: z.literal("BUY_X_GET_Y"),
  productIds: productIdsSchema,
  buyQty: z
    .number()
    .int("ต้องเป็นจำนวนเต็ม")
    .min(1, "ต้องมากกว่าหรือเท่ากับ 1")
    .max(1000, "เกินช่วงที่อนุญาต"),
  getQty: z
    .number()
    .int("ต้องเป็นจำนวนเต็ม")
    .min(1, "ต้องมากกว่าหรือเท่ากับ 1")
    .max(1000, "เกินช่วงที่อนุญาต"),
  getDiscountPercent: z
    .number()
    .int("ต้องเป็นจำนวนเต็ม")
    .min(1, "ต้องมากกว่าหรือเท่ากับ 1")
    .max(100, "ต้องไม่เกิน 100"),
});

/** BILL_THRESHOLD: whole-bill spend gate, % off OR ฿ off. No productIds. */
const billThresholdSchema = z
  .object({
    ...baseShape,
    type: z.literal("BILL_THRESHOLD"),
    minSubtotal: bahtMoney(AMOUNT_MAX),
    percentOff: percentOffSchema.optional(),
    amountOff: bahtMoney(AMOUNT_MAX).optional(),
  })
  .refine(percentOrAmountXor, { message: XOR_MESSAGE, path: ["percentOff"] });

/**
 * POST /api/promotions body — discriminated on `type`. Exactly one shape per type; the
 * route converts baht → satang and applies the cross-field guards a schema cannot.
 */
export const PromotionCreateSchema = z.discriminatedUnion("type", [
  productDiscountSchema,
  fixedPriceSchema,
  buyXGetYSchema,
  billThresholdSchema,
]);

export type PromotionCreateInput = z.infer<typeof PromotionCreateSchema>;

/**
 * PATCH `code`: unlike the CREATE code, this MUST preserve key-absence so a patch that
 * doesn't mention `code` never clears it. `.transform(trim).nullable().optional()` keeps
 * an absent key OMITTED (no coercion to null), while an explicit `null` clears the code
 * and a string is trimmed (≤ 50). The route normalizes a trimmed-empty string to null.
 */
const patchCodeSchema = z
  .string()
  .max(50, "รหัสโปรโมชันยาวเกินไป")
  .transform((s) => s.trim())
  .nullable()
  .optional();

/**
 * PATCH /api/promotions/[id] body — every field OPTIONAL, and `type` is INTENTIONALLY
 * ABSENT: the promotion type is immutable (change type = deactivate + recreate). The
 * route detects a client-sent `type` on the RAW body (Zod would silently strip it) and
 * returns TYPE_IMMUTABLE.
 *
 * Per-type value fields are all optional here because the schema cannot know the row's
 * type. The ROUTE validates each provided value field against the EXISTING row's type
 * (→ 400 BAD_FIELD_FOR_TYPE for a field that belongs to another type).
 */
export const PromotionPatchSchema = z.object({
  name: nameSchema.optional(),
  code: patchCodeSchema,
  isActive: z.boolean().optional(),
  startsAt: z.iso.datetime({ message: "รูปแบบวันที่เริ่มไม่ถูกต้อง" }).nullish(),
  endsAt: z.iso.datetime({ message: "รูปแบบวันที่สิ้นสุดไม่ถูกต้อง" }).nullish(),
  productIds: productIdsSchema.optional(),
  percentOff: percentOffSchema.optional(),
  amountOff: bahtMoney(AMOUNT_MAX).optional(),
  fixedPrice: bahtMoney(AMOUNT_MAX).optional(),
  buyQty: z
    .number()
    .int("ต้องเป็นจำนวนเต็ม")
    .min(1, "ต้องมากกว่าหรือเท่ากับ 1")
    .max(1000, "เกินช่วงที่อนุญาต")
    .optional(),
  getQty: z
    .number()
    .int("ต้องเป็นจำนวนเต็ม")
    .min(1, "ต้องมากกว่าหรือเท่ากับ 1")
    .max(1000, "เกินช่วงที่อนุญาต")
    .optional(),
  getDiscountPercent: z
    .number()
    .int("ต้องเป็นจำนวนเต็ม")
    .min(1, "ต้องมากกว่าหรือเท่ากับ 1")
    .max(100, "ต้องไม่เกิน 100")
    .optional(),
  minSubtotal: bahtMoney(AMOUNT_MAX).optional(),
});

export type PromotionPatchInput = z.infer<typeof PromotionPatchSchema>;

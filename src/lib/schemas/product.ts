import { z } from "zod";

/**
 * Product request schemas (NODE-ONLY — do not import from client/edge).
 *
 * These validate SHAPE + TYPE at the JSON-parse boundary. The route handlers keep
 * their domain-specific responses (CATEGORY_NOT_FOUND existence pre-check, P2002 →
 * SKU_TAKEN/BARCODE_TAKEN) AFTER a successful parse. Bounds mirror the Decimal/Int4
 * columns and the existing PATCH caps so CREATE and UPDATE stay consistent.
 */

/** Decimal(10,2) price max: 99,999,999.99. Postgres Int4 stock max: 2,147,483,647. */
const PRICE_MAX = 99_999_999.99;
const INT4_MAX = 2_147_483_647;

/** A real, finite, non-negative money amount within the Decimal(10,2) range. */
const priceSchema = z
  .number()
  .finite()
  .min(0, "ราคาต้องไม่ติดลบ")
  .max(PRICE_MAX, "ราคาเกินช่วงที่อนุญาต");

/** A non-negative integer within the Postgres Int4 range. */
const stockSchema = z
  .number()
  .int("จำนวนสต็อกต้องเป็นจำนวนเต็ม")
  .min(0, "จำนวนสต็อกต้องไม่ติดลบ")
  .max(INT4_MAX, "จำนวนสต็อกเกินช่วงที่อนุญาต");

/**
 * POST /api/products body. `name`/`sku` trimmed-non-empty with caps (name ≤ 200,
 * sku ≤ 100), strict-number `price` (no string coercion — drops the old Number()),
 * optional `stock`, optional nullable `barcode` (≤ 64) and `categoryId`.
 */
export const ProductPostBodySchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "กรุณากรอกชื่อสินค้า").max(200, "ชื่อสินค้ายาวเกินไป")),
  sku: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "กรุณากรอก SKU").max(100, "SKU ยาวเกินไป")),
  price: priceSchema,
  stock: stockSchema.optional(),
  barcode: z
    .string()
    .max(64, "บาร์โค้ดยาวเกินไป")
    .nullish()
    .transform((v) => {
      const t = typeof v === "string" ? v.trim() : "";
      return t.length > 0 ? t : null;
    }),
  categoryId: z
    .string()
    .nullish()
    .transform((v) => {
      const t = typeof v === "string" ? v.trim() : "";
      return t.length > 0 ? t : null;
    }),
});

export type ProductPostBody = z.infer<typeof ProductPostBodySchema>;

/**
 * PATCH /api/products/[id] body — partial update. Each field optional; `categoryId`
 * and `barcode` accept null (disconnect / clear). The handler keeps the category
 * existence pre-check and P2025/P2002 mapping after parse.
 */
export const ProductPatchBodySchema = z.object({
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "ชื่อสินค้าไม่ถูกต้อง").max(200, "ชื่อสินค้ายาวเกินไป"))
    .optional(),
  price: priceSchema.optional(),
  stock: stockSchema.optional(),
  // null = disconnect category; string = connect (existence checked in handler).
  categoryId: z.string().min(1, "หมวดหมู่ไม่ถูกต้อง").nullable().optional(),
  // null = clear barcode; string (≤64, trimmed) = set.
  barcode: z.string().max(64, "บาร์โค้ดยาวเกินไป").nullable().optional(),
  isActive: z.boolean().optional(),
});

export type ProductPatchBody = z.infer<typeof ProductPatchBodySchema>;

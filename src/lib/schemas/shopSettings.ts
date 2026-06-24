import { z } from "zod";

/**
 * ShopSettings (receipt print-size) request schema (NODE-ONLY — do NOT import
 * from a client component, `src/auth.config.ts`, or `src/middleware.ts`; it is
 * imported only by the Node-runtime route handler).
 *
 * Validates the PATCH /api/settings body SHAPE + BOUNDS at the parse boundary,
 * returning the standard `{ error, code: "VALIDATION", issues }` contract via
 * `parseBody`. Bounds:
 *   - receiptWidthMm   : integer 40–120 (covers 58mm + 80mm thermal + free input)
 *   - receiptHeightMm  : integer 50–400, NULLABLE (null = "auto" height)
 *   - receiptHeightAuto: boolean
 *
 * Cross-field coupling has two directions:
 *   - auto=true  ⇒ height null: enforced in the ROUTE after parse — the route
 *     forces `receiptHeightMm = null` whenever `receiptHeightAuto` is true, so a
 *     client that sends a stale mm value alongside auto is normalized rather than
 *     rejected.
 *   - auto=false ⇒ height required: enforced HERE via `.superRefine()` — a fixed
 *     height with `receiptHeightMm` null/undefined is incoherent (a "fixed height
 *     with no value" row), so the schema rejects it with the VALIDATION contract
 *     instead of writing a meaningless row. (The UI always sends both fields, so
 *     a patch that sets auto=false must carry a valid mm.)
 */

/** Thermal receipt width bounds (mm). 58 + 80 are the common presets; the free
 *  input is clamped to this range so an out-of-range mm never reaches @page. */
const WIDTH_MIN = 40;
const WIDTH_MAX = 120;

/** Fixed-height bounds (mm). Only applies when `receiptHeightAuto` is false. */
const HEIGHT_MIN = 50;
const HEIGHT_MAX = 400;

const widthSchema = z
  .number()
  .int("ความกว้างต้องเป็นจำนวนเต็ม")
  .min(WIDTH_MIN, `ความกว้างต้องไม่น้อยกว่า ${WIDTH_MIN}mm`)
  .max(WIDTH_MAX, `ความกว้างต้องไม่เกิน ${WIDTH_MAX}mm`);

/** A fixed height in mm within bounds, or null (= auto). */
const heightSchema = z
  .number()
  .int("ความสูงต้องเป็นจำนวนเต็ม")
  .min(HEIGHT_MIN, `ความสูงต้องไม่น้อยกว่า ${HEIGHT_MIN}mm`)
  .max(HEIGHT_MAX, `ความสูงต้องไม่เกิน ${HEIGHT_MAX}mm`)
  .nullable();

/**
 * Seller-identity field schemas (seller-company-settings). All are OPTIONAL in the
 * PATCH body: `undefined` = "not sent, leave unchanged"; an empty string "" is
 * ALLOWED and means "clear this field" (the ROUTE normalizes "" → null before the
 * upsert so storage stays consistent — null = not set). The shape/length bounds
 * here mirror the legacy `SELLER_*` ENV validation in src/lib/env.ts so DB-sourced
 * values are held to the same §86/4 rigor as ENV-sourced ones.
 */
// 13-digit TIN when provided; "" allowed (clears the value).
const sellerTaxIdSchema = z
  .string()
  .regex(/^\d{13}$/, "เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก")
  .or(z.literal(""))
  .optional();
// 5-digit RD branch code when provided; "" allowed (clears the value).
const sellerBranchCodeSchema = z
  .string()
  .regex(/^\d{5}$/, "รหัสสาขาต้องมี 5 หลัก")
  .or(z.literal(""))
  .optional();

/**
 * PATCH /api/settings body. The three receipt-size fields are REQUIRED so the
 * admin Save sends a complete, self-consistent receipt-size definition; the route
 * then normalizes `receiptHeightMm` to null when `receiptHeightAuto` is true before
 * the upsert. The seven seller-identity fields are OPTIONAL (see schemas above) so
 * a partial PATCH leaves unsent seller fields unchanged.
 */
export const ShopSettingsPatchBodySchema = z
  .object({
    receiptWidthMm: widthSchema,
    receiptHeightAuto: z.boolean(),
    receiptHeightMm: heightSchema,
    // Seller identity (all optional; route trims + nulls empty strings).
    sellerName: z.string().max(200, "ชื่อกิจการต้องไม่เกิน 200 ตัวอักษร").optional(),
    sellerTaxId: sellerTaxIdSchema,
    sellerAddress: z.string().max(300, "ที่อยู่ต้องไม่เกิน 300 ตัวอักษร").optional(),
    sellerPhone: z.string().max(50, "เบอร์โทรต้องไม่เกิน 50 ตัวอักษร").optional(),
    sellerPosId: z.string().max(50, "รหัส POS ต้องไม่เกิน 50 ตัวอักษร").optional(),
    sellerBranchCode: sellerBranchCodeSchema,
    sellerBranchLabel: z
      .string()
      .max(100, "ชื่อสาขาต้องไม่เกิน 100 ตัวอักษร")
      .optional(),
  })
  // Fixed height (auto=false) must carry a concrete in-bounds mm value. Without
  // this, `{ receiptHeightAuto:false, receiptHeightMm:null }` passes (heightMm is
  // .nullable()) and writes an incoherent "fixed height with no value" row. The
  // numeric bounds (50–400) are already enforced by `heightSchema`; here we only
  // reject the null/undefined case when auto is false.
  .superRefine((data, ctx) => {
    if (data.receiptHeightAuto === false && data.receiptHeightMm == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["receiptHeightMm"],
        message: "ต้องระบุความสูงเมื่อปิดความสูงอัตโนมัติ",
      });
    }
  });

export type ShopSettingsPatchBody = z.infer<typeof ShopSettingsPatchBodySchema>;

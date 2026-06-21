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
 * PATCH /api/settings body. All three fields are required so the admin Save sends
 * a complete, self-consistent receipt-size definition; the route then normalizes
 * `receiptHeightMm` to null when `receiptHeightAuto` is true before the upsert.
 */
export const ShopSettingsPatchBodySchema = z
  .object({
    receiptWidthMm: widthSchema,
    receiptHeightAuto: z.boolean(),
    receiptHeightMm: heightSchema,
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

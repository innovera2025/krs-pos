import { z } from "zod";

/**
 * Shift request schema (NODE-ONLY — do not import from client/edge).
 *
 * Discriminated union on `action`. WRAP style: this validates SHAPE only. The
 * route keeps its domain logic AFTER parse — round2() conversion, SHIFT_ALREADY_OPEN
 * / NO_OPEN_SHIFT 409 gates, shift-number generation, and the close-path "no count"
 * (null/empty) handling. Money inputs are bounded to the Decimal(10,2) range here so
 * an oversized float is rejected at the boundary (400) instead of a 500 overflow.
 */

/** Decimal(10,2) max: 99,999,999.99. */
const MONEY_MAX = 99_999_999.99;

/** A finite, non-negative money amount within the Decimal(10,2) range. */
const moneySchema = z
  .number()
  .finite("ต้องเป็นจำนวนเงินที่ถูกต้อง")
  .min(0, "ต้องไม่ติดลบ")
  .max(MONEY_MAX, "จำนวนเงินเกินช่วงที่อนุญาต");

/**
 * { action: "open", openingFloat? } — opening float optional (defaults handled in
 * the route); when present it must be a finite non-negative number ≤ Decimal max.
 */
const ShiftOpenSchema = z.object({
  action: z.literal("open"),
  openingFloat: moneySchema.optional(),
});

/**
 * { action: "close", countedCash? } — countedCash optional. The route treats
 * null/undefined/"" as "no count" (closes with countedCash = null). A PROVIDED
 * value must be a finite non-negative number; `null` is allowed (explicit no-count).
 * The empty-string case from older clients is handled by the route's noCount check
 * before Zod sees a non-string, so countedCash here is number | null | undefined.
 */
const ShiftCloseSchema = z.object({
  action: z.literal("close"),
  countedCash: moneySchema.nullish(),
});

export const ShiftPostBodySchema = z.discriminatedUnion("action", [
  ShiftOpenSchema,
  ShiftCloseSchema,
]);

export type ShiftPostBody = z.infer<typeof ShiftPostBodySchema>;

/**
 * Action-only shape gate for the WRAP. The route validates the money inputs MANUALLY
 * (via Number(raw) coercion, mirroring the existing close-path pattern) so a numeric
 * STRING like "50" is still accepted — therefore the action gate must NOT reject on
 * the money fields. This schema checks only that `action` is "open" | "close".
 */
export const ShiftActionSchema = z.object({
  action: z.enum(["open", "close"]),
});

import { z } from "zod";

/**
 * Reward catalog request schemas (loyalty program, Phase 3A — CONFIG side only).
 *
 * ⚠️ NODE-ONLY SERVER MODULE — do not import from a client/edge bundle (the sibling
 * `_shared.ts` note applies: these are used only from Node route handlers). This
 * module is Prisma-free (plain Zod), so it is unit-testable in the vitest node
 * environment (see `reward.test.ts`).
 *
 * FULL validation (mirrors the promotion schema convention): the create/patch schemas
 * own the complete SHAPE + VALUE contract. The route keeps only the checks a schema
 * CANNOT do: product-existence (+ active) against the DB (→ 422 UNKNOWN_PRODUCT) and
 * P2025 → 404 mapping.
 *
 * A reward is "spend `pointsCost` points, get the `productId` product free". `pointsCost`
 * is a whole INTEGER of points (NO money/Decimal here — the product's baht price is
 * resolved at read time by the serializer, never stored on the reward). `productId` is a
 * bounded non-empty string; the ROUTE does the authoritative existence + active check.
 */

/** A trimmed Thai display name, 1..200 chars (mirrors the promotion `nameSchema`). */
const nameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "กรุณากรอกชื่อของรางวัล").max(200, "ชื่อของรางวัลยาวเกินไป"));

/**
 * Points cost — a whole integer ≥ 1, capped at 1,000,000 (the same fat-finger/overflow
 * magnitude cap the member adjust schema uses). A reward that costs 0 points is not a
 * reward; the DB column is a plain Int, so no Decimal handling is needed.
 */
const pointsCostSchema = z
  .number({ message: "แต้มที่ใช้ต้องเป็นตัวเลข" })
  .int("แต้มที่ใช้ต้องเป็นจำนวนเต็ม")
  .min(1, "แต้มที่ใช้ต้องมากกว่าหรือเท่ากับ 1")
  .max(1_000_000, "แต้มที่ใช้เกินช่วงที่อนุญาต");

/**
 * The free product's id — a bounded non-empty string (leniently validated as ≤ 64 chars,
 * "cuid-ish"). The ROUTE does the authoritative existence + active check against the DB
 * (→ 422 UNKNOWN_PRODUCT), so this only bounds shape/size (mirrors the promotion
 * `productIdsSchema` element rule).
 */
const productIdSchema = z
  .string()
  .min(1, "กรุณาเลือกสินค้าที่จะแจก")
  .max(64, "รหัสสินค้าไม่ถูกต้อง");

/**
 * POST /api/rewards body — create a reward. `name` + `pointsCost` + `productId` required;
 * `isActive` defaults to true (a new reward is live unless created disabled).
 */
export const RewardPostBodySchema = z.object({
  name: nameSchema,
  pointsCost: pointsCostSchema,
  productId: productIdSchema,
  isActive: z.boolean().optional().default(true),
});

export type RewardPostBody = z.infer<typeof RewardPostBodySchema>;

/**
 * PATCH /api/rewards/[id] body — partial edit / soft-delete toggle. Every field OPTIONAL;
 * only the provided keys are touched. `productId` MAY be changed (the route re-validates
 * the new id against the DB). An `isActive` transition is the activate/deactivate toggle
 * (audited as REWARD_ACTIVATED / REWARD_DEACTIVATED); any other field edit is
 * REWARD_UPDATED. There is deliberately NO DELETE (soft-delete via isActive only).
 */
export const RewardPatchBodySchema = z.object({
  name: nameSchema.optional(),
  pointsCost: pointsCostSchema.optional(),
  productId: productIdSchema.optional(),
  isActive: z.boolean().optional(),
});

export type RewardPatchBody = z.infer<typeof RewardPatchBodySchema>;

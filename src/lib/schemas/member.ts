import { z } from "zod";

/**
 * Member request schemas (loyalty program, Phase 1B — members management screen).
 *
 * ⚠️ NODE-ONLY SERVER MODULE — do not import from a client/edge bundle (the sibling
 * `_shared.ts` note applies: these are used only from Node route handlers). This
 * module is Prisma-free (plain Zod), so it is unit-testable in the vitest node
 * environment (see `member.test.ts`).
 *
 * MemberAdjustBodySchema validates POST /api/members/[id]/adjust — a MANUAL admin
 * points correction: a SIGNED, NON-ZERO integer delta (+ credit / − debit) plus an
 * optional short note. It validates SHAPE only; the balance-sufficiency check for a
 * negative delta (points can never go below 0) is a DB-level concern enforced
 * atomically in the route (`updateMany WHERE pointsBalance >= -points`), NOT here —
 * duplicating it as a Zod bound would be wrong (the Zod layer can't see the balance).
 *
 * Bounds guard a fat-finger / overflow: the magnitude is capped at 1,000,000 points
 * (well above any real single correction) and the note at 200 chars.
 */

/** Signed, non-zero integer points delta, magnitude ≤ 1,000,000. */
const pointsDeltaSchema = z
  .number({ message: "แต้มต้องเป็นตัวเลข" })
  .int("แต้มต้องเป็นจำนวนเต็ม")
  .refine((n) => n !== 0, "กรุณาระบุจำนวนแต้มที่ต้องการปรับ (ต้องไม่เท่ากับ 0)")
  .refine((n) => Math.abs(n) <= 1_000_000, "จำนวนแต้มเกินช่วงที่อนุญาต");

/** Optional note — trimmed, ≤ 200; empty / whitespace → null. */
const noteSchema = z
  .string()
  .max(200, "หมายเหตุยาวเกินไป")
  .nullish()
  .transform((v) => {
    const t = typeof v === "string" ? v.trim() : "";
    return t.length > 0 ? t : null;
  });

/**
 * POST /api/members/[id]/adjust body — a manual admin points adjustment. `points`
 * is a signed non-zero integer; `note` is optional context stored on the ledger row.
 */
export const MemberAdjustBodySchema = z.object({
  points: pointsDeltaSchema,
  note: noteSchema,
});

export type MemberAdjustBody = z.infer<typeof MemberAdjustBodySchema>;

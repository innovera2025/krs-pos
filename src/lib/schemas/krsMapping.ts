import { z } from "zod";
import {
  PRODUCT_IMPORT,
  PRODUCT_TARGET_FIELD_SET,
} from "@/lib/krs/mapping";

/**
 * KRS field-mapping request schema (NODE-ONLY — do NOT import from a client
 * component, `src/auth.config.ts`, or `src/middleware.ts`; imported only by the
 * Node-runtime KRS mapping route handler).
 *
 * Validates the PATCH /api/krs/mappings body SHAPE + BOUNDS at the parse boundary
 * (via `parseBody`), returning the standard `{ error, code: "VALIDATION", issues }`
 * contract. This is the FIRST gate — it bounds the SHAPE/CHARSET only. The route
 * then performs a SECOND, server-side gate (validateMapping) that confirms the
 * `sourceTable` + every mapped column actually EXIST in the live KRS schema before
 * persisting (a 422 otherwise). Zod cannot know the live schema, so it does not try.
 *
 * Bounds (the injection floor — every value can become a QUOTENAME'd SQL identifier
 * in the refactored `fetchKrsProducts`, so an unbounded / metachar-laden value is
 * the attack surface even though QUOTENAME neutralizes it):
 *
 *   - function    : fixed literal "PRODUCT_IMPORT" (the only wired function today).
 *   - sourceTable : 1–128 chars, conservative SQL Server identifier charset.
 *   - fieldMap    : object whose KEYS ⊆ the known PRODUCT_IMPORT target fields and
 *                   whose VALUES are 1–128-char identifier-charset column names.
 *                   The required-field presence + live existence are enforced in the
 *                   route (validateMapping), not here.
 */

/** Conservative SQL Server identifier charset (table / column names). Mirrors the
 *  `IDENT_RE` used for database/username in `krsSettings.ts`. Rejects whitespace,
 *  control chars, brackets, `;`, `@`, `/`, `\` — anything used to smuggle SQL. */
const IDENT_RE = /^[a-zA-Z0-9_.\-]+$/;
const IDENT_MAX = 128;

/** A bounded SQL Server identifier (table or column name). */
const identifier = (label: string) =>
  z
    .string()
    .min(1, `ต้องระบุ${label}`)
    .max(IDENT_MAX, `${label}ต้องไม่เกิน ${IDENT_MAX} ตัวอักษร`)
    .regex(IDENT_RE, `${label}มีอักขระที่ไม่อนุญาต`);

/**
 * The `fieldMap` object. `z.record` keys can't be constrained to a literal union at
 * the Zod-key level, so we `superRefine` to reject ANY key that is not a known
 * PRODUCT_IMPORT target field (keys ⊆ the known set). Each value is a bounded
 * identifier. An empty map is allowed by the shape; the route's required-field check
 * (validateMapping → MISSING_REQUIRED) rejects a map missing a required field.
 */
const fieldMapSchema = z
  .record(z.string(), identifier("ชื่อคอลัมน์"))
  .superRefine((map, ctx) => {
    for (const key of Object.keys(map)) {
      if (!PRODUCT_TARGET_FIELD_SET.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `ฟิลด์ปลายทางไม่รู้จัก · unknown target field "${key}"`,
        });
      }
    }
  });

export const KrsMappingPatchBodySchema = z.object({
  function: z.literal(PRODUCT_IMPORT),
  sourceTable: identifier("ชื่อตาราง"),
  fieldMap: fieldMapSchema,
});

export type KrsMappingPatchBody = z.infer<typeof KrsMappingPatchBodySchema>;

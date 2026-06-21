import { z } from "zod";

/**
 * Audit-log query schema (NODE-ONLY — do not import from client/edge).
 *
 * GET /api/audit-logs uses query params (not a JSON body). The route keeps its
 * existing `action` enum check (→ 400 BAD_ACTION). This adds the only verified
 * validation gap: `actorId` length ≤ 40 (CUID length) → 400 BAD_ACTOR_ID. Exported
 * as a standalone string schema the route applies to the raw `actorId` param.
 */
export const AuditActorIdSchema = z
  .string()
  .min(1)
  .max(40, "actorId ยาวเกินไป");

export type AuditActorId = z.infer<typeof AuditActorIdSchema>;

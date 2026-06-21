import { z } from "zod";

/**
 * Sync-job request schemas (NODE-ONLY — do not import from client/edge).
 *
 * WRAP style: validate SHAPE only. The routes keep their domain logic — status
 * gates (INVALID_STATE), P2025 → NOT_FOUND, the simulated KRS canned responses, and
 * the skip "—" default for an empty reason — AFTER a successful parse.
 */

/** POST /api/sync-jobs — simulated data-flow action. */
export const SyncJobPostBodySchema = z.object({
  action: z.enum(["pull", "insert-all"], { message: "action must be 'pull' or 'insert-all'" }),
});

export type SyncJobPostBody = z.infer<typeof SyncJobPostBodySchema>;

/**
 * PATCH /api/sync-jobs/[id] action shape (retry/skip). The `reason` length cap is
 * validated separately in the route (only when it is a string) so a non-string
 * reason keeps its existing silent-ignore → "—" default behavior; this schema gates
 * only the action enum.
 */
export const SyncJobPatchActionSchema = z.object({
  action: z.enum(["retry", "skip"], { message: "action must be 'retry' or 'skip'" }),
});

export type SyncJobPatchAction = z.infer<typeof SyncJobPatchActionSchema>;

/**
 * The skip `reason` cap: ≤ 500 chars (it is written verbatim into SyncJob.response,
 * a TEXT column; an unbounded reason is a write-amplification vector). Applied in the
 * route only when `reason` is a string.
 */
export const SyncJobReasonSchema = z.string().max(500, "เหตุผลยาวเกินไป");

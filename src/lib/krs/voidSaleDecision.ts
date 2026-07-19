// Pure decision logic for voiding a bill: given the latest SALE SyncJob's status (or
// null when none exists), which void PATH must the orders route take? SPLIT OUT of the
// route so the status→path mapping is unit-testable in isolation (like cancelSaleResolve).
//
// This closes two holes the job-status decision fixes (vs the old Order.syncStatus one):
//   • an UNSYNCED bill's PENDING SALE job would still write to KRS ~30s after the void
//     (the dispatcher claims by SyncJob.status alone) → orphan ERP doc. We must NEUTRALIZE
//     that job in the same tx.
//   • a bill synced BEFORE the syncStatus→SYNCED flip shipped reads syncStatus=PENDING, so
//     the old check sent it down the unsynced path and NEVER enqueued a VOID job → the ERP
//     docs stood. Reading the SALE job's real status (SYNCED) routes it correctly.
//
// `import type` keeps this module runtime-pure (the @prisma/client import is erased), so
// the test loads it with zero heavy/side-effecting imports (matches the existing test set).

import type { SyncJobStatus } from "@prisma/client";

/**
 * The four void paths:
 *  - `skip-local`     — no SALE job, or an already-SKIPPED one (can never be claimed, no
 *                       ERP write pending, nothing to cancel): VOIDED + syncStatus SKIPPED,
 *                       no VOID job. (Legacy/simulated-era + the neutralize success case.)
 *  - `enqueue-void`   — the SALE reached KRS (status SYNCED): VOIDED + keep syncStatus
 *                       SYNCED (corrects a stale PENDING on pre-deploy bills) + enqueue the
 *                       VOID SyncJob to close the 4 ERP documents.
 *  - `needs-reconcile`— the SALE is NEEDS_RECONCILE (burned anchor, ambiguous ERP state):
 *                       never guess — 409, an operator must resolve it first.
 *  - `neutralize`     — the SALE is PENDING/RETRYING/FAILED and MIGHT still be claimed by
 *                       the dispatcher: the route must atomically flip it SKIPPED in-tx
 *                       (guarded by the dispatch-lock window). On success → treat as
 *                       `skip-local`; if a fresh lock blocks it (mid-flight write) → 409.
 */
export type VoidSalePath =
  | "skip-local"
  | "enqueue-void"
  | "needs-reconcile"
  | "neutralize";

/** Map the latest SALE SyncJob's status (null = no SALE job at all) to a void path.
 *  Pure: no I/O. The route turns `neutralize` into an in-tx conditional updateMany. */
export function decideVoidSalePath(saleJobStatus: SyncJobStatus | null): VoidSalePath {
  if (saleJobStatus == null) return "skip-local";
  switch (saleJobStatus) {
    case "SYNCED":
      return "enqueue-void";
    case "NEEDS_RECONCILE":
      return "needs-reconcile";
    case "SKIPPED":
      // Already neutralized/deduped — the claim query takes only PENDING/RETRYING, so it
      // can never write to KRS and there is nothing to cancel: the local skip path.
      return "skip-local";
    case "PENDING":
    case "RETRYING":
    case "FAILED":
      return "neutralize";
    default:
      // Exhaustive today; default keeps a future enum value on the safe (neutralize) path.
      return "neutralize";
  }
}

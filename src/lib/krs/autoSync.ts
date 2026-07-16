// NODE-ONLY. KRS inbound auto-pull — now the ≤60s FULL-RECONCILE SAFETY NET (krs-sync
// inbound auto-pull; refactored by krs-realtime-inbound P1). Imported only by Node-runtime
// server code (the /api/krs/auto-sync route) — NEVER from a client component,
// `src/auth.config.ts`, or `src/middleware.ts` (it pulls in the `mssql` driver via the KRS
// read helpers and the Prisma singleton).
//
// ── WHAT CHANGED IN P1 (the 15-07-26-incident file, refactored) ────────────────────────
// This module USED to own a "global pass" that read the KRS global `sp_Onhand
// @Warehouse=NULL` aggregate and chased it with a delta against the global snapshot. That
// global aggregate is internally BROKEN on the KRS side (references/
// krs-onhand-global-discrepancy_REPORT_15-07-26.md — 667/972 items returned 0) and was the
// exact cause of the 15-07-26 incident (checkout INSUFFICIENT_STOCK on sellable items).
//
// That global pass is RETIRED. `runAutoSync` is now a THIN WRAPPER over the ONE shared
// reconcile engine (`reconcileStock` in stockReconcile.ts), invoked with scope="ALL":
//   1. Product refresh (UNCHANGED): fetchKrsProducts + importKrsProducts (whole active
//      catalogue) — new/updated KRS items land as POS Product rows first.
//   2. reconcileStock(config, "ALL") — WAREHOUSE-SCOPED reads only; Product.stock is
//      derived as Σ per-warehouse scoped answers via per-warehouse deltas. The broken
//      global call is NEVER issued. The run-lock now lives inside reconcileStock and is
//      SHARED with the realtime rt-poll path (one lock → the two callers cannot double-
//      apply). See stockReconcile.ts for the full incident-guard proof.
//
// The cron cadence is UNCHANGED (the krs-cron sidecar still POSTs /api/krs/auto-sync every
// KRS_AUTO_SYNC_INTERVAL_SECONDS). Its ROLE changed: it is no longer the primary path — it
// is the drift-correcting SAFETY NET that also catches edits/un-approvals/deletes the
// realtime watermark detector can't see. The EXTERNAL response contract (AutoSyncResult
// shape) is preserved so the endpoint's JSON is unchanged.
//
// `options.warehouse` (the old KRS_AUTO_SYNC_WAREHOUSE global filter) is now a NO-OP: there
// is no more global pass to filter, and reconcileStock always visits every warehouse (a
// per-warehouse view is required to compute Σ correctly). Flagged as a P3 cleanup
// candidate (deprecate the env var later; do not silently repurpose it here).

import sql from "mssql";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { fetchKrsProducts } from "./products";
import { importKrsProducts } from "./importProducts";
import { reconcileStock, type ReconcileSummary } from "./stockReconcile";
import { publishKrsEvent } from "./events";

/** Default branch for the multi-branch-ready data model (single-store deploy). */
const DEFAULT_BRANCH_ID = "BR-01";

/** Options for one auto-sync (safety-net) run. */
export type AutoSyncOptions = {
  /** LEGACY / NO-OP: the old KRS_AUTO_SYNC_WAREHOUSE global-pass filter. There is no more
   *  global pass; reconcileStock always visits every warehouse. Kept for call-site
   *  compatibility; flagged as a P3 deprecation candidate. */
  warehouse: string | null;
  /** Branch id stamped onto written StockMovement rows. Defaults to BR-01. */
  branchId?: string;
  /** Optional caller-supplied run id (else a UUID is minted). */
  runId?: string;
};

/** Status of an auto-sync run (also the SyncJob/response status surface). Preserved as the
 *  external contract; ABORTED_EMPTY_KRS is retained for shape-compatibility (the shared
 *  engine now handles an empty scoped result by skipping that warehouse, so it is no longer
 *  produced here). */
export type AutoSyncStatus =
  | "OK" // run completed, all writes succeeded
  | "PARTIAL" // run completed, one or more item writes failed (non-fatal)
  | "SKIPPED_LOCKED" // another run holds the shared lock
  | "SKIPPED_MANUAL_MODE" // KrsConnectionSettings.syncMode === "manual"
  | "ABORTED_EMPTY_KRS" // legacy (empty sp_Onhand) — no longer produced; kept for shape
  | "FAILED_PRODUCT_UPSERT" // KRS product upsert threw — run aborted, no stock change
  | "FAILED_KRS_FETCH"; // scoped sp_Onhand threw — run aborted, no stock change

/** The typed result of an auto-sync run (returned to the API + UI consumers). Shape
 *  UNCHANGED from before the P1 refactor. */
export type AutoSyncResult = {
  status: AutoSyncStatus;
  runId: string;
  /** Net signed stock delta actually APPLIED across all items this run. */
  delta: number;
  /** Number of POS products whose stock was updated this run. */
  updated: number;
  /** Number of items touched but whose stock did NOT change (idempotent skips). */
  skipped: number;
  /** Number of new POS products created by the product upsert this run. */
  newProducts?: number;
  /** Sanitized error strings (never KRS secrets / raw driver objects). */
  errors: string[];
};

/** A sanitized error message for logs/results — never the raw mssql driver object or
 *  config (which can embed the password). Mirrors the client.ts sanitization. */
function safeErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}

/** Record a SyncJob row for UI/badge visibility + audit. PULL direction. Best-effort: a
 *  SyncJob write failure must NOT mask the run result, so it is wrapped and only logged. */
async function recordSyncJob(
  runId: string,
  status: "SYNCED" | "FAILED",
  error: string | null,
  meta?: { updated: number; skipped: number; totalDelta: number; newProducts: number }
): Promise<void> {
  try {
    await prisma.syncJob.create({
      data: {
        type: "PULL",
        direction: "PULL",
        ref: runId,
        status,
        provider: "KRS",
        error: error ?? null,
        response: meta ? JSON.stringify(meta) : null,
        branchId: DEFAULT_BRANCH_ID,
      },
    });
  } catch (e) {
    logger.error({ err: safeErrMsg(e), krsAutoSync: { runId } }, "KRS auto-sync: SyncJob write failed");
  }
}

/** Map the shared engine's `ReconcileSummary.status` onto the external `AutoSyncStatus`. */
function mapStatus(reconcileStatus: ReconcileSummary["status"]): AutoSyncStatus {
  switch (reconcileStatus) {
    case "SKIPPED_LOCKED":
      return "SKIPPED_LOCKED";
    case "SKIPPED_MANUAL_MODE":
      return "SKIPPED_MANUAL_MODE";
    case "OK":
    case "NOOP":
    default:
      return "OK";
  }
}

/**
 * Run one inbound safety-net reconcile (product refresh + full Σ-per-warehouse stock
 * reconcile). See the file header + stockReconcile.ts.
 *
 * @param config  An already-built mssql `sql.config` (from buildConnectionConfig). This
 *                module NEVER builds the config itself (the route owns that).
 * @param options Branch + optional run id (`warehouse` is a legacy no-op).
 */
export async function runAutoSync(
  config: sql.config,
  options: AutoSyncOptions
): Promise<AutoSyncResult> {
  const runId = options.runId ?? randomUUID();
  const branchId = options.branchId ?? DEFAULT_BRANCH_ID;

  // === STEP 1: Product refresh (UNCHANGED) — new/updated KRS items become POS rows first.
  // FAIL-SAFE: if the KRS read or upsert throws, abort the whole run with no stock change.
  let newProductCount = 0;
  try {
    const krsProducts = await fetchKrsProducts(config);
    const importResult = await importKrsProducts(krsProducts);
    newProductCount = importResult.created;
  } catch (productErr) {
    const msg = safeErrMsg(productErr);
    logger.error(
      { krsErr: msg, krsAutoSync: { runId } },
      "KRS auto-sync: product upsert failed — aborting run"
    );
    await recordSyncJob(runId, "FAILED", `Product upsert failed: ${msg}`);
    return { status: "FAILED_PRODUCT_UPSERT", runId, delta: 0, updated: 0, skipped: 0, errors: [msg] };
  }

  // === STEP 2: Full Σ-per-warehouse stock reconcile via the ONE shared engine (scope=ALL).
  // reconcileStock owns the shared run-lock, the manual-mode gate, the warehouse-scoped
  // reads (NEVER the broken global call), the empty-result protection, and the atomic
  // per-cycle write transaction. A KRS read fault re-throws → map to FAILED_KRS_FETCH.
  let summary: ReconcileSummary;
  try {
    summary = await reconcileStock(config, "ALL", { branchId, runId });
  } catch (reconcileErr) {
    const msg = safeErrMsg(reconcileErr);
    logger.error(
      { krsErr: msg, krsAutoSync: { runId } },
      "KRS auto-sync: reconcile failed (KRS fetch) — aborting run"
    );
    await recordSyncJob(runId, "FAILED", `Reconcile failed: ${msg}`);
    return { status: "FAILED_KRS_FETCH", runId, delta: 0, updated: 0, skipped: 0, errors: [msg] };
  }

  const status = mapStatus(summary.status);
  const skipped = Math.max(0, summary.itemsTouched - summary.stockUpdated);

  // === STEP 3: Record SyncJob + summary log (unchanged pattern/cadence). ===
  await recordSyncJob(runId, "SYNCED", null, {
    updated: summary.stockUpdated,
    skipped,
    totalDelta: summary.totalDelta,
    newProducts: newProductCount,
  });

  logger.info(
    {
      krsAutoSync: {
        runId,
        status: summary.status,
        updated: summary.stockUpdated,
        totalDelta: summary.totalDelta,
        newProducts: newProductCount,
        warehouses: summary.warehouses.length,
      },
    },
    "KRS auto-sync (safety-net reconcile) completed"
  );

  // SSE (P2 wiring): announce the sweep cycle. stock-update events for any drift the
  // sweep caught were already published inside reconcileStock (single publish point).
  publishKrsEvent({
    type: "sync-status",
    source: "auto-sync",
    at: new Date().toISOString(),
    itemsTouched: summary.itemsTouched,
  });

  return {
    status,
    runId,
    delta: summary.totalDelta,
    updated: summary.stockUpdated,
    skipped,
    newProducts: newProductCount,
    errors: [],
  };
}

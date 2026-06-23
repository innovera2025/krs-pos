// NODE-ONLY. KRS inbound auto-pull delta engine (krs-sync inbound auto-pull).
// Imported only by Node-runtime server code (the /api/krs/auto-sync route) — NEVER
// from a client component, `src/auth.config.ts`, or `src/middleware.ts` (it pulls
// in the `mssql` driver via the KRS read helpers and the Prisma singleton).
//
// WHAT THIS DOES (and why it is NOT sync-stock): the manual POST /api/krs/sync-stock
// route does an ABSOLUTE baseline overwrite (Product.stock = KRS on-hand). That is
// correct for a store-closed full reset, but WRONG for continuous scheduled pulls
// because it would erase POS-owned sale deductions (Phase 2 outbound is not built —
// KRS has not seen the sale, so its on-hand still reflects the pre-sale qty). This
// module instead applies the DELTA only:
//
//   delta = currentKrsQty − lastSeenKrsQty   (the ERP-originated movement since the
//                                              last pull: receipts/adjustments)
//
// applied ON TOP of the current POS stock. POS-owned sale deductions are preserved.
// See the plan §1/§7 for the full Model-C ownership proof.
//
// CROSS-ENGINE SEPARATION (invariant): KRS is read via the mssql helpers
// (`fetchKrsStockBalances` / `fetchKrsProducts`) using the passed `sql.config`; ALL
// POS writes go through the `prisma` singleton. The two are NEVER mixed — no mssql
// call lives inside a Prisma `$transaction`, and this module never opens its own
// Prisma client.
//
// FAIL-SAFE (invariant): any KRS-side fault (product upsert throws, sp_Onhand
// throws) ABORTS the run with NO stock change and records a FAILED SyncJob. An
// empty sp_Onhand result while we have known prior snapshots also aborts (it is
// almost certainly a KRS data condition, not "every item is gone") — never a
// mass-zero-out. POS stock is NEVER zeroed or corrupted by a KRS fault.

import sql from "mssql";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { fetchKrsStockBalances, type KrsStockBalance } from "./stock";
import { fetchKrsProducts } from "./products";
import { importKrsProducts } from "./importProducts";

/** The run-lock sentinel itemCode. A magic key that can never be a real KRS
 *  ItemCode (real codes follow a product-code format like "F01-0001"). The single
 *  row at this id carries `lockedAt`; it is NEVER a product snapshot and is always
 *  excluded from delta computation. */
const LOCK_ITEM_CODE = "__LOCK__";

/** A lock older than this is treated as stale (a crashed prior run) and reclaimed.
 *  Generous vs. the expected 10–30s run so a slow-but-live run is never stolen. */
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

/** Default branch for the multi-branch-ready data model (single-store deploy). */
const DEFAULT_BRANCH_ID = "BR-01";

/** POS `Product.stock` is a 32-bit Postgres Int — cap applied deltas so an absurd
 *  KRS ledger value can never overflow the column (a 500). Mirrors sync-stock. */
const POS_STOCK_MAX = 2_147_483_647;

/** Float-equality epsilon for the fractional KRS Balqty (delta == 0 detection). */
const DELTA_EPSILON = 0.0001;

/** Options for one auto-sync run. */
export type AutoSyncOptions = {
  /** KRS warehouse filter (`KRS_AUTO_SYNC_WAREHOUSE`), or null = all warehouses. */
  warehouse: string | null;
  /** Branch id stamped onto written StockMovement rows. Defaults to BR-01. */
  branchId?: string;
  /** Optional caller-supplied run id (else a UUID is minted). */
  runId?: string;
};

/** Status of an auto-sync run (also the SyncJob/response status surface). */
export type AutoSyncStatus =
  | "OK" // run completed, all item writes succeeded
  | "PARTIAL" // run completed, one or more item writes failed (non-fatal)
  | "SKIPPED_LOCKED" // another run holds the lock
  | "SKIPPED_MANUAL_MODE" // KrsConnectionSettings.syncMode === "manual"
  | "ABORTED_EMPTY_KRS" // empty sp_Onhand while prior snapshots exist (fail-safe)
  | "FAILED_PRODUCT_UPSERT" // KRS product upsert threw — run aborted, no stock change
  | "FAILED_KRS_FETCH"; // sp_Onhand threw — run aborted, no stock change

/** The typed result of an auto-sync run (returned to the API + UI consumers). */
export type AutoSyncResult = {
  status: AutoSyncStatus;
  runId: string;
  /** Net signed stock delta actually APPLIED across all items this run. */
  delta: number;
  /** Number of POS products whose stock was updated this run. */
  updated: number;
  /** Number of KRS items with a zero delta (idempotent skip). */
  skipped: number;
  /** Number of new POS products created by the product upsert this run. */
  newProducts?: number;
  /** Sanitized per-item error strings (never KRS secrets / raw driver objects). */
  errors: string[];
};

/** A sanitized error message for logs/results — never the raw mssql driver object
 *  or config (which can embed the password). Mirrors the client.ts sanitization. */
function safeErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}

/** Round + cap a delta to the POS Int column range. The KRS Balqty is fractional;
 *  we round to the nearest integer for the Int stock column and cap the magnitude
 *  so an absurd value can never overflow. Sign is preserved. */
function toIntDelta(rawDelta: number): number {
  if (!Number.isFinite(rawDelta)) return 0;
  const rounded = Math.round(rawDelta);
  if (rounded > POS_STOCK_MAX) return POS_STOCK_MAX;
  if (rounded < -POS_STOCK_MAX) return -POS_STOCK_MAX;
  return rounded;
}

/**
 * Acquire the singleton run-lock via an ATOMIC conditional UPDATE (never a
 * SELECT-then-UPDATE — that would race two concurrent triggers into a double-apply).
 *
 * The sentinel row is upserted first (so the very first run on a fresh DB has a row
 * to lock), then a single `UPDATE ... WHERE itemCode = '__LOCK__' AND (lockedAt IS
 * NULL OR lockedAt < now - 5min)` claims it. `executeRaw` returns the affected-row
 * count: 1 = we won the lock, 0 = a live lock is held by another run. The whole
 * decision is one atomic statement under READ COMMITTED — no TOCTOU window.
 */
async function acquireRunLock(runId: string): Promise<boolean> {
  // Ensure the sentinel row exists (idempotent). `lastQty` on the lock row is
  // meaningless (0); only `lockedAt` matters. Excluded from delta computation.
  await prisma.krsStockSnapshot.upsert({
    where: { itemCode: LOCK_ITEM_CODE },
    update: {},
    create: { itemCode: LOCK_ITEM_CODE, lastQty: new Prisma.Decimal(0) },
  });

  // Atomic claim: set lockedAt = now ONLY if the lock is free or stale. The
  // staleness threshold is computed in JS and bound as a parameter so the
  // comparison is against a concrete timestamp (no DB-clock-vs-app-clock skew
  // concern for a single-instance deploy; the 5-minute window absorbs any drift).
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const affected = await prisma.$executeRaw`
    UPDATE "KrsStockSnapshot"
       SET "lockedAt" = NOW(), "updatedAt" = NOW()
     WHERE "itemCode" = ${LOCK_ITEM_CODE}
       AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
  `;
  const acquired = affected === 1;
  if (!acquired) {
    logger.warn({ krsAutoSync: { runId } }, "KRS auto-sync: run-lock held by another run");
  }
  return acquired;
}

/** Release the run-lock (clear `lockedAt` on the sentinel). Always called in a
 *  `finally`, even on an uncaught exception, so a crashed run does not strand the
 *  lock (the stale-reclaim is the backstop if even this fails). */
async function releaseRunLock(): Promise<void> {
  try {
    await prisma.krsStockSnapshot.update({
      where: { itemCode: LOCK_ITEM_CODE },
      data: { lockedAt: null },
    });
  } catch (e) {
    // Non-fatal: the 5-minute stale-reclaim will free the lock on the next run.
    logger.error({ err: safeErrMsg(e) }, "KRS auto-sync: failed to release run-lock");
  }
}

/** Record a SyncJob row for UI/badge visibility + audit. PULL direction, type PULL
 *  (inbound). Best-effort: a SyncJob write failure must NOT mask the run result, so
 *  it is wrapped and only logged. `ref` carries the run id for traceability. */
async function recordSyncJob(
  runId: string,
  status: "SYNCED" | "FAILED",
  error: string | null,
  meta?: {
    updated: number;
    skipped: number;
    totalDelta: number;
    newProducts: number;
  }
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

/**
 * Run one inbound auto-pull (delta engine). See the file header + plan §7.
 *
 * Order: lock → manual-mode gate → product upsert → sp_Onhand → load snapshots +
 * products → empty-result protection → per-item delta apply (Product.stock +
 * StockMovement + snapshot, all in one Prisma $transaction per item) → disappeared-
 * item handling → SyncJob record. The lock is ALWAYS released in `finally`.
 *
 * @param config  An already-built mssql `sql.config` (from buildConnectionConfig).
 *                This module NEVER builds the config itself (the route owns that).
 * @param options Warehouse filter + branch + optional run id.
 */
export async function runAutoSync(
  config: sql.config,
  options: AutoSyncOptions
): Promise<AutoSyncResult> {
  const runId = options.runId ?? randomUUID();
  const runRef = `KRS_AUTO:${runId}`;
  const branchId = options.branchId ?? DEFAULT_BRANCH_ID;

  // === STEP 1: Acquire run-lock (atomic) ===
  const lockAcquired = await acquireRunLock(runId);
  if (!lockAcquired) {
    return { status: "SKIPPED_LOCKED", runId, delta: 0, updated: 0, skipped: 0, errors: [] };
  }

  try {
    // === STEP 2: syncMode gate (manual = refuse to auto-run) ===
    const settings = await prisma.krsConnectionSettings.findUnique({
      where: { id: "singleton" },
      select: { syncMode: true },
    });
    if (settings?.syncMode === "manual") {
      logger.info({ krsAutoSync: { runId } }, "KRS auto-sync: skipped (syncMode=manual)");
      return { status: "SKIPPED_MANUAL_MODE", runId, delta: 0, updated: 0, skipped: 0, errors: [] };
    }

    // === STEP 3: Product upsert (pull new/changed KRS items first) ===
    // New KRS items must exist as POS Product rows before the delta is applied so a
    // genuinely-new item gets its full KRS on-hand seeded (snapshot absent → 0).
    // FAIL-SAFE: if the KRS read or upsert throws, abort the whole run.
    let newProductCount = 0;
    try {
      const krsProducts = await fetchKrsProducts(config);
      const importResult = await importKrsProducts(krsProducts);
      newProductCount = importResult.created;
    } catch (productErr) {
      const msg = safeErrMsg(productErr);
      logger.error({ krsErr: msg, krsAutoSync: { runId } }, "KRS auto-sync: product upsert failed — aborting run");
      await recordSyncJob(runId, "FAILED", `Product upsert failed: ${msg}`);
      return { status: "FAILED_PRODUCT_UPSERT", runId, delta: 0, updated: 0, skipped: 0, errors: [msg] };
    }

    // === STEP 4: Fetch current KRS on-hand (sp_Onhand) ===
    // FAIL-SAFE: a KRS read fault aborts the run with NO stock change.
    let krsBalances: KrsStockBalance[];
    try {
      krsBalances = await fetchKrsStockBalances(config, options.warehouse ?? null);
    } catch (stockErr) {
      const msg = safeErrMsg(stockErr);
      logger.error({ krsErr: msg, krsAutoSync: { runId } }, "KRS auto-sync: sp_Onhand failed — aborting run");
      await recordSyncJob(runId, "FAILED", `sp_Onhand failed: ${msg}`);
      return { status: "FAILED_KRS_FETCH", runId, delta: 0, updated: 0, skipped: 0, errors: [msg] };
    }

    // === STEP 5: Load existing snapshots (excluding the sentinel) ===
    const snapshots = await prisma.krsStockSnapshot.findMany({
      where: { itemCode: { not: LOCK_ITEM_CODE } },
      select: { itemCode: true, lastQty: true },
    });
    const snapshotMap = new Map<string, number>(
      snapshots.map((s) => [s.itemCode, Number(s.lastQty)])
    );
    const snapshotCount = snapshots.length;

    // === STEP 5b: Empty-sp_Onhand protection (FAIL-SAFE, plan §7.2 / §11.8) ===
    // An empty result while we have known prior snapshots almost certainly means a
    // KRS data condition (no approved docs / wrong warehouse), NOT "every item is
    // gone". Treating it as "all items disappeared" would mass-zero POS stock — a
    // catastrophic, irreversible mistake. Abort instead.
    if (krsBalances.length === 0 && snapshotCount > 0) {
      logger.error(
        { krsAutoSync: { runId, snapshotCount } },
        "KRS auto-sync: sp_Onhand returned 0 rows but prior snapshots exist — aborting (no mass zero-out)"
      );
      await recordSyncJob(runId, "FAILED", "sp_Onhand returned 0 rows while prior snapshots exist — aborted to avoid mass zero-out");
      return { status: "ABORTED_EMPTY_KRS", runId, delta: 0, updated: 0, skipped: 0, errors: [] };
    }

    // === STEP 6: Load POS products (sku → id + current stock) ===
    const posProducts = await prisma.product.findMany({
      select: { id: true, sku: true, stock: true },
    });
    const productMap = new Map<string, { id: string; stock: number }>(
      posProducts.map((p) => [p.sku, { id: p.id, stock: p.stock }])
    );

    // === STEP 7: Build the current KRS map (sku → currentKrsQty) ===
    const krsCurrentMap = new Map<string, number>();
    for (const b of krsBalances) krsCurrentMap.set(b.itemCode, b.balance);

    let totalDelta = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    // === STEP 8: Apply deltas for items present in this sp_Onhand result ===
    for (const [sku, krsCurrentQty] of krsCurrentMap.entries()) {
      // First run for this sku (no snapshot) → lastQty = 0 → delta = full KRS qty.
      const lastQty = snapshotMap.has(sku) ? snapshotMap.get(sku)! : 0;
      const rawDelta = krsCurrentQty - lastQty;

      // EDGE CASE A: delta == 0 (KRS unchanged) → idempotent skip, no write.
      if (Math.abs(rawDelta) < DELTA_EPSILON) {
        skippedCount += 1;
        continue;
      }

      // EDGE CASE B: KRS item with no matching POS product. The step-3 upsert should
      // have created it; if it is still missing, do not lose track — update the
      // snapshot (so it is not a perpetual delta) and record an error. No stock write.
      const posProduct = productMap.get(sku);
      if (!posProduct) {
        logger.warn({ krsAutoSync: { runId, sku } }, "KRS auto-sync: KRS item has no POS product — skipping delta");
        errors.push(`No POS product for KRS sku ${sku}`);
        try {
          await prisma.krsStockSnapshot.upsert({
            where: { itemCode: sku },
            update: { lastQty: new Prisma.Decimal(krsCurrentQty) },
            create: { itemCode: sku, lastQty: new Prisma.Decimal(krsCurrentQty) },
          });
        } catch (snapErr) {
          errors.push(`Snapshot update failed for ${sku}: ${safeErrMsg(snapErr)}`);
        }
        continue;
      }

      // EDGE CASE C: negative delta (ERP adjustment/return) — apply CLAMPED so POS
      // stock never goes negative. EDGE CASE D: a manual POS edit between runs is
      // POS-owned; we layer the ERP delta ON TOP of whatever the POS stock is now.
      const intDelta = toIntDelta(rawDelta);
      if (intDelta === 0) {
        // Rounded to zero (sub-unit fractional change) but snapshot still advances
        // so the fractional drift is not re-detected forever. Treat as a skip for
        // the stock column, but persist the new snapshot.
        try {
          await prisma.krsStockSnapshot.upsert({
            where: { itemCode: sku },
            update: { lastQty: new Prisma.Decimal(krsCurrentQty) },
            create: { itemCode: sku, lastQty: new Prisma.Decimal(krsCurrentQty) },
          });
        } catch (snapErr) {
          errors.push(`Snapshot update failed for ${sku}: ${safeErrMsg(snapErr)}`);
        }
        skippedCount += 1;
        continue;
      }
      const newPosStock = Math.min(POS_STOCK_MAX, Math.max(0, posProduct.stock + intDelta));
      const appliedDelta = newPosStock - posProduct.stock; // may differ if clamped at 0
      const sign = intDelta >= 0 ? "+" : "-";

      // Product.stock + StockMovement + snapshot in ONE Prisma $transaction (POS
      // engine only — no mssql call inside). One item failure is non-fatal: it is
      // logged + collected and the run continues for the rest.
      try {
        await prisma.$transaction(async (tx) => {
          await tx.product.update({
            where: { id: posProduct.id },
            data: { stock: newPosStock },
            select: { id: true },
          });
          await tx.stockMovement.create({
            data: {
              productId: posProduct.id,
              type: "KRS_SYNC",
              qty: Math.abs(intDelta), // always positive (schema convention); sign in reference
              reference: `${runRef}:${sign}${Math.abs(intDelta)}`,
              branchId,
            },
          });
          await tx.krsStockSnapshot.upsert({
            where: { itemCode: sku },
            update: { lastQty: new Prisma.Decimal(krsCurrentQty) },
            create: { itemCode: sku, lastQty: new Prisma.Decimal(krsCurrentQty) },
          });
        });
        totalDelta += appliedDelta;
        updatedCount += 1;
      } catch (txErr) {
        // Postgres error — cannot contain KRS secrets. Log + continue to next item.
        const msg = safeErrMsg(txErr);
        logger.error({ err: msg, krsAutoSync: { runId, sku } }, "KRS auto-sync: POS write failed for sku");
        errors.push(`POS write failed for ${sku}: ${msg}`);
      }
    }

    // === STEP 8b: EDGE CASE E — items in a prior snapshot but NOT in this result ===
    // The item's KRS balance went to 0 (or it was removed). Apply the negative delta
    // toward 0 (clamped) and set the snapshot to 0. NOTE: this branch is only reached
    // when krsBalances was non-empty (the empty case aborted at step 5b), so we never
    // mass-zero on a blank KRS read.
    for (const [sku, lastQty] of snapshotMap.entries()) {
      if (krsCurrentMap.has(sku)) continue; // handled above
      if (lastQty === 0) continue; // already at 0 — nothing to do
      const intDelta = toIntDelta(-lastQty); // negative
      const posProduct = productMap.get(sku);
      if (!posProduct) {
        // No POS product to adjust — just reset the snapshot to 0.
        try {
          await prisma.krsStockSnapshot.update({
            where: { itemCode: sku },
            data: { lastQty: new Prisma.Decimal(0) },
          });
        } catch (snapErr) {
          errors.push(`Snapshot reset failed for ${sku}: ${safeErrMsg(snapErr)}`);
        }
        continue;
      }
      const newPosStock = Math.max(0, posProduct.stock + intDelta);
      const appliedDelta = newPosStock - posProduct.stock;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.product.update({
            where: { id: posProduct.id },
            data: { stock: newPosStock },
            select: { id: true },
          });
          if (intDelta !== 0) {
            await tx.stockMovement.create({
              data: {
                productId: posProduct.id,
                type: "KRS_SYNC",
                qty: Math.abs(intDelta),
                reference: `${runRef}:-${Math.abs(intDelta)}:REMOVED_FROM_KRS`,
                branchId,
              },
            });
          }
          await tx.krsStockSnapshot.update({
            where: { itemCode: sku },
            data: { lastQty: new Prisma.Decimal(0) },
          });
        });
        totalDelta += appliedDelta;
        updatedCount += 1;
      } catch (txErr) {
        const msg = safeErrMsg(txErr);
        logger.error({ err: msg, krsAutoSync: { runId, sku } }, "KRS auto-sync: POS write failed for disappeared sku");
        errors.push(`POS write failed for disappeared ${sku}: ${msg}`);
      }
    }

    // === STEP 9: Record SyncJob + summary log ===
    const jobStatus = errors.length > 0 ? "FAILED" : "SYNCED";
    await recordSyncJob(runId, jobStatus, errors.length > 0 ? errors.join("; ") : null, {
      updated: updatedCount,
      skipped: skippedCount,
      totalDelta,
      newProducts: newProductCount,
    });

    logger.info(
      {
        krsAutoSync: {
          runId,
          updated: updatedCount,
          skipped: skippedCount,
          totalDelta,
          newProducts: newProductCount,
          errors: errors.length,
        },
      },
      "KRS auto-sync completed"
    );

    return {
      status: errors.length > 0 ? "PARTIAL" : "OK",
      runId,
      delta: totalDelta,
      updated: updatedCount,
      skipped: skippedCount,
      newProducts: newProductCount,
      errors,
    };
  } finally {
    // ALWAYS release the lock — even on an uncaught exception.
    await releaseRunLock();
  }
}

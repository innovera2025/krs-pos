// NODE-ONLY. KRS inbound SHARED stock-reconcile engine (krs-realtime-inbound P1). This
// is the SINGLE source of stock truth from now on: BOTH the 2-second realtime poller
// (POST /api/krs/rt-poll → scope = the itemCodes the watermark flagged) and the demoted
// ≤60s safety-net sweep (runAutoSync → scope = "ALL") funnel through THIS one engine and
// share THIS one run-lock. There is deliberately no second delta-apply code path, so the
// two callers cannot disagree or double-apply ("no two engines fighting" — plan D5).
//
// Imported only by Node-runtime server code (autoSync.ts, the rt-poll route) — NEVER from
// a client component, `src/auth.config.ts`, or `src/middleware.ts` (it pulls in the
// `mssql` read helper via stock.ts and the Prisma singleton).
//
// ── THE 15-07-26 INCIDENT'S HARD RULE, ENFORCED BY DESIGN ──────────────────────────────
// The 15-07-26 prod incident (references/krs-onhand-global-discrepancy_REPORT_15-07-26.md)
// was caused by the KRS GLOBAL `sp_Onhand @Warehouse=NULL` call being internally broken
// (667/972 items returned 0 while the per-warehouse call returned real stock). This engine
// NEVER issues the global call. Every KRS read here is WAREHOUSE-SCOPED
// (`fetchKrsStockBalances(config, warehouseCode)` — the existing, unchanged stock.ts
// helper), and the global figures are DERIVED as Σ over the scoped per-warehouse answers.
// `Product.stock` (global) is therefore, by construction, the sum of scoped truths — it
// can never be zeroed by a broken global aggregate because that aggregate is never read.
// See `reconcileStock` step (5)/(6) and the SearchTag `INCIDENT-GUARD` below.
//
// ── SALE-DEDUCTION PRESERVATION (why DELTA, not absolute) ───────────────────────────────
// `Product.stock` carries POS-owned checkout deductions that KRS has not seen yet
// (outbound write-back is dormant/out-of-scope). An ABSOLUTE `Product.stock = ΣKRS` would
// erase those deductions → oversell. So this engine applies a DELTA (observed − last
// observed) atomically on top of the CURRENT row value, exactly as the retired autoSync
// global pass did. The per-warehouse snapshot baseline is ALWAYS set to the freshly
// OBSERVED KRS value (never a wished-for value — the incident's hard rule), so re-running
// with the same KRS answer is a true no-op (delta = observed − observed = 0).
//
// ── FAIL-OPEN / CROSS-ENGINE SEPARATION (invariants) ───────────────────────────────────
// ALL KRS reads (mssql) happen BEFORE any Postgres write; if ANY warehouse fetch throws,
// the cycle ABORTS with ZERO Postgres writes (never a partial/mass-zero). No mssql call is
// ever nested inside the Prisma `$transaction`. An EMPTY scoped result for a warehouse is
// treated as "no data this cycle" and that warehouse is SKIPPED (never used to drive items
// to 0), mirroring autoSync's empty-result protection.

import sql from "mssql";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { fetchKrsStockBalances, type KrsStockBalance } from "./stock";
import { POS_STOCK_MAX, toIntDelta, toWarehouseQty } from "./reconcileMath";
import { publishKrsEvent } from "./events";

/** The run-lock sentinel itemCode — a magic key that can never be a real KRS ItemCode
 *  (real codes look like "F01-0001"). The single row at (itemCode="__LOCK__",
 *  warehouseCode="") carries `lockedAt`; it is NEVER a product snapshot and is always
 *  excluded from reconcile. Moved here verbatim from autoSync.ts so both callers share
 *  ONE lock. */
export const LOCK_ITEM_CODE = "__LOCK__";

/** The all-warehouse sentinel `warehouseCode` for the run-lock row AND the (now derived,
 *  Σ-per-warehouse) global `KrsStockSnapshot` rows. Per-warehouse rows carry the real KRS
 *  WarehouseCode. */
export const GLOBAL_WAREHOUSE_SENTINEL = "";

/** A lock older than this is stale (a crashed prior run) and is reclaimed. Generous vs.
 *  the expected sub-second → few-second run so a slow-but-live run is never stolen. */
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes

/** Default branch stamped onto written StockMovement rows (single-store deploy). */
const DEFAULT_BRANCH_ID = "BR-01";

/** The reconcile scope: the whole catalogue (safety-net sweep) or an explicit, watermark-
 *  derived itemCode list (realtime path). "WAREHOUSES" is intentionally NOT a scope — the
 *  engine always visits EVERY warehouse for the items it touches, because `Product.stock`
 *  and the global snapshot are Σ across ALL warehouses (a partial-warehouse view would
 *  compute a wrong sum). */
export type ReconcileScope = "ALL" | { itemCodes: string[] };

export type ReconcileStatus =
  | "OK" // ran and applied (possibly zero changes)
  | "SKIPPED_LOCKED" // another run (rt-poll OR safety net) holds the shared lock
  | "SKIPPED_MANUAL_MODE" // KrsConnectionSettings.syncMode === "manual"
  | "NOOP"; // nothing in scope to process (empty itemCodes / no warehouses)

/** The reconcile summary (returned for logging + the autoSync-wrapper mapping). */
export type ReconcileSummary = {
  status: ReconcileStatus;
  /** Items that had ANY staged write this cycle (stock, warehouse-stock, or snapshot). */
  itemsTouched: number;
  /** Items whose global `Product.stock` actually changed (net delta ≠ 0). */
  stockUpdated: number;
  /** Net signed `Product.stock` delta applied across all items this cycle. */
  totalDelta: number;
  /** The KRS warehouse codes that returned data and were processed this cycle. */
  warehouses: string[];
};

export type ReconcileOptions = {
  /** Branch id stamped onto StockMovement rows. Defaults to BR-01. */
  branchId?: string;
  /** Optional caller-supplied run id (else a UUID is minted) — for log correlation. */
  runId?: string;
};

/** A sanitized error message — never the raw mssql driver object/config (which can embed
 *  the password). Mirrors client.ts / autoSync.ts sanitization. */
function safeErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}

/**
 * Acquire the singleton run-lock via an ATOMIC conditional UPDATE (never SELECT-then-
 * UPDATE — that would race two concurrent triggers into a double-apply). Moved verbatim
 * from autoSync.ts; now the ONE lock shared by rt-poll and the safety-net sweep.
 *
 * Upserts the sentinel row first (so the very first run on a fresh DB has a row to lock),
 * then a single `UPDATE ... WHERE itemCode='__LOCK__' AND (lockedAt IS NULL OR lockedAt <
 * now-5min)` claims it. `$executeRaw` returns the affected-row count: 1 = we won, 0 = a
 * live lock is held by another run. One atomic statement under READ COMMITTED — no TOCTOU.
 */
async function acquireRunLock(runId: string): Promise<boolean> {
  await prisma.krsStockSnapshot.upsert({
    where: {
      itemCode_warehouseCode: {
        itemCode: LOCK_ITEM_CODE,
        warehouseCode: GLOBAL_WAREHOUSE_SENTINEL,
      },
    },
    update: {},
    create: {
      itemCode: LOCK_ITEM_CODE,
      warehouseCode: GLOBAL_WAREHOUSE_SENTINEL,
      lastQty: new Prisma.Decimal(0),
    },
  });

  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const affected = await prisma.$executeRaw`
    UPDATE "KrsStockSnapshot"
       SET "lockedAt" = NOW(), "updatedAt" = NOW()
     WHERE "itemCode" = ${LOCK_ITEM_CODE}
       AND "warehouseCode" = ${GLOBAL_WAREHOUSE_SENTINEL}
       AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
  `;
  const acquired = affected === 1;
  if (!acquired) {
    logger.warn({ krsReconcile: { runId } }, "KRS reconcile: run-lock held by another run");
  }
  return acquired;
}

/** Release the run-lock (clear `lockedAt` on the sentinel). Always called in a `finally`;
 *  the 5-minute stale-reclaim is the backstop if even this fails. */
async function releaseRunLock(): Promise<void> {
  try {
    await prisma.krsStockSnapshot.update({
      where: {
        itemCode_warehouseCode: {
          itemCode: LOCK_ITEM_CODE,
          warehouseCode: GLOBAL_WAREHOUSE_SENTINEL,
        },
      },
      data: { lockedAt: null },
    });
  } catch (e) {
    logger.error({ err: safeErrMsg(e) }, "KRS reconcile: failed to release run-lock");
  }
}

/** One staged per-warehouse write (observed KRS balance for an item in a warehouse). */
type WarehouseWrite = {
  itemCode: string;
  warehouseCode: string;
  observed: number; // raw fractional KRS balance (→ snapshot.lastQty)
  qty: number; // rounded, floored (→ WarehouseStock.qty)
};

/** One staged per-item write (the global Product.stock delta + derived global snapshot). */
type ItemWrite = {
  itemCode: string;
  productId: string | null; // null → KRS item with no POS Product row (skip stock write)
  intDelta: number; // net signed Product.stock delta (Σ per-warehouse deltas), capped
  globalSum: number; // Σ observed across all warehouses (→ global snapshot lastQty)
  globalSnapshotChanged: boolean; // whether globalSum differs from the prior global snapshot
};

/**
 * Run one inbound reconcile over `scope`. Returns a summary; NEVER throws for a KRS-side
 * fault surfaced through the read helper — but a KRS read failure ABORTS the cycle by
 * re-throwing (after releasing the lock) so the caller fails open with NO partial writes.
 *
 * @param config  An already-built mssql `sql.config` (from buildConnectionConfig). This
 *                module NEVER builds the config itself (the route/wrapper owns that).
 * @param scope   "ALL" (safety-net sweep) or { itemCodes } (realtime, watermark-derived).
 * @param options branch + optional run id.
 */
export async function reconcileStock(
  config: sql.config,
  scope: ReconcileScope,
  options: ReconcileOptions = {}
): Promise<ReconcileSummary> {
  const runId = options.runId ?? randomUUID();
  const runRef = `KRS_RECONCILE:${runId}`;
  const branchId = options.branchId ?? DEFAULT_BRANCH_ID;

  const empty: ReconcileSummary = {
    status: "NOOP",
    itemsTouched: 0,
    stockUpdated: 0,
    totalDelta: 0,
    warehouses: [],
  };

  // Normalize the scope's itemCode set up-front (trim, dedup, drop blanks + the lock key).
  const scopeItemCodes: Set<string> | null =
    scope === "ALL"
      ? null
      : new Set(
          scope.itemCodes
            .map((c) => c.trim())
            .filter((c) => c.length > 0 && c !== LOCK_ITEM_CODE)
        );
  if (scopeItemCodes !== null && scopeItemCodes.size === 0) {
    return empty; // realtime path with nothing in scope → cheap no-op (no lock taken)
  }

  // === STEP 1: Acquire the shared run-lock (atomic). SKIPPED_LOCKED if another run holds it.
  const lockAcquired = await acquireRunLock(runId);
  if (!lockAcquired) return { ...empty, status: "SKIPPED_LOCKED" };

  try {
    // === STEP 2: syncMode gate (manual = refuse to auto-run) ===
    const settings = await prisma.krsConnectionSettings.findUnique({
      where: { id: "singleton" },
      select: { syncMode: true },
    });
    if (settings?.syncMode === "manual") {
      logger.info({ krsReconcile: { runId } }, "KRS reconcile: skipped (syncMode=manual)");
      return { ...empty, status: "SKIPPED_MANUAL_MODE" };
    }

    // === STEP 3: Resolve the warehouse set (every known POS warehouse, minus the sentinel) ===
    const warehouseRows = await prisma.warehouse.findMany({ select: { warehouseCode: true } });
    const warehouseCodes = warehouseRows
      .map((w) => w.warehouseCode)
      .filter((code) => code !== GLOBAL_WAREHOUSE_SENTINEL);
    if (warehouseCodes.length === 0) {
      logger.warn({ krsReconcile: { runId } }, "KRS reconcile: no warehouses configured — nothing to do");
      return empty;
    }

    // === STEP 4: Warehouse-scoped KRS reads (mssql, ALL before any Postgres write) ===
    // INCIDENT-GUARD: every read is `fetchKrsStockBalances(config, warehouseCode)` — the
    // WAREHOUSE-SCOPED call. The broken global `@Warehouse=NULL` call is NEVER issued here.
    // A throw ABORTS the whole cycle (re-thrown below) → zero Postgres writes → fail-open.
    const whResults = new Map<string, Map<string, number>>(); // warehouseCode → (itemCode → balance)
    const emptyWarehouses = new Set<string>(); // warehouses that returned 0 rows (skip → never mass-zero)
    for (const warehouseCode of warehouseCodes) {
      let balances: KrsStockBalance[];
      try {
        balances = await fetchKrsStockBalances(config, warehouseCode);
      } catch (fetchErr) {
        // A KRS read fault aborts the cycle with NO Postgres writes (nothing written yet).
        // Re-throw after the finally releases the lock; the caller fails open.
        logger.error(
          { krsErr: safeErrMsg(fetchErr), krsReconcile: { runId, warehouseCode } },
          "KRS reconcile: scoped sp_Onhand failed — aborting cycle (no writes)"
        );
        throw fetchErr;
      }
      const map = new Map<string, number>();
      for (const b of balances) {
        if (b.itemCode === LOCK_ITEM_CODE) continue; // never treat the lock key as an item
        map.set(b.itemCode, b.balance);
      }
      if (map.size === 0) emptyWarehouses.add(warehouseCode);
      whResults.set(warehouseCode, map);
    }

    // Warehouses that actually returned data this cycle (used for deltas + the summary).
    const dataWarehouses = warehouseCodes.filter((code) => !emptyWarehouses.has(code));
    if (dataWarehouses.length === 0) {
      // Every warehouse returned empty — almost certainly a KRS data condition, NOT "all
      // stock is gone". Skip the whole cycle (never mass-zero). Mirrors autoSync §5b.
      logger.warn(
        { krsReconcile: { runId, warehouses: warehouseCodes.length } },
        "KRS reconcile: all warehouses returned 0 rows — skipping (no mass zero-out)"
      );
      return { ...empty, status: "OK" };
    }

    // === STEP 5: Build the item set to process ===
    // scope=ALL → union of every item KRS returned this cycle PLUS every item that already
    // has a per-warehouse snapshot (so an item that dropped out of ALL results is driven to
    // 0). scope=itemCodes → exactly the watermark-derived list.
    let itemSet: Set<string>;
    if (scopeItemCodes !== null) {
      itemSet = scopeItemCodes;
    } else {
      itemSet = new Set<string>();
      for (const code of dataWarehouses) {
        for (const itemCode of whResults.get(code)!.keys()) itemSet.add(itemCode);
      }
      const priorSnaps = await prisma.krsStockSnapshot.findMany({
        where: {
          warehouseCode: { not: GLOBAL_WAREHOUSE_SENTINEL },
          itemCode: { not: LOCK_ITEM_CODE },
        },
        select: { itemCode: true },
      });
      for (const s of priorSnaps) itemSet.add(s.itemCode);
    }
    if (itemSet.size === 0) return { ...empty, status: "OK" };
    const itemCodes = Array.from(itemSet);

    // === STEP 6: Load prior baselines + POS product rows for the item set (reads only) ===
    // Per-warehouse snapshots (the delta baselines) for the items in scope.
    const priorPerWh = await prisma.krsStockSnapshot.findMany({
      where: {
        itemCode: { in: itemCodes },
        warehouseCode: { not: GLOBAL_WAREHOUSE_SENTINEL },
      },
      select: { itemCode: true, warehouseCode: true, lastQty: true },
    });
    const priorPerWhMap = new Map<string, number>(); // `${item}\u0000${wh}` → lastQty
    for (const s of priorPerWh) {
      priorPerWhMap.set(`${s.itemCode}\u0000${s.warehouseCode}`, Number(s.lastQty));
    }
    // Prior GLOBAL snapshots (warehouseCode="") for the items in scope — used only to skip a
    // no-op global-snapshot write (kept coherent as Σ per-warehouse; no engine reads it for
    // delta math any longer — see the file header + the 15-07 report).
    const priorGlobal = await prisma.krsStockSnapshot.findMany({
      where: { itemCode: { in: itemCodes }, warehouseCode: GLOBAL_WAREHOUSE_SENTINEL },
      select: { itemCode: true, lastQty: true },
    });
    const priorGlobalMap = new Map<string, number>();
    for (const s of priorGlobal) priorGlobalMap.set(s.itemCode, Number(s.lastQty));
    // POS product rows (sku → id) for the items in scope.
    const products = await prisma.product.findMany({
      where: { sku: { in: itemCodes } },
      select: { id: true, sku: true },
    });
    const productIdMap = new Map<string, string>();
    for (const p of products) productIdMap.set(p.sku, p.id);

    // === STEP 7: Compute staged writes (pure, in-memory; no DB writes yet) ===
    const warehouseWrites: WarehouseWrite[] = [];
    const itemWrites: ItemWrite[] = [];
    for (const itemCode of itemCodes) {
      let intDelta = 0;
      let globalSum = 0;
      for (const warehouseCode of warehouseCodes) {
        const priorKey = `${itemCode}\u0000${warehouseCode}`;
        const prior = priorPerWhMap.get(priorKey);
        if (emptyWarehouses.has(warehouseCode)) {
          // No data for this warehouse this cycle → leave its snapshot/warehouse-stock as
          // is; contribute the LAST-KNOWN value to the global sum so Σ stays complete.
          globalSum += prior ?? 0;
          continue;
        }
        const observed = whResults.get(warehouseCode)!.get(itemCode) ?? 0;
        globalSum += observed;
        // Stage the per-warehouse write only when the observed value actually changed
        // (true idempotency: re-running with the same KRS answer writes nothing).
        if (prior === undefined || observed !== prior) {
          warehouseWrites.push({
            itemCode,
            warehouseCode,
            observed,
            qty: toWarehouseQty(observed),
          });
        }
        intDelta += toIntDelta(observed - (prior ?? 0));
      }
      intDelta = toIntDelta(intDelta); // re-cap the summed delta
      const prevGlobal = priorGlobalMap.get(itemCode);
      const globalSnapshotChanged = prevGlobal === undefined || prevGlobal !== globalSum;
      const productId = productIdMap.get(itemCode) ?? null;
      if (intDelta !== 0 || globalSnapshotChanged) {
        itemWrites.push({ itemCode, productId, intDelta, globalSum, globalSnapshotChanged });
      }
    }

    // Nothing drifted → true no-op cycle (no transaction opened). The common 2s hot-path
    // outcome once baselines are established.
    if (warehouseWrites.length === 0 && itemWrites.length === 0) {
      return { status: "OK", itemsTouched: 0, stockUpdated: 0, totalDelta: 0, warehouses: dataWarehouses };
    }

    // === STEP 8: Apply ALL staged writes in ONE transaction (atomic per cycle) ===
    // No mssql call inside (cross-engine separation). Product.stock uses an atomic
    // relative `stock + delta` (LEAST/GREATEST clamp) so a concurrent checkout decrement
    // between the reads above and this write is PRESERVED, never clobbered.
    let totalDelta = 0;
    let stockUpdated = 0;
    const missingProducts: string[] = [];
    await prisma.$transaction(
      async (tx) => {
        // Per-warehouse: WarehouseStock (display) + per-warehouse snapshot (delta baseline
        // = OBSERVED truth — the incident's hard rule).
        for (const w of warehouseWrites) {
          await tx.warehouseStock.upsert({
            where: { sku_warehouseCode: { sku: w.itemCode, warehouseCode: w.warehouseCode } },
            update: { qty: w.qty },
            create: { sku: w.itemCode, warehouseCode: w.warehouseCode, qty: w.qty },
          });
          await tx.krsStockSnapshot.upsert({
            where: {
              itemCode_warehouseCode: { itemCode: w.itemCode, warehouseCode: w.warehouseCode },
            },
            update: { lastQty: new Prisma.Decimal(w.observed) },
            create: {
              itemCode: w.itemCode,
              warehouseCode: w.warehouseCode,
              lastQty: new Prisma.Decimal(w.observed),
            },
          });
        }
        // Per-item: atomic Product.stock delta + StockMovement + derived global snapshot.
        for (const it of itemWrites) {
          if (it.intDelta !== 0) {
            if (it.productId !== null) {
              // INCIDENT-GUARD: relative delta on the CURRENT row value (never an absolute
              // ΣKRS assignment that would erase POS-owned sale deductions), clamped to the
              // Int column range.
              await tx.$executeRaw`UPDATE "Product" SET "stock" = LEAST(${POS_STOCK_MAX}, GREATEST(0, "stock" + ${it.intDelta})) WHERE "id" = ${it.productId}`;
              const sign = it.intDelta >= 0 ? "+" : "-";
              await tx.stockMovement.create({
                data: {
                  productId: it.productId,
                  type: "KRS_SYNC",
                  qty: Math.abs(it.intDelta),
                  reference: `${runRef}:${sign}${Math.abs(it.intDelta)}`,
                  branchId,
                },
              });
              totalDelta += it.intDelta;
              stockUpdated += 1;
            } else {
              // KRS item with no POS product row — the caller's product import should have
              // created it; if still absent, do NOT lose the stock signal silently.
              missingProducts.push(it.itemCode);
            }
          }
          if (it.globalSnapshotChanged) {
            await tx.krsStockSnapshot.upsert({
              where: {
                itemCode_warehouseCode: {
                  itemCode: it.itemCode,
                  warehouseCode: GLOBAL_WAREHOUSE_SENTINEL,
                },
              },
              update: { lastQty: new Prisma.Decimal(it.globalSum) },
              create: {
                itemCode: it.itemCode,
                warehouseCode: GLOBAL_WAREHOUSE_SENTINEL,
                lastQty: new Prisma.Decimal(it.globalSum),
              },
            });
          }
        }
      },
      // The safety-net "ALL" first run can stage many rows; give the single cycle-tx room.
      // The steady-state hot path stages only genuinely-drifted rows, so this is tiny.
      { timeout: 120_000, maxWait: 20_000 }
    );

    if (missingProducts.length > 0) {
      logger.warn(
        { krsReconcile: { runId, missing: missingProducts.length } },
        "KRS reconcile: some KRS items have no POS product row (stock delta skipped)"
      );
    }

    const itemsTouched =
      new Set([...warehouseWrites.map((w) => w.itemCode), ...itemWrites.map((i) => i.itemCode)]).size;

    // === STEP 9: SSE publish (P2 wiring) — best-effort, NEVER fails the cycle ===
    // Read the changed products' CURRENT stock back after the commit (a relative-delta
    // engine does not know the final value — and the read-back also captures any
    // concurrent checkout decrement, so screens converge on the true row value).
    //
    // Publish set = the UNION of (a) skus whose GLOBAL Product.stock moved (intDelta≠0)
    // and (b) skus whose PER-WAREHOUSE qty moved this cycle (present in warehouseWrites),
    // limited to skus that map to a POS product. Case (b) is the assigned-user fix
    // (17-07-26): a per-warehouse qty can change while Σ (global) delta is 0 — those items
    // appear in warehouseWrites ONLY and would otherwise never publish, so a
    // warehouse-scoped screen stayed stale until a manual refetch. `stock` is always the
    // read-back Product.stock (global); the `warehouse` breakdown lets a warehouse-assigned
    // client pick its own slice (see useKrsEvents / patchStockBySku).
    try {
      const publishSkus = new Set<string>();
      for (const it of itemWrites) {
        if (it.intDelta !== 0 && it.productId !== null) publishSkus.add(it.itemCode);
      }
      for (const w of warehouseWrites) {
        if (productIdMap.has(w.itemCode)) publishSkus.add(w.itemCode);
      }
      if (publishSkus.size > 0) {
        // Single read-back query (by sku — both sources are keyed by KRS itemCode = sku).
        const rows = await prisma.product.findMany({
          where: { sku: { in: Array.from(publishSkus) } },
          select: { sku: true, stock: true },
        });
        const whBySku = new Map<string, { code: string; qty: number }[]>();
        for (const w of warehouseWrites) {
          const list = whBySku.get(w.itemCode) ?? [];
          list.push({ code: w.warehouseCode, qty: w.qty });
          whBySku.set(w.itemCode, list);
        }
        publishKrsEvent({
          type: "stock-update",
          items: rows.map((r) => ({ sku: r.sku, stock: r.stock, warehouse: whBySku.get(r.sku) })),
        });
      }
    } catch (err) {
      logger.warn({ err }, "KRS reconcile: SSE publish failed (non-fatal)");
    }

    return { status: "OK", itemsTouched, stockUpdated, totalDelta, warehouses: dataWarehouses };
  } finally {
    await releaseRunLock();
  }
}

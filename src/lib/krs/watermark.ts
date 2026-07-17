// NODE-ONLY. KRS realtime-inbound WATERMARK detector (krs-realtime-inbound P1, watermark
// variant). Imported only by Node-runtime server code (the /api/krs/rt-poll route) —
// NEVER from a client component, `src/auth.config.ts`, or `src/middleware.ts` (it pulls
// in the `mssql` driver).
//
// WHAT THIS DOES: it answers, cheaply and every ~2 seconds, "did anything move in KRS
// since the last cursor?" without scanning the ledger. A single 4-aggregate probe reads
// the current MAX watermarks (see `probeWatermarks`); when a watermark advanced, two
// bounded follow-up reads resolve WHICH (item, warehouse) pairs and WHICH new product
// codes changed (`fetchChangedDocs` / `fetchChangedItems`). The pure comparison/advance
// math lives in `watermarkCursor.ts` (mssql-free, unit-tested); this module is only the
// SQL + connection plumbing.
//
// READ-ONLY on KRS (invariant, carried forward from stock.ts/autoSync.ts): every
// statement here is a `SELECT`. No INSERT/UPDATE/DELETE ever touches KRS. A KRS-side
// fault is surfaced as a thrown, SANITIZED Error (never the raw mssql/tedious error or
// config, which can embed the password) and the caller fails OPEN (skips the cycle).
//
// SECURITY: all SQL text is FIXED literals (fully-qualified `dbo.` table names) plus
// BOUND parameters for the cursor values (@txn / @entry / @approved / @itemEntry). There
// is NO user-supplied identifier and NO string interpolation → no injection surface
// (unlike the schema browser's user-supplied table name in client.ts).
//
// POOL-REUSE DEVIATION (explicit, justified — plan §P1.5): every OTHER KRS helper
// (stock.ts / products.ts / client.ts) opens a THROWAWAY per-call pool (open → query →
// close). That is correct for admin-triggered, infrequent calls. This detector runs on a
// 2-SECOND cadence, so paying a fresh TCP+TLS+auth handshake every cycle would eat a
// meaningful slice of the latency budget. This module therefore holds a MODULE-LEVEL,
// longer-lived pool (opened once, reused across polls, torn down + recreated on error or
// config change). Do NOT "fix" this back to the throwaway-pool convention — it is a
// deliberate, documented exception scoped to this hot path. The cold reconcile path
// (stockReconcile.ts → stock.ts) keeps the throwaway-pool convention unchanged.

import sql from "mssql";
import { safeErrorParts } from "./client";
import { logger } from "@/lib/logger";
import type { Watermarks, KrsChangedPair, WatermarkCursorState } from "./watermarkCursor";

/** The module-level reused pool + a fingerprint of the config it was opened for (so a
 *  changed KrsConnectionSettings row transparently rebuilds the pool). Both null until
 *  the first `acquireKrsPool` call. */
let sharedPool: sql.ConnectionPool | null = null;
let sharedPoolKey: string | null = null;

/** A non-secret fingerprint of the connection config (never includes the password) used
 *  to detect a config change and rebuild the shared pool. */
function configKey(config: sql.config): string {
  return `${config.server ?? ""}:${config.port ?? ""}:${config.database ?? ""}:${config.user ?? ""}`;
}

/** Throw a small, non-sensitive Error after logging a SANITIZED `{host,port,database,
 *  user,code,message}` — the raw mssql/tedious error (which can embed the password under
 *  driver keys) is NEVER logged or propagated. Mirrors stock.ts / products.ts. Used on
 *  the connect path where we still hold the config. */
function throwSanitized(config: sql.config, e: unknown, what: string): never {
  const parts = safeErrorParts(e);
  logger.error(
    {
      krsErr: {
        host: config.server,
        port: config.port,
        database: config.database,
        user: config.user,
        code: parts.code,
        message: parts.message,
      },
    },
    `KRS ${what} failed`
  );
  throw new Error(`KRS ${what} failed`);
}

/** Throw a small, non-sensitive Error after logging a SANITIZED `{code,message}` — the
 *  query helpers only hold the pool (not the config, which mssql does not expose on the
 *  pool type), and the connection identity is already logged at connect time. The raw
 *  mssql/tedious error is NEVER logged or propagated. */
function throwSanitizedQuery(e: unknown, what: string): never {
  const parts = safeErrorParts(e);
  logger.error(
    { krsErr: { code: parts.code, message: parts.message } },
    `KRS ${what} failed`
  );
  throw new Error(`KRS ${what} failed`);
}

/**
 * Acquire the module-level reused pool for `config`, opening (or re-opening) it as
 * needed. Reused across 2s polls so the common case pays no connection handshake. If the
 * existing pool is closed / disconnected / for a different config, it is torn down and a
 * fresh one is opened. On a connect failure the shared pool is reset to null (so the next
 * cycle retries cleanly) and a sanitized Error is thrown.
 */
export async function acquireKrsPool(config: sql.config): Promise<sql.ConnectionPool> {
  const key = configKey(config);
  if (sharedPool && sharedPool.connected && sharedPoolKey === key) {
    return sharedPool;
  }
  // Tear down any stale/other-config pool before rebuilding (best-effort close).
  await resetKrsPool();
  try {
    const pool = new sql.ConnectionPool(config);
    await pool.connect();
    // If the pool emits an async error later (dropped socket), drop our reference so the
    // next acquire rebuilds instead of handing back a dead pool.
    pool.on("error", () => {
      if (sharedPool === pool) {
        sharedPool = null;
        sharedPoolKey = null;
      }
    });
    sharedPool = pool;
    sharedPoolKey = key;
    return pool;
  } catch (e) {
    sharedPool = null;
    sharedPoolKey = null;
    throwSanitized(config, e, "watermark pool connect");
  }
}

/** Tear down the shared pool (graceful shutdown, config change, or post-error reset).
 *  Safe to call when no pool is open. Never throws. */
export async function resetKrsPool(): Promise<void> {
  const pool = sharedPool;
  sharedPool = null;
  sharedPoolKey = null;
  if (pool) {
    try {
      await pool.close();
    } catch {
      // Closing a never-fully-opened / already-broken pool can throw; the reference is
      // already dropped, so swallow.
    }
  }
}

/** Coerce a KRS aggregate value (mssql may return number | string | null) to a finite JS
 *  integer for the running document number; non-finite/null → 0. */
function toIntOrZero(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Coerce a KRS datetime cell (mssql returns a JS Date or null) to `Date | null`. A
 *  non-Date, non-null value (defensive) that parses to a valid date is accepted; anything
 *  else collapses to null (= "not observed"). */
function toDateOrNull(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v === null || v === undefined) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Trim a KRS code cell to a non-empty string, or null (drop keyless rows). */
function cleanCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * The single cheap probe (one round-trip, FIVE scalar aggregates over the tiny flow/item
 * tables) — the every-2s hot path. Returns the current MAX watermarks PLUS COUNT(*) of
 * dbo.InventoryItem (the deletion detector: a pure delete advances no MAX watermark but
 * changes this count; the table is ~4k rows so the count is effectively free on the same
 * round-trip). The caller compares them to the stored cursor (via `watermarksAdvanced`)
 * and does nothing further when nothing moved. See references/krs-watermark-discovery_16-07-26.md.
 */
export async function probeWatermarks(pool: sql.ConnectionPool): Promise<Watermarks> {
  try {
    const result = await pool.request().query<{
      maxTxn: unknown;
      maxEntry: unknown;
      maxApproved: unknown;
      maxItemEntry: unknown;
      itemCount: unknown;
    }>(
      `SELECT
         (SELECT MAX(TransactionNo) FROM dbo.InventoryFlowHdr) AS maxTxn,
         (SELECT MAX(EntryDate)     FROM dbo.InventoryFlowHdr) AS maxEntry,
         (SELECT MAX(ApprovedDate)  FROM dbo.InventoryFlowHdr) AS maxApproved,
         (SELECT MAX(EntryDate)     FROM dbo.InventoryItem)    AS maxItemEntry,
         (SELECT COUNT(*)           FROM dbo.InventoryItem)    AS itemCount;`
    );
    const row = result.recordset[0] ?? {
      maxTxn: 0,
      maxEntry: null,
      maxApproved: null,
      maxItemEntry: null,
      // Degenerate (a scalar-aggregate SELECT always returns one row, so this branch is
      // unreachable) — -1 = "not observed", which the pure detector ignores rather than
      // mistaking for a mass deletion.
      itemCount: -1,
    };
    return {
      maxTxn: toIntOrZero(row.maxTxn),
      maxEntry: toDateOrNull(row.maxEntry),
      maxApproved: toDateOrNull(row.maxApproved),
      maxItemEntry: toDateOrNull(row.maxItemEntry),
      // COUNT(*) is a finite non-negative integer in practice; toIntOrZero preserves the
      // -1 sentinel from the degenerate fallback above (Math.trunc(-1) === -1).
      itemCount: toIntOrZero(row.itemCount),
    };
  } catch (e) {
    throwSanitizedQuery(e, "watermark probe");
  }
}

/**
 * Resolve the DISTINCT (ItemCode, Warehouse) pairs touched by any InventoryFlow document
 * that changed since the stored cursor: a NEW document (TransactionNo > @txn), a
 * newly-CREATED document (EntryDate > @entry), or an APPROVAL flip on an existing document
 * (ApprovedDate > @approved — a late approval that moves on-hand with no new
 * TransactionNo). Joined to the detail rows so each changed doc yields its affected
 * (item, warehouse) pairs. Those pairs become the SCOPE for the per-warehouse-scoped
 * sp_Onhand re-read (never the broken global call).
 *
 * NO Approved/IsClosed filter here on purpose: an UN-approval also changes on-hand, so we
 * re-read whatever the changed docs reference and let the (scoped) sp_Onhand return the
 * current truth. Nulls in the cursor timestamps bind as SQL NULL, so `col > NULL` is
 * UNKNOWN (matches nothing) — harmless, because TransactionNo alone catches every new doc
 * and the date signals self-heal on their first non-null sighting.
 *
 * All parameters are BOUND (@txn Int, @entry/@approved DateTime2); the table names are
 * fixed literals. No injection surface.
 */
export async function fetchChangedDocs(
  pool: sql.ConnectionPool,
  cursor: WatermarkCursorState
): Promise<KrsChangedPair[]> {
  try {
    const result = await pool
      .request()
      .input("txn", sql.Int, cursor.lastTxn)
      .input("entry", sql.DateTime2, cursor.lastEntryAt)
      .input("approved", sql.DateTime2, cursor.lastApprovedAt)
      .query<{ itemCode: string | null; warehouseCode: string | null }>(
        `SELECT DISTINCT d.ItemCode AS itemCode, d.Warehouse AS warehouseCode
         FROM dbo.InventoryFlowHdr h
         INNER JOIN dbo.InventoryFlowDtl d
           ON h.TransactionNo = d.Transactionno AND h.VoucherNo = d.VoucherNo
         WHERE h.TransactionNo > @txn
            OR h.EntryDate     > @entry
            OR h.ApprovedDate  > @approved;`
      );
    const pairs: KrsChangedPair[] = [];
    for (const row of result.recordset ?? []) {
      const itemCode = cleanCode(row.itemCode);
      const warehouseCode = cleanCode(row.warehouseCode);
      // A pair needs both a mappable sku and a real warehouse; drop keyless/blank rows.
      if (itemCode === null || warehouseCode === null) continue;
      pairs.push({ itemCode, warehouseCode });
    }
    return pairs;
  } catch (e) {
    throwSanitizedQuery(e, "watermark changed-docs fetch");
  }
}

/**
 * Resolve the InventoryItem ItemCodes whose product-master row was CREATED since the
 * stored cursor (EntryDate > @itemEntry) — the set of brand-new products the existing
 * product-import path must upsert before their stock is reconciled. Only meaningful when
 * `itemMasterAdvanced` is true; when the cursor's `lastItemEntryAt` is null this binds as
 * SQL NULL and returns nothing (the first-run full reconcile handles the initial import).
 *
 * @itemEntry is a BOUND parameter; the table name is a fixed literal. No injection surface.
 */
export async function fetchChangedItems(
  pool: sql.ConnectionPool,
  cursor: WatermarkCursorState
): Promise<string[]> {
  try {
    const result = await pool
      .request()
      .input("itemEntry", sql.DateTime2, cursor.lastItemEntryAt)
      .query<{ itemCode: string | null }>(
        `SELECT ItemCode AS itemCode
         FROM dbo.InventoryItem
         WHERE EntryDate > @itemEntry;`
      );
    const codes: string[] = [];
    for (const row of result.recordset ?? []) {
      const itemCode = cleanCode(row.itemCode);
      if (itemCode !== null) codes.push(itemCode);
    }
    return codes;
  } catch (e) {
    throwSanitizedQuery(e, "watermark changed-items fetch");
  }
}

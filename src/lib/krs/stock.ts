// NODE-ONLY. Read-only current-stock fetch from the live KRS MS SQL Server
// (krs-sync R1 reconciliation + baseline import). Imported only by Node-runtime
// server code (the /api/krs/reconcile + /api/krs/sync-stock routes) — NEVER from a
// client component, `src/auth.config.ts`, or `src/middleware.ts` (it pulls in the
// `mssql` driver).
//
// This is the KRS-SIDE read for stock reconciliation. It REUSES the connection/
// pool/sanitized-error approach from `client.ts`:
//   - the caller passes an already-built `sql.config` (from buildConnectionConfig)
//   - a throwaway per-call pool is opened → queried → ALWAYS closed in `finally`
//   - on any driver error we log a SANITIZED `{ host, port, database, user, code,
//     message }` and re-throw a small, non-sensitive Error; the raw mssql/tedious
//     error (which can embed the config/password) is NEVER logged or propagated.
//
// STOCK SOURCE (Gate-6 live discovery): real current stock lives in the
// standard-cost stock ledger `dbo.tbl_STOCKSTD` (received/issued movement rows),
// keyed by `Itemcode` (which carries TRAILING SPACES in the real data → must be
// trimmed). Current balance per item =
//   SUM(IN_QTY) − SUM(OUT_QTY) grouped by TRIM(Itemcode)
// summed across warehouses + time. POS `Product.sku` == KRS trimmed `Itemcode`.
//
// SECURITY: the query is a FIXED string literal — there is NO user/config input
// interpolated into it (the table name is the hardcoded `dbo.tbl_STOCKSTD`), so it
// is injection-safe by construction (no `sp_executesql`, no QUOTENAME needed).

import sql from "mssql";
import { safeErrorParts } from "./client";
import { logger } from "@/lib/logger";

/**
 * One KRS item's aggregated current stock, keyed by the TRIMMED item code (which
 * equals a POS `Product.sku`). All values are coerced to finite JS numbers:
 *   - `totalIn`  = SUM(IN_QTY)  across all ledger rows for the item (รับเข้า)
 *   - `totalOut` = SUM(OUT_QTY) across all ledger rows for the item (ตัดออก)
 *   - `balance`  = totalIn − totalOut (current on-hand per the standard-cost ledger)
 * `balance` can be fractional (the ledger column is `decimal`) and can be negative
 * (over-issued / opening adjustments); the POS-side baseline import rounds + floors.
 */
export type KrsStockBalance = {
  itemCode: string;
  totalIn: number;
  totalOut: number;
  balance: number;
};

/** Coerce a KRS aggregate cell (mssql may return number | Decimal-as-string | null)
 *  to a finite JS number; non-finite / null collapse to 0. */
function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Trim a KRS item code to a non-empty key, or null (drop keyless ledger rows —
 *  a blank code cannot map to a unique POS `Product.sku`). The SQL already
 *  LTRIM/RTRIMs, but we defend again here in case the driver returns padding. */
function cleanItemCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Fetch the aggregated current-stock balance per item from the KRS standard-cost
 * stock ledger `dbo.tbl_STOCKSTD` (READ ONLY).
 *
 * The query is a FIXED literal (no user/config input): it groups the ledger by the
 * trimmed item code and computes received/issued totals + the net balance. Because
 * nothing is interpolated, there is NO injection surface — no parameters, no
 * `sp_executesql`.
 *
 *   SELECT LTRIM(RTRIM(Itemcode)) AS itemCode,
 *          SUM(ISNULL(IN_QTY,0))  AS totalIn,
 *          SUM(ISNULL(OUT_QTY,0)) AS totalOut,
 *          SUM(ISNULL(IN_QTY,0)) - SUM(ISNULL(OUT_QTY,0)) AS balance
 *   FROM dbo.tbl_STOCKSTD
 *   GROUP BY LTRIM(RTRIM(Itemcode));
 *
 * Returns `KrsStockBalance[]` (numbers coerced; keyless/blank-code rows dropped).
 * On a driver error: logs a SANITIZED error (never the raw mssql error/config) and
 * throws a small, non-sensitive `Error`. The pool is ALWAYS closed in `finally`.
 */
export async function fetchKrsStockBalances(
  config: sql.config
): Promise<KrsStockBalance[]> {
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();

    const result = await pool.request().query<{
      itemCode: string | null;
      totalIn: unknown;
      totalOut: unknown;
      balance: unknown;
    }>(
      `SELECT
         LTRIM(RTRIM(Itemcode))                         AS itemCode,
         SUM(ISNULL(IN_QTY, 0))                         AS totalIn,
         SUM(ISNULL(OUT_QTY, 0))                        AS totalOut,
         SUM(ISNULL(IN_QTY, 0)) - SUM(ISNULL(OUT_QTY, 0)) AS balance
       FROM dbo.tbl_STOCKSTD
       GROUP BY LTRIM(RTRIM(Itemcode));`
    );

    const balances: KrsStockBalance[] = [];
    for (const row of result.recordset) {
      const itemCode = cleanItemCode(row.itemCode);
      if (itemCode === null) continue; // no natural key → cannot map to a POS sku.
      balances.push({
        itemCode,
        totalIn: toNum(row.totalIn),
        totalOut: toNum(row.totalOut),
        balance: toNum(row.balance),
      });
    }
    return balances;
  } catch (e) {
    const parts = safeErrorParts(e);
    const sanitized = {
      host: config.server,
      port: config.port,
      database: config.database,
      user: config.user,
      code: parts.code,
      message: parts.message,
    };
    // The FULL raw message stays server-side only (already stripped of driver
    // keys). We throw a small, non-sensitive Error so the route maps it to a clean
    // boundary message (never the raw mssql/tedious message, which leaks host/login).
    logger.error({ krsErr: sanitized }, "KRS stock fetch failed");
    throw new Error("KRS stock fetch failed");
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        // Closing a pool that never fully opened can throw; the work (or its error)
        // is already determined, so swallow the close error.
      }
    }
  }
}

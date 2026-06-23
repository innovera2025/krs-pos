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
// STOCK SOURCE — the VENDOR-AUTHORITATIVE on-hand stored procedure `dbo.sp_Onhand`
// (params @ItemCode, @Date, @Warehouse → recordset of `ItemCode, Balqty`). Its body
// (read-only SELECT) is:
//   SELECT d.ItemCode, ISNULL(SUM(d.InOut * d.MainQuantity),0) AS Balqty
//   FROM InventoryFlowHdr h LEFT JOIN InventoryFlowDtl d
//     ON h.TranSactionno = d.Transactionno AND h.VoucherNo = d.VoucherNo
//   WHERE (ISNULL(@ItemCode,'')='' OR d.ItemCode=@ItemCode)
//     AND (ISNULL(@Date,'')='' OR h.InOutDate <= @Date)
//     AND ISNULL(h.Approved,0)=1 AND ISNULL(h.IsClosed,0)<>1
//     AND (ISNULL(@Warehouse,'')='' OR d.Warehouse=@Warehouse)
//   GROUP BY d.ItemCode
// We call it with ALL THREE params NULL — the proc's own declared defaults — which
// means: every item, no as-of-date cap (full current balance), all warehouses
// summed. That single call returns the on-hand for the whole catalogue (no per-item
// loop). POS `Product.sku` == the (trimmed) KRS `ItemCode`.
//
// NOTE: sp_Onhand sums only APPROVED, not-closed `InventoryFlow` movement documents.
// In a KRS database where the inventory-flow module has posted no approved documents
// it legitimately returns ZERO rows — that is a data condition of that database, not
// an error (the reconcile/sync paths handle an empty result cleanly).
//
// SECURITY: the only SQL text is the FIXED proc name literal `dbo.sp_Onhand`; the
// three arguments are passed as BOUND parameters via `request.input(...)` +
// `.execute(...)`, so there is NO string interpolation and NO injection surface
// (no `sp_executesql`, no QUOTENAME needed).

import sql from "mssql";
import { safeErrorParts } from "./client";
import { logger } from "@/lib/logger";

/**
 * One KRS item's current on-hand balance, keyed by the TRIMMED item code (which
 * equals a POS `Product.sku`). `balance` is the `Balqty` returned by sp_Onhand —
 * the net on-hand (SUM of signed movement quantities). It is coerced to a finite JS
 * number; it can be fractional (the underlying column is decimal) and can be
 * negative (over-issued / opening adjustments). The POS-side baseline import rounds
 * + floors it.
 */
export type KrsStockBalance = {
  itemCode: string;
  balance: number;
};

/** Coerce a KRS value (mssql may return number | Decimal-as-string | null) to a
 *  finite JS number; non-finite / null collapse to 0. */
function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Trim a KRS item code to a non-empty key, or null (drop keyless rows — a blank
 *  code cannot map to a unique POS `Product.sku`). sp_Onhand groups by `ItemCode`;
 *  KRS codes can carry trailing padding, so we trim defensively here. */
function cleanItemCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Fetch the current on-hand balance per item from the KRS vendor-authoritative
 * stored procedure `dbo.sp_Onhand` (READ ONLY).
 *
 * Called as `EXEC dbo.sp_Onhand @ItemCode=NULL, @Date=NULL, @Warehouse=NULL` with
 * the three arguments passed as BOUND parameters (never interpolated) — all-NULL is
 * the proc's own default, returning every item's full current on-hand across all
 * warehouses in a single call. Because nothing is interpolated, there is NO
 * injection surface (no parameters concatenated, no `sp_executesql`).
 *
 * Returns `KrsStockBalance[]` (numbers coerced; keyless/blank-code rows dropped).
 * An EMPTY array is a valid result (a KRS DB with no approved inventory-flow
 * documents). On a driver error: logs a SANITIZED error (never the raw mssql error/
 * config) and throws a small, non-sensitive `Error`. The pool is ALWAYS closed.
 */
export async function fetchKrsStockBalances(
  config: sql.config
): Promise<KrsStockBalance[]> {
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();

    // All three args are NULL (the proc's declared defaults): every item, no as-of
    // date cap (full current balance), all warehouses. Passed as BOUND parameters —
    // their types mirror the proc signature (@ItemCode NVARCHAR, @Date DATE,
    // @Warehouse NVARCHAR). `.execute` invokes the proc by its fixed name; the
    // values can never break out of the call (no string interpolation).
    const result = await pool
      .request()
      .input("ItemCode", sql.NVarChar(50), null)
      .input("Date", sql.Date, null)
      .input("Warehouse", sql.NVarChar(20), null)
      .execute<{ ItemCode: string | null; Balqty: unknown }>("dbo.sp_Onhand");

    const balances: KrsStockBalance[] = [];
    for (const row of result.recordset ?? []) {
      const itemCode = cleanItemCode(row.ItemCode);
      if (itemCode === null) continue; // no natural key → cannot map to a POS sku.
      balances.push({ itemCode, balance: toNum(row.Balqty) });
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

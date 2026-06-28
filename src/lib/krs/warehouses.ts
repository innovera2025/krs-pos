// NODE-ONLY. Read-only warehouse master fetch from the live KRS MS SQL Server
// (Branch/Warehouse program, Phase 1 — the inbound "pull warehouses" path).
// Imported only by Node-runtime server code (the /api/krs/pull-warehouses route) —
// NEVER from a client component, `src/auth.config.ts`, or `src/middleware.ts`.
//
// This module is the KRS-SIDE half of the inbound warehouse pull (mssql READ ONLY);
// the POS-SIDE upsert lives in `importWarehouses.ts`. It REUSES the connection/pool/
// sanitized-error approach from `client.ts` / `products.ts`:
//   - the caller passes an already-built `sql.config` (from buildConnectionConfig)
//   - a throwaway per-call pool is opened → queried → ALWAYS closed in `finally`
//   - on any driver error we log a SANITIZED `{ host, port, database, user, code,
//     message }` and re-throw a small, non-sensitive Error; the raw mssql/tedious
//     error (which can embed the config/password) is NEVER logged or propagated.
//
// FIXED source (no injection surface): unlike the product pull, the warehouse source
// table and columns are HARDCODED here (`dbo.Warehouse` → WarehouseCode/WarehouseName/
// BranchCode), not config-supplied. The SELECT is therefore a CONSTANT string with no
// user/config input — the same parameter-free, injection-free shape as the schema
// browser's fixed `listKrsTablesWithConfig` query. No QUOTENAME/sp_executesql is
// needed because nothing untrusted is interpolated.

import sql from "mssql";
import { safeErrorParts } from "./client";
import { logger } from "@/lib/logger";

/**
 * One KRS warehouse record, mapped to the POS-facing shape the importer consumes.
 * The KRS column → POS field mapping is FIXED (the warehouse master is a small,
 * stable lookup table, not a user-configured import):
 *   - `warehouseCode` ← KRS `WarehouseCode` (natural unique key, e.g. "WH01")
 *   - `warehouseName` ← KRS `WarehouseName` (Thai, e.g. "คลังปัตตานี")
 *   - `branchCode`    ← KRS `BranchCode`    (the branch this warehouse maps to)
 */
export type KrsWarehouseRecord = {
  warehouseCode: string;
  warehouseName: string;
  branchCode: string;
};

/** Trim a nullable string to a non-empty value, or null. */
function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Fetch the KRS warehouse master from `dbo.Warehouse` (READ ONLY).
 *
 * The source table + columns are FIXED constants (no config, no user input), so the
 * SELECT is a constant string with no injection surface. Each row is TRIMMED; a row
 * with no `warehouseCode` (no natural key) is dropped — a POS `Warehouse.warehouseCode`
 * is the required PK, so a keyless KRS row cannot be upserted. `warehouseName` falls
 * back to the code when blank so a row is never nameless; `branchCode` falls back to
 * the empty string when blank (it is a required column but never the natural key).
 *
 * On a driver error: logs a SANITIZED error (never the raw mssql error/config) and
 * throws a small, non-sensitive `Error`. The pool is ALWAYS closed in `finally`.
 */
export async function fetchKrsWarehouses(
  config: sql.config
): Promise<KrsWarehouseRecord[]> {
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();

    // Constant, parameter-free SELECT — fixed table + columns, no user/config input
    // (no injection surface). Aliases keep the recordset keys stable + lowercased.
    const result = await pool.request().query<{
      warehouseCode: unknown;
      warehouseName: unknown;
      branchCode: unknown;
    }>(
      `SELECT
         WarehouseCode AS warehouseCode,
         WarehouseName AS warehouseName,
         BranchCode    AS branchCode
       FROM dbo.Warehouse;`
    );

    const records: KrsWarehouseRecord[] = [];
    for (const row of result.recordset) {
      const warehouseCode = cleanString(row.warehouseCode);
      // No natural key → cannot map to a unique POS Warehouse.warehouseCode; skip.
      if (warehouseCode === null) continue;
      records.push({
        warehouseCode,
        // Fall back to the code when the KRS name is blank (Warehouse.warehouseName
        // is required).
        warehouseName: cleanString(row.warehouseName) ?? warehouseCode,
        // branchCode is required but never the natural key; blank → "".
        branchCode: cleanString(row.branchCode) ?? "",
      });
    }
    return records;
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
    // The FULL raw message stays server-side only (already stripped of driver keys).
    // We throw a small, non-sensitive Error so the route maps it to a clean boundary
    // message (never the raw mssql/tedious message, which leaks host/login).
    logger.error({ krsErr: sanitized }, "KRS warehouse fetch failed");
    throw new Error("KRS warehouse fetch failed");
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

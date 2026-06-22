// NODE-ONLY. Read-only product master fetch from the live KRS MS SQL Server
// (krs-sync inbound "pull products" path). Imported only by Node-runtime server
// code (the /api/krs/pull-products route and the one-time import script) — NEVER
// from a client component, `src/auth.config.ts`, or `src/middleware.ts`.
//
// This module is the KRS-SIDE half of the inbound pull (mssql READ ONLY); the
// POS-SIDE upsert lives in `importProducts.ts`. It REUSES the connection/pool/
// sanitized-error approach from `client.ts`:
//   - the caller passes an already-built `sql.config` (from buildConnectionConfig)
//   - a throwaway per-call pool is opened → queried → ALWAYS closed in `finally`
//   - the SQL is FIXED + parameter-free (no user input crosses it → no injection)
//   - on any driver error we log a SANITIZED `{ host, port, database, user, code,
//     message }` and re-throw a small, non-sensitive Error; the raw mssql/tedious
//     error (which can embed the config/password) is NEVER logged or propagated.

import sql from "mssql";
import { safeErrorParts } from "./client";
import { logger } from "@/lib/logger";

/**
 * One KRS product record, mapped to the POS-facing shape the importer consumes.
 * The KRS column → POS field mapping (owner-approved):
 *   - `sku`          ← KRS `ItemCode`     (natural unique key, e.g. "F01-0001")
 *   - `name`         ← KRS `ItemName`     (Thai)
 *   - `price`        ← KRS `Saleprice1`   (retail; KRS `money` → JS number, 2dp)
 *   - `barcode`      ← KRS `BarCode`      (real EAN; null when blank)
 *   - `isActive`     ← KRS `IsActive`     (1 → true)
 *   - `categoryName` ← KRS `ItemTypename` (POS Category name; null when blank)
 *
 * `price` is a plain JS number rounded to 2dp here for transport. The importer
 * re-derives the exact 2dp Decimal string and bounds it to Decimal(10,2) — this
 * number is a convenience, not the money source of truth.
 */
export type KrsProductRecord = {
  sku: string;
  name: string;
  price: number;
  barcode: string | null;
  isActive: boolean;
  categoryName: string | null;
};

/** Raw recordset row shape from the `InventoryItem` SELECT (KRS column names). */
type InventoryItemRow = {
  ItemCode: string | null;
  ItemName: string | null;
  // KRS `money` arrives as a JS number via the mssql driver; null-guarded below.
  Saleprice1: number | null;
  BarCode: string | null;
  // KRS `IsActive` is a bit/int; the driver may surface it as boolean or number.
  IsActive: boolean | number | null;
  ItemTypename: string | null;
};

/** Trim a nullable string to a non-empty value, or null. */
function cleanString(v: string | null): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Round a KRS money number to a finite, non-negative 2dp number for transport.
 *  Non-finite / negative inputs collapse to 0 (the importer applies the hard
 *  Decimal(10,2) bound). */
function toPrice2dp(v: number | null): number {
  if (v === null || !Number.isFinite(v) || v < 0) return 0;
  // Round via integer satang to avoid float drift (mirrors orderSerialize.toSatang).
  return Math.round(v * 100) / 100;
}

/**
 * Fetch the ACTIVE KRS product master from `dbo.InventoryItem` (READ ONLY).
 *
 * Fixed, parameter-free SQL (no injection surface): selects the six mapped columns
 * for `WHERE IsActive = 1`. Rows with no `ItemCode` (no natural key) are dropped —
 * a POS `Product.sku` is required + unique, so a keyless KRS row cannot be upserted.
 *
 * On a driver error: logs a SANITIZED error (never the raw mssql error/config) and
 * throws a small, non-sensitive `Error("KRS product fetch failed")`. The pool is
 * ALWAYS closed in a `finally`, even on error.
 */
export async function fetchKrsProducts(
  config: sql.config
): Promise<KrsProductRecord[]> {
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();
    const result = await pool.request().query<InventoryItemRow>(
      `SELECT
         ItemCode, ItemName, Saleprice1, BarCode, IsActive, ItemTypename
       FROM dbo.InventoryItem
       WHERE IsActive = 1;`
    );

    const records: KrsProductRecord[] = [];
    for (const r of result.recordset) {
      const sku = cleanString(r.ItemCode);
      // No natural key → cannot map to a unique POS Product.sku; skip.
      if (sku === null) continue;
      records.push({
        sku,
        // Fall back to the item code when the KRS name is blank so the POS row is
        // never nameless (Product.name is required).
        name: cleanString(r.ItemName) ?? sku,
        price: toPrice2dp(r.Saleprice1),
        barcode: cleanString(r.BarCode),
        // KRS IsActive may be boolean or 1/0; coerce both. (We filtered IsActive=1
        // above, so this is effectively always true, but stays correct regardless.)
        isActive: r.IsActive === true || r.IsActive === 1,
        categoryName: cleanString(r.ItemTypename),
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
    // The FULL raw message stays server-side only (already stripped of driver
    // keys). We throw a small, non-sensitive Error so the route maps it to a clean
    // boundary message (never the raw mssql/tedious message, which leaks host/login).
    logger.error({ krsErr: sanitized }, "KRS product fetch failed");
    throw new Error("KRS product fetch failed");
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

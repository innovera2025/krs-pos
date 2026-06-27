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
//   - on any driver error we log a SANITIZED `{ host, port, database, user, code,
//     message }` and re-throw a small, non-sensitive Error; the raw mssql/tedious
//     error (which can embed the config/password) is NEVER logged or propagated.
//
// CONFIGURABLE MAPPING (krs-sync inbound import config): the source table + the
// KRS-column → POS-field mapping are no longer hardcoded. They come from
// `getProductImportMapping()` (the saved `KrsFieldMapping` row, or the typed
// default). Because that mapping carries CONFIG-SUPPLIED identifiers (a table name
// + column names), it is treated as UNTRUSTED and made injection-safe exactly like
// the schema browser's user-supplied table name (see `getKrsTableDetailWithConfig`):
//
//   1. VALIDATE first (`validateMapping`) — a PARAMETERIZED existence check
//      authorizes the source table + resolves its real schema, and confirms every
//      mapped column exists in the live INFORMATION_SCHEMA column set. The config
//      strings travel ONLY as bound parameters here; nothing is interpolated. A
//      validation failure (table/column gone) THROWS — we never silently pull wrong
//      data.
//   2. Build the SELECT with QUOTENAME'd identifiers ONLY — the resolved schema,
//      table, and each mapped column are passed as bound NVarChar params and
//      QUOTENAME() bracket-escapes them inside SQL Server, then `sp_executesql` runs
//      the assembled statement. A config value containing `]` or `;` cannot break
//      out. NO config value is ever raw-concatenated into SQL.

import sql from "mssql";
import { safeErrorParts } from "./client";
import {
  getProductImportMapping,
  validateMapping,
  PRODUCT_TARGET_FIELDS,
  type ProductImportMapping,
  type ProductTargetField,
} from "./mapping";
import { logger } from "@/lib/logger";

/**
 * One KRS product record, mapped to the POS-facing shape the importer consumes.
 * The KRS column → POS field mapping is now CONFIGURABLE (default + persisted row);
 * the DEFAULT mapping (previously hardcoded) is:
 *   - `sku`          ← KRS `ItemCode`     (natural unique key, e.g. "F01-0001")
 *   - `name`         ← KRS `ItemName`     (Thai)
 *   - `price`        ← KRS `Saleprice1`   (retail; KRS `money` → JS number, 2dp)
 *   - `barcode`      ← KRS `BarCode`      (real EAN; null when blank/unmapped)
 *   - `isActive`     ← KRS `IsActive`     (1 → true; defaults true when unmapped)
 *   - `categoryName` ← KRS `ItemTypename` (POS Category name; null when blank/unmapped)
 *   - `imageUrl`     ← KRS `PictureName`  (raw image filename, e.g. "F01-0001.JPG";
 *                                          null when blank/unmapped)
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
  /** Raw KRS image filename (e.g. "F01-0001.JPG"); null when KRS PictureName is
   *  blank/unmapped. Served (FTP-proxied) by /api/products/image. */
  imageUrl: string | null;
};

/** Trim a nullable string to a non-empty value, or null. */
function cleanString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/** Round a KRS money number to a finite, non-negative 2dp number for transport.
 *  Non-finite / negative inputs collapse to 0 (the importer applies the hard
 *  Decimal(10,2) bound). Non-number inputs (e.g. a mis-mapped text column) → 0. */
function toPrice2dp(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Round via integer satang to avoid float drift (mirrors orderSerialize.toSatang).
  return Math.round(n * 100) / 100;
}

/** Coerce a KRS IsActive cell (bit/int/bool, possibly string "1"/"0") → boolean.
 *  An UNMAPPED isActive (the field has no source column) is handled by the caller
 *  defaulting to true; here we only coerce a present value. */
function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * Resolve the SELECT projection: each mapped POS target field → its (case-resolved)
 * KRS column name. We build a stable list of `{ field, column }` pairs in the
 * target-field display order (so the SELECT column order is deterministic). The
 * column casing comes from the LIVE schema (`liveColumns`) — never the config's
 * casing — so the QUOTENAME'd identifier matches the real stored identifier.
 */
function resolveProjection(
  mapping: ProductImportMapping,
  liveColumns: string[]
): { field: ProductTargetField; column: string }[] {
  const liveByLower = new Map<string, string>();
  for (const c of liveColumns) liveByLower.set(c.toLowerCase(), c);

  const pairs: { field: ProductTargetField; column: string }[] = [];
  for (const spec of PRODUCT_TARGET_FIELDS) {
    const configured = mapping.fieldMap[spec.field];
    if (typeof configured !== "string" || configured.trim().length === 0) continue;
    // Use the live (real-cased) column name; validateMapping already proved it exists.
    const resolved = liveByLower.get(configured.trim().toLowerCase());
    if (resolved === undefined) continue; // defensive — validation already guaranteed it
    pairs.push({ field: spec.field, column: resolved });
  }
  return pairs;
}

/**
 * Fetch the ACTIVE KRS product master from the configured source table (READ ONLY).
 *
 * Source table + the KRS-column → POS-field mapping come from
 * `getProductImportMapping()` (saved row or typed default). Because those are
 * config-supplied identifiers, this path is made INJECTION-SAFE the same way the
 * schema browser handles a user-supplied table name:
 *
 *   1. `validateMapping(config, mapping)` — a PARAMETERIZED existence check
 *      authorizes the source table (binds the name as a parameter; resolves its real
 *      schema) and confirms every mapped column exists in the live column set. On
 *      failure we THROW (never silently pull wrong data).
 *   2. The SELECT is assembled inside SQL Server with QUOTENAME() over the resolved
 *      schema/table and each mapped column (all bound NVarChar params), then run via
 *      `sp_executesql`. No config value is raw-concatenated; a name containing `]` /
 *      `;` cannot escape. An `isActive`-mapped column is also QUOTENAME'd into the
 *      `WHERE <isActiveCol> = 1` filter; when isActive is UNMAPPED we read all rows
 *      (no IsActive filter) and default the record's `isActive` to true.
 *
 * Rows with no `sku` (no natural key) are dropped — a POS `Product.sku` is required
 * + unique, so a keyless KRS row cannot be upserted. Required fields are enforced by
 * `validateMapping`; an unmapped OPTIONAL field yields null (or true for isActive).
 *
 * On a driver/validation error: logs a SANITIZED error (never the raw mssql error/
 * config) and throws a small, non-sensitive `Error`. The pool is ALWAYS closed.
 */
export async function fetchKrsProducts(
  config: sql.config
): Promise<KrsProductRecord[]> {
  // Load + validate the mapping BEFORE opening the data connection's query. Note:
  // validateMapping itself opens a (throwaway) introspection pool via the existing
  // client helper — we keep this OUTSIDE the data-pool try/finally so a validation
  // failure surfaces its own clear error and never leaves the data pool dangling.
  const mapping = await getProductImportMapping();
  const validation = await validateMapping(config, mapping);
  if (!validation.ok) {
    // The mapping is unusable (table/column gone, or a required field unmapped). Do
    // NOT silently pull wrong data — throw a clear, non-sensitive error. The reason
    // is a safe code; the message is already sanitized (no driver internals).
    logger.error(
      { krsMapping: { function: mapping.function, reason: validation.reason } },
      "KRS product mapping validation failed"
    );
    throw new Error(`KRS product mapping invalid: ${validation.reason}`);
  }

  const projection = resolveProjection(mapping, validation.columns);
  if (projection.length === 0) {
    // Defensive: validation guarantees the required fields are mapped, so this is
    // unreachable in practice; throw rather than run an empty SELECT.
    throw new Error("KRS product mapping invalid: NO_PROJECTION");
  }

  // Resolve which configured column (if any) holds isActive — drives both the
  // SELECT alias and the optional WHERE filter.
  const isActiveCol = projection.find((p) => p.field === "isActive")?.column ?? null;

  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();

    // Build the SELECT inside SQL Server with QUOTENAME over the VALIDATED schema +
    // table + each mapped column. Every identifier is a bound NVarChar param that
    // QUOTENAME bracket-escapes; `sp_executesql` then runs the assembled statement.
    // We alias each selected column to its POS target field name (`@cN` bound +
    // QUOTENAME'd) so the recordset keys are the stable POS field names regardless
    // of the KRS column casing. NOTHING is raw-concatenated from config.
    const request = pool.request();
    // Use the REAL schema the existence check resolved (never a hardcoded "dbo") —
    // bound + QUOTENAME'd below, like the schema/table/columns.
    request.input("schema", sql.NVarChar, validation.schema);
    request.input("table", sql.NVarChar, mapping.sourceTable);

    // Assemble the SELECT-list expression server-side: `QUOTENAME(@c0) AS QUOTENAME(@a0), …`.
    const selectParts: string[] = [];
    projection.forEach((p, i) => {
      request.input(`c${i}`, sql.NVarChar, p.column);
      request.input(`a${i}`, sql.NVarChar, p.field);
      selectParts.push(`QUOTENAME(@c${i}) + N' AS ' + QUOTENAME(@a${i})`);
    });
    const selectExpr = selectParts.join(" + N', ' + ");

    // Optional `WHERE <isActiveCol> = 1` — only when isActive is mapped. The column
    // is QUOTENAME'd (bound @flag param); the literal `1` is constant.
    let whereExpr = "N''";
    if (isActiveCol !== null) {
      request.input("flag", sql.NVarChar, isActiveCol);
      whereExpr = "N' WHERE ' + QUOTENAME(@flag) + N' = 1'";
    }

    // The full dynamic statement is assembled from QUOTENAME'd pieces only. The
    // outer SELECT keyword + commas/FROM are constant string literals.
    const result = await request.query<Record<string, unknown>>(
      `DECLARE @stmt NVARCHAR(MAX) =
         N'SELECT ' + ${selectExpr}
         + N' FROM ' + QUOTENAME(@schema) + N'.' + QUOTENAME(@table)
         + ${whereExpr} + N';';
       EXEC sp_executesql @stmt;`
    );

    const records: KrsProductRecord[] = [];
    for (const row of result.recordset) {
      const sku = cleanString(row.sku);
      // No natural key → cannot map to a unique POS Product.sku; skip.
      if (sku === null) continue;
      records.push({
        sku,
        // Fall back to the item code when the KRS name is blank so the POS row is
        // never nameless (Product.name is required).
        name: cleanString(row.name) ?? sku,
        price: toPrice2dp(row.price),
        // Optional, unmapped → the key is absent from the row → cleanString → null.
        barcode: cleanString(row.barcode),
        // isActive: when mapped, coerce the cell; when UNMAPPED (no filter applied)
        // default to true so the POS row is active by default.
        isActive: isActiveCol !== null ? toBool(row.isActive) : true,
        categoryName: cleanString(row.category),
        // Raw image filename (e.g. "F01-0001.JPG"); optional/unmapped → key absent
        // from the row → cleanString → null. The importer stores it on imageUrl.
        imageUrl: cleanString(row.imageUrl),
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

// NODE-ONLY. The configurable KRS field-mapping config (krs-sync inbound import).
// Imported only by Node-runtime server code (the KRS mapping API + the refactored
// `products.ts` fetch) — NEVER from a client component, `src/auth.config.ts`, or
// `src/middleware.ts` (it pulls in the Prisma singleton + the mssql client).
//
// WHAT THIS IS: the inbound product-import column mapping used to be hardcoded in
// `fetchKrsProducts` (sku←ItemCode, name←ItemName, …). This module makes that
// mapping CONFIGURABLE + persisted (the `KrsFieldMapping` row), while keeping the
// previous hardcoded mapping as the typed DEFAULT so a fresh deploy still works.
//
// GENERIC BY DESIGN: only PRODUCT_IMPORT is wired today, but the shapes here
// (target-field spec + a function-keyed default) are written so stock/customer/
// outbound functions can be added later without reworking the model.
//
// INJECTION SAFETY: a mapping is only ever trustworthy AFTER it is validated
// against the LIVE introspected schema of its `sourceTable`. `validateMapping`
// REUSES the existing parameterized introspection (`getKrsTableDetailWithConfig` in
// `client.ts`, whose existence check binds the table name as a parameter and whose
// columns come from INFORMATION_SCHEMA) — it does NOT issue a parallel raw query.
// The refactored fetch then builds the SELECT with QUOTENAME'd identifiers only.

import sql from "mssql";
import { prisma } from "@/lib/prisma";
import { getKrsTableDetailWithConfig } from "./client";

/**
 * The function keys this config supports. Only PRODUCT_IMPORT is wired today; the
 * union is the extension point for stock/customer/outbound functions later.
 */
export type KrsMappingFunction = "PRODUCT_IMPORT";

/** The single wired function key (used as the literal in the API Zod schema). */
export const PRODUCT_IMPORT: KrsMappingFunction = "PRODUCT_IMPORT";

/**
 * The POS target fields for the PRODUCT_IMPORT function. `sku`/`name`/`price` are
 * REQUIRED (a POS Product cannot exist without them); the rest are OPTIONAL (an
 * unmapped optional field simply yields null on the imported record).
 */
export type ProductTargetField =
  | "sku"
  | "name"
  | "price"
  | "barcode"
  | "category"
  | "isActive";

/** One target-field spec entry (drives both the UI and server-side validation). */
export type TargetFieldSpec = {
  field: ProductTargetField;
  required: boolean;
  /** Thai-first label for the mapping UI. */
  label: string;
};

/**
 * The PRODUCT_IMPORT target-field spec — the single source of truth for WHICH POS
 * fields are mappable and which are required. Order is the UI display order.
 */
export const PRODUCT_TARGET_FIELDS: TargetFieldSpec[] = [
  { field: "sku", required: true, label: "รหัสสินค้า · SKU" },
  { field: "name", required: true, label: "ชื่อสินค้า · Name" },
  { field: "price", required: true, label: "ราคาขาย · Price" },
  { field: "barcode", required: false, label: "บาร์โค้ด · Barcode" },
  { field: "category", required: false, label: "หมวดหมู่ · Category" },
  { field: "isActive", required: false, label: "สถานะใช้งาน · Active" },
];

/** The set of known PRODUCT_IMPORT target fields (for fast membership checks). */
export const PRODUCT_TARGET_FIELD_SET: ReadonlySet<string> = new Set(
  PRODUCT_TARGET_FIELDS.map((t) => t.field)
);

/** The REQUIRED PRODUCT_IMPORT target fields (must be present in any valid map). */
export const PRODUCT_REQUIRED_FIELDS: ProductTargetField[] = PRODUCT_TARGET_FIELDS
  .filter((t) => t.required)
  .map((t) => t.field);

/**
 * A field map for a function: `{ posTargetField -> krsColumnName }`. A target field
 * absent from the map is "unmapped" (optional → null; a required field MUST be
 * present or validation fails). Partial keyed by the function's target fields.
 */
export type ProductFieldMap = Partial<Record<ProductTargetField, string>>;

/** A resolved PRODUCT_IMPORT mapping (source table + field map). */
export type ProductImportMapping = {
  function: KrsMappingFunction;
  sourceTable: string;
  fieldMap: ProductFieldMap;
};

/**
 * The DEFAULT PRODUCT_IMPORT mapping — the EXACT column names previously hardcoded
 * in `fetchKrsProducts`. Used when no `KrsFieldMapping` row exists yet, so the
 * "ดึงสินค้าจาก KRS" pull keeps working on a fresh deploy without configuration.
 */
export const DEFAULT_PRODUCT_IMPORT_MAPPING: ProductImportMapping = {
  function: PRODUCT_IMPORT,
  sourceTable: "InventoryItem",
  fieldMap: {
    sku: "ItemCode",
    name: "ItemName",
    price: "Saleprice1",
    barcode: "BarCode",
    category: "ItemTypename",
    isActive: "IsActive",
  },
};

/**
 * Coerce a persisted `fieldMap` Json blob into a typed `ProductFieldMap`, keeping
 * ONLY known target-field keys with non-empty string values. Defensive: the column
 * is `Json`, so a hand-edited / future-shaped row cannot smuggle an unknown key or a
 * non-string value into the SELECT builder (every value is re-validated against the
 * live schema before use anyway, but this keeps the in-memory shape clean + typed).
 */
function coerceProductFieldMap(raw: unknown): ProductFieldMap {
  const out: ProductFieldMap = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PRODUCT_TARGET_FIELD_SET.has(key)) continue;
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    out[key as ProductTargetField] = trimmed;
  }
  return out;
}

/**
 * Read the saved PRODUCT_IMPORT mapping from the `KrsFieldMapping` row (Prisma READ
 * ONLY), falling back to `DEFAULT_PRODUCT_IMPORT_MAPPING` when no row exists. The
 * persisted `sourceTable`/`fieldMap` are NOT trusted on their own — the caller MUST
 * still `validateMapping` against the live schema before building any SQL.
 *
 * A row with a missing/blank `sourceTable` (corrupt/partial) falls back to the
 * default source table; an empty coerced field map falls back to the default map,
 * so a degenerate row can never produce a keyless SELECT.
 */
export async function getProductImportMapping(): Promise<ProductImportMapping> {
  const row = await prisma.krsFieldMapping.findUnique({
    where: { function: PRODUCT_IMPORT },
    select: { sourceTable: true, fieldMap: true },
  });
  if (!row) return DEFAULT_PRODUCT_IMPORT_MAPPING;

  const sourceTable =
    typeof row.sourceTable === "string" && row.sourceTable.trim().length > 0
      ? row.sourceTable.trim()
      : DEFAULT_PRODUCT_IMPORT_MAPPING.sourceTable;
  const fieldMap = coerceProductFieldMap(row.fieldMap);

  return {
    function: PRODUCT_IMPORT,
    sourceTable,
    // Never let a degenerate empty map through — fall back to the default map.
    fieldMap: Object.keys(fieldMap).length > 0 ? fieldMap : DEFAULT_PRODUCT_IMPORT_MAPPING.fieldMap,
  };
}

/** The discriminated result of validating a mapping against the live KRS schema. */
export type ValidateMappingResult =
  | {
      ok: true;
      /** The REAL schema the existence check resolved (never a client-assumed one) —
       *  threaded into the QUOTENAME'd SELECT so we don't assume "dbo". */
      schema: string;
      /** The live column names (exact stored casing) for the QUOTENAME'd SELECT. */
      columns: string[];
    }
  | {
      // The mapping is unusable. `reason` is a SAFE, non-sensitive code; `message`
      // is a Thai+EN string suitable for the API boundary / a thrown error.
      ok: false;
      reason:
        | "TABLE_NOT_FOUND"
        | "MISSING_REQUIRED"
        | "COLUMN_NOT_FOUND"
        | "INTROSPECTION_FAILED";
      message: string;
    };

/**
 * Validate a PRODUCT_IMPORT mapping against the LIVE introspected schema of its
 * `sourceTable`, REUSING the existing parameterized introspection in `client.ts`:
 *
 *  1. `getKrsTableDetailWithConfig(config, sourceTable)` runs the SAME injection-safe
 *     path the schema browser uses — a PARAMETERIZED existence check
 *     (`WHERE TABLE_NAME = @t`) authorizes the table name + resolves its real schema,
 *     and the columns come from INFORMATION_SCHEMA (also parameterized). The
 *     `sourceTable` value travels ONLY as a bound parameter; it is never interpolated.
 *       - `not-found` → TABLE_NOT_FOUND (the table is not a real base table)
 *       - `error`     → INTROSPECTION_FAILED (a driver/query fault, already logged)
 *  2. Every REQUIRED target field MUST be mapped (else MISSING_REQUIRED).
 *  3. Every mapped column MUST exist (case-insensitively, matching SQL Server's
 *     default collation) in the live column set (else COLUMN_NOT_FOUND) — so a
 *     mapped column that no longer exists is rejected instead of silently pulling
 *     wrong/missing data.
 *
 * On success returns the live column NAMES (so the caller can resolve the exact
 * stored casing for the QUOTENAME'd SELECT — we never trust the config's casing).
 */
export async function validateMapping(
  config: sql.config,
  mapping: ProductImportMapping
): Promise<ValidateMappingResult> {
  const detail = await getKrsTableDetailWithConfig(config, mapping.sourceTable);
  if (detail.status === "not-found") {
    return {
      ok: false,
      reason: "TABLE_NOT_FOUND",
      message: `ไม่พบตาราง "${mapping.sourceTable}" ใน KRS · source table not found`,
    };
  }
  if (detail.status === "error") {
    return {
      ok: false,
      reason: "INTROSPECTION_FAILED",
      message: "อ่านสคีมาของตารางไม่สำเร็จ · could not read table schema",
    };
  }

  // Every required target field must be mapped.
  for (const field of PRODUCT_REQUIRED_FIELDS) {
    const col = mapping.fieldMap[field];
    if (typeof col !== "string" || col.trim().length === 0) {
      return {
        ok: false,
        reason: "MISSING_REQUIRED",
        message: `ฟิลด์บังคับ "${field}" ยังไม่ได้จับคู่คอลัมน์ · required field is unmapped`,
      };
    }
  }

  // Build a case-insensitive lookup of the live columns (SQL Server identifiers are
  // case-insensitive under the default collation). The map's VALUE preserves the
  // exact stored casing so the SELECT QUOTENAMEs the real identifier.
  const liveByLower = new Map<string, string>();
  for (const c of detail.detail.columns) {
    liveByLower.set(c.columnName.toLowerCase(), c.columnName);
  }

  // Every mapped column must exist in the live schema.
  for (const [field, col] of Object.entries(mapping.fieldMap)) {
    if (typeof col !== "string" || col.trim().length === 0) continue;
    if (!liveByLower.has(col.trim().toLowerCase())) {
      return {
        ok: false,
        reason: "COLUMN_NOT_FOUND",
        message: `คอลัมน์ "${col}" (ฟิลด์ ${field}) ไม่มีในตาราง "${mapping.sourceTable}" · mapped column not found`,
      };
    }
  }

  return {
    ok: true,
    schema: detail.detail.schema,
    columns: detail.detail.columns.map((c) => c.columnName),
  };
}

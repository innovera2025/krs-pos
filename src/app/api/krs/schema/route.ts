import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import {
  buildConnectionConfig,
  listKrsTablesWithConfig,
  getKrsTableDetailWithConfig,
  type KrsSampleRow,
} from "@/lib/krs/client";
import { KrsKeyError } from "@/lib/krs/crypto";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * GET /api/krs/schema (krs-sync schema browser, admin-only).
 *
 * Two shapes, selected by the optional `table` query param:
 *
 *  A) GET /api/krs/schema  → list EVERY base table in the live KRS DB (the real
 *     `db_ACC_SNP` has ~238) so the Live Data tab can render a searchable
 *     full-schema browser. READ-ONLY, parameter-free INFORMATION_SCHEMA query (no
 *     user input → no injection surface).
 *       - Not configured: `{ configured: false }`
 *       - Success: `{ configured: true, tables: KrsTableSummary[] }`
 *       - Configured but listing failed (driver fault, already logged sanitized):
 *         `{ configured: true, tables: null, error: "..." }`
 *
 *  B) GET /api/krs/schema?table=<name>  → that ONE table's columns + a capped
 *     sample (`SELECT TOP (50) *`). The `table` value is USER-SUPPLIED and is made
 *     injection-safe in the client (`getKrsTableDetail`): a PARAMETERIZED existence
 *     check against INFORMATION_SCHEMA.TABLES authorizes the name + resolves its
 *     real schema, and the sample identifier is built server-side with QUOTENAME via
 *     sp_executesql — the raw string is NEVER interpolated.
 *       - Not configured: 422 `{ configured: false, ... }`
 *       - Not a real base table: 404 `{ error: "..." }`
 *       - Empty/blank table param: 400 `{ error: "..." }`
 *       - Driver/query fault: 502 `{ error: "..." }`
 *       - Success: `{ configured: true, table: { schema, name, columns, sample } }`
 *
 * All responses are sanitized — the raw mssql/tedious error/config/password NEVER
 * crosses this boundary (it stays in `logger.error`, driver-key-stripped). A missing
 * server encryption key (KrsKeyError from decrypt) gets a distinct, non-sensitive
 * message so the admin knows it is a SERVER config fault, not a network fault.
 */
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    const url = new URL(req.url);
    const tableParam = url.searchParams.get("table");
    const wantDetail = tableParam !== null;

    // Validate the (user-supplied) table param BEFORE opening any connection.
    let tableName = "";
    if (wantDetail) {
      tableName = tableParam.trim();
      if (tableName.length === 0) {
        return NextResponse.json(
          { error: "ต้องระบุชื่อตาราง · table name required" },
          { status: 400 }
        );
      }
    }

    // Build the config ONCE. A null result classifies "not configured" (no saved
    // row / no stored password — it opens no connection); the same config is reused
    // for the list/detail query so we never re-read + re-decrypt the singleton.
    // Decrypting the stored password can throw KrsKeyError (server key missing) —
    // caught and reported distinctly below.
    let config;
    try {
      config = await buildConnectionConfig();
    } catch (err) {
      return keyOrInternal(err, wantDetail ? "schema?table detail" : "schema list");
    }

    if (config === null) {
      // Not configured. The detail shape uses 422 (the action needs a connection);
      // the list shape uses a clean `{ configured: false }` 200 so the UI can prompt
      // the admin to configure on the Connection tab.
      if (wantDetail) {
        return NextResponse.json(
          {
            configured: false,
            error: "ยังไม่ได้ตั้งค่าการเชื่อมต่อ KRS · KRS connection not configured",
          },
          { status: 422 }
        );
      }
      return NextResponse.json({ configured: false });
    }

    // ---- Shape B: single-table detail (user-supplied name → injection-safe) ----
    if (wantDetail) {
      const result = await getKrsTableDetailWithConfig(config, tableName);
      switch (result.status) {
        case "not-found":
          return NextResponse.json(
            { error: "ไม่พบตารางนี้ใน KRS · table not found" },
            { status: 404 }
          );
        case "error":
          // The client already logged a SANITIZED error. Generic boundary message.
          return NextResponse.json(
            { error: "อ่านตารางไม่สำเร็จ · could not read table" },
            { status: 502 }
          );
        case "ok":
          return NextResponse.json({
            configured: true,
            table: {
              schema: result.detail.schema,
              name: result.detail.name,
              columns: result.detail.columns,
              sample: result.detail.sample.map(serializeSampleRow),
            },
          });
      }
    }

    // ---- Shape A: list all base tables ----
    const tables = await listKrsTablesWithConfig(config);
    if (tables === null) {
      // Configured but the listing failed (driver fault — already logged sanitized).
      return NextResponse.json({
        configured: true,
        tables: null,
        error: "Schema read failed",
      });
    }
    return NextResponse.json({ configured: true, tables });
  });
}

/** Map a decrypt/config error to a clean response: a missing/invalid server
 *  encryption key gets a DISTINCT non-sensitive message (so the admin knows it is a
 *  server config fault, not a network fault); anything else is a generic 500. */
function keyOrInternal(err: unknown, where: string): NextResponse {
  if (err instanceof KrsKeyError) {
    logger.error({ err }, `${where}: KRS encryption key missing/invalid`);
    return NextResponse.json(
      {
        configured: true,
        tables: null,
        error:
          "ยังไม่ได้ตั้งค่า KRS_CONFIG_ENC_KEY บนเซิร์ฟเวอร์ · server encryption key missing",
      },
      { status: 500 }
    );
  }
  logger.error({ err }, `${where} failed`);
  return NextResponse.json(
    { configured: true, tables: null, error: "Schema read failed" },
    { status: 500 }
  );
}

/**
 * Serialize one mssql sample row into JSON-safe primitives for the browser. mssql
 * returns native JS types: Date → ISO string, Buffer/typed-array → a short
 * "<binary N bytes>" placeholder (never the raw bytes — binary columns are noise in
 * a preview and could be large), bigint → string, everything else passes through
 * (number/boolean/string/null). This is DISPLAY-ONLY data behind requireAdmin; we
 * still avoid dumping raw Buffers so the payload stays small and readable.
 */
function serializeSampleRow(row: KrsSampleRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = serializeCell(value);
  }
  return out;
}

function serializeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  if (value instanceof Uint8Array) return `<binary ${value.length} bytes>`;
  if (typeof value === "object") {
    // Defensive: any other object (e.g. a geography/JSON column) → JSON string so
    // it renders as text rather than "[object Object]".
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return value;
}

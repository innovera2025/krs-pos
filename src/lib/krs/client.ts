// NODE-ONLY. Opens the live MS SQL Server connection via the `mssql` driver. Do
// NOT import this from a client component, `src/auth.config.ts`, or
// `src/middleware.ts` — it is imported only by Node-runtime server code (the KRS
// API routes).
//
// The KRS client (krs-sync P1, P0 spec §6/§9) is STRICTLY SEPARATE from the POS
// Prisma datasource: it uses the `mssql` driver, NEVER enlists in a Prisma
// `$transaction`, and reads connection parameters out of the KrsConnectionSettings
// singleton (loaded via Prisma READ ONLY). The decrypted password lives in memory
// just long enough to build the mssql config and is NEVER logged or returned.
//
// SECRET HYGIENE (P0 spec §2.5 R5): on any driver error we construct a SANITIZED
// error object ({ host, port, database, user, code, message }) and log THAT — we
// NEVER pass the raw mssql/tedious error object or the connection config (which can
// embed the password under driver-specific keys the pino redact list misses) to
// the logger.

import sql from "mssql";
import { decrypt } from "./crypto";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

/** The KrsConnectionSettings singleton id (mirrors the ShopSettings pattern). */
const SINGLETON_ID = "singleton";

/** Pool sizing + timeouts (hardcoded in P1 per P0 spec §1.2 — not yet UI-tunable).
 *  POOL_MIN is 0: these are throwaway, per-call pools (open → query → close in a
 *  `finally`), so pre-opening idle connections to KRS serves no purpose and just
 *  holds an idle SQL Server session open between calls. */
const POOL_MIN = 0;
const POOL_MAX = 8;
const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** Sample-row cap for the table-detail browser. Hardcoded (not user-tunable) so the
 *  `SELECT TOP (N)` literal is always a constant integer, never user input. */
const SAMPLE_ROW_CAP = 50;

/** Plaintext connection parameters used to build a one-shot mssql config (the
 *  "test before save" override path) — the password is plaintext here because the
 *  caller (the test-connection route) holds it directly, never from the DB blob. */
export type KrsConnectionInput = {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
  /** When SSL/encrypt is ON, whether to trust a self-signed server cert (real
   *  on-prem KRS deployments commonly run a self-signed TLS cert). Moot when
   *  `ssl` is off — `toConfig` forces trust-on in that case. */
  trustServerCert: boolean;
};

/** The introspected shape of one KRS column (P0 spec §6.1 / §6.3). */
export type KrsColumn = {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
};

/** One row of the all-tables listing (krs-sync schema browser). `columns` is the
 *  column count for that base table (so the UI can show "238 tables" with a per-row
 *  column tally without a second query per table). */
export type KrsTableSummary = {
  schema: string;
  name: string;
  columns: number;
};

/** A single sample-row value. mssql returns native JS types (number/Date/Buffer/
 *  boolean/string/null); we keep them `unknown` and let the route serialize. */
export type KrsSampleRow = Record<string, unknown>;

/** The detail payload for one chosen table: its columns + a small sample. */
export type KrsTableDetail = {
  schema: string;
  name: string;
  columns: KrsColumn[];
  /** Up to 50 sample rows (`SELECT TOP (50) *`). */
  sample: KrsSampleRow[];
};

/** The result of a connection test (P0 spec §9.2). */
export type TestConnectionResult = {
  connected: boolean;
  latencyMs: number | null;
  error: string | null;
};

/** Build an `mssql` config from plaintext connection parameters. `ssl` maps to
 *  `options.encrypt` (the SSL/TLS toggle). `trustServerCertificate` is a SEPARATE
 *  knob: when encryption is ON we honor the admin's `trustServerCert` flag (true =
 *  accept a self-signed KRS cert, the on-prem-friendly default; false = require a
 *  CA-verifiable cert). When encryption is OFF the trust flag is moot, so we force
 *  it on (matching mssql's behavior for an unencrypted connection). */
function toConfig(input: KrsConnectionInput): sql.config {
  return {
    server: input.host,
    port: input.port,
    database: input.database,
    user: input.username,
    password: input.password,
    options: {
      encrypt: input.ssl,
      trustServerCertificate: input.ssl ? input.trustServerCert : true,
    },
    pool: { min: POOL_MIN, max: POOL_MAX },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: REQUEST_TIMEOUT_MS,
  };
}

/** Narrow an unknown thrown value to a safe `{ code, message }` for logging —
 *  driver-specific keys (which may embed the config/password) are dropped.
 *  Exported so sibling KRS modules (e.g. `products.ts`) reuse the SAME sanitization
 *  instead of re-deriving it (and risk logging the raw driver error/config). */
export function safeErrorParts(e: unknown): { code: string; message: string } {
  const code =
    typeof e === "object" && e !== null && "code" in e
      ? String((e as { code?: unknown }).code ?? "UNKNOWN")
      : "UNKNOWN";
  const message =
    e instanceof Error
      ? e.message
      : typeof e === "string"
        ? e
        : "Unknown error";
  return { code, message };
}

/**
 * Map a driver error (`code` + raw `message`) to a SMALL, SAFE allow-list message
 * for the API boundary (P0 spec §2.5 R5 / security F1). The raw mssql/tedious
 * `message` leaks host/instance/login details, so it is NEVER returned — only the
 * generic Thai+EN string below crosses the boundary. The full raw message stays
 * server-side in `logger.error` (sanitized of driver keys). Categories:
 *  - ELOGIN → auth failed (check username/password)
 *  - ETIMEOUT / ESOCKET / ECONNREFUSED → unreachable (host/port/timeout)
 *  - cert errors (ESELFSIGNEDCERT, or a message mentioning "self signed" /
 *    "certificate") → cert rejected, suggest enabling Trust self-signed cert
 *  - anything else → a generic "could not connect"
 */
function safeClientError(code: string, message: string): string {
  const lower = message.toLowerCase();
  if (code === "ELOGIN") {
    return "ตรวจสอบ username/password · auth failed";
  }
  if (code === "ETIMEOUT" || code === "ESOCKET" || code === "ECONNREFUSED") {
    return "เชื่อมต่อไม่ได้ (host/port/timeout)";
  }
  if (
    code === "ESELFSIGNEDCERT" ||
    lower.includes("self signed") ||
    lower.includes("self-signed") ||
    lower.includes("certificate")
  ) {
    return "ใบรับรองไม่ผ่าน — ลองเปิด Trust self-signed cert";
  }
  return "เชื่อมต่อไม่สำเร็จ";
}

/**
 * Load the KrsConnectionSettings singleton (Prisma READ ONLY) and build a live
 * `mssql` config, decrypting the stored password in memory. Returns `null` when
 * KRS is not configured (no row, or `encryptedPassword` is null) so callers can
 * report a clean "not configured" state instead of throwing.
 *
 * The decrypted password is NEVER logged or returned (it lives only inside the
 * returned `sql.config` consumed by the pool).
 */
export async function buildConnectionConfig(): Promise<sql.config | null> {
  const row = await prisma.krsConnectionSettings.findUnique({
    where: { id: SINGLETON_ID },
    select: {
      host: true,
      port: true,
      database: true,
      username: true,
      encryptedPassword: true,
      ssl: true,
      trustServerCert: true,
    },
  });

  if (!row || row.encryptedPassword === null) return null;

  const password = decrypt(row.encryptedPassword);
  return toConfig({
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    password,
    ssl: row.ssl,
    trustServerCert: row.trustServerCert,
  });
}

/**
 * Open a pool against the given config, run `SELECT 1`, measure round-trip
 * latency, and close the pool. Sanitized errors only. The pool is ALWAYS closed
 * in a `finally`, even on error.
 */
async function runTest(config: sql.config): Promise<TestConnectionResult> {
  const startedAt = Date.now();
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();
    await pool.request().query("SELECT 1");
    const latencyMs = Date.now() - startedAt;
    return { connected: true, latencyMs, error: null };
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
    // The FULL raw message stays server-side only (already sanitized of driver
    // keys above). Across the API boundary we return only the safe allow-list
    // string — the raw mssql/tedious message leaks host/instance/login (F1).
    logger.error({ krsErr: sanitized }, "KRS test-connection failed");
    return {
      connected: false,
      latencyMs: null,
      error: safeClientError(parts.code, parts.message),
    };
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        // Closing a pool that never fully opened can throw; the test result is
        // already determined, so swallow the close error.
      }
    }
  }
}

/**
 * Test the connection using the SAVED config (P0 spec §9.2). Returns a clean
 * "not configured" result (no throw) when KRS is not yet set up.
 */
export async function testConnection(): Promise<TestConnectionResult> {
  const config = await buildConnectionConfig();
  if (!config) {
    return { connected: false, latencyMs: null, error: "KRS connection not configured" };
  }
  return runTest(config);
}

/**
 * Test the connection using a one-shot override (the "test before save" UX). The
 * plaintext password comes from the validated request body, never the DB blob; it
 * is used only to build the config and is never logged or returned.
 */
export async function testConnectionWithInput(
  input: KrsConnectionInput
): Promise<TestConnectionResult> {
  return runTest(toConfig(input));
}

/** Build a sanitized `{host,port,database,user,code,message}` for logging from a
 *  config + thrown error — driver keys (which can embed the password) are dropped.
 *  Centralized so every KRS query path logs the SAME safe shape. */
function sanitizedKrsErr(config: sql.config, e: unknown) {
  const parts = safeErrorParts(e);
  return {
    host: config.server,
    port: config.port,
    database: config.database,
    user: config.user,
    code: parts.code,
    message: parts.message,
  };
}

/** Always-close pool helper: a close on a never-fully-opened pool can throw; the
 *  query result is already determined, so swallow it (mirrors runTest). */
async function closePoolQuietly(pool: sql.ConnectionPool | null): Promise<void> {
  if (!pool) return;
  try {
    await pool.close();
  } catch {
    // Swallow — the query result is already determined.
  }
}

/**
 * List EVERY base table in the KRS database (krs-sync schema browser) via
 * `INFORMATION_SCHEMA.TABLES` joined to a per-table column count from
 * `INFORMATION_SCHEMA.COLUMNS`. READ-ONLY, parameter-free, NO user input — there is
 * no injection surface here (the query is a fixed string). Returns ALL base tables
 * (the real `db_ACC_SNP` has ~238), ordered by name, so the UI can render a
 * searchable full-schema list. On a driver error logs a SANITIZED error and returns
 * `null`. The pool is always closed.
 */
async function listKrsTablesWithConfig(
  config: sql.config
): Promise<KrsTableSummary[] | null> {
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();
    const result = await pool.request().query<{
      TABLE_SCHEMA: string;
      TABLE_NAME: string;
      COLUMN_COUNT: number;
    }>(
      `SELECT
         t.TABLE_SCHEMA AS TABLE_SCHEMA,
         t.TABLE_NAME   AS TABLE_NAME,
         COUNT(c.COLUMN_NAME) AS COLUMN_COUNT
       FROM INFORMATION_SCHEMA.TABLES t
       LEFT JOIN INFORMATION_SCHEMA.COLUMNS c
         ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
        AND c.TABLE_NAME   = t.TABLE_NAME
       WHERE t.TABLE_TYPE = 'BASE TABLE'
       GROUP BY t.TABLE_SCHEMA, t.TABLE_NAME
       ORDER BY t.TABLE_NAME;`
    );
    return result.recordset.map((r) => ({
      schema: r.TABLE_SCHEMA,
      name: r.TABLE_NAME,
      columns: Number(r.COLUMN_COUNT ?? 0),
    }));
  } catch (e) {
    logger.error({ krsErr: sanitizedKrsErr(config, e) }, "KRS list-tables failed");
    return null;
  } finally {
    await closePoolQuietly(pool);
  }
}

/** Convenience wrapper: build the saved config then list all base tables. Returns
 *  `null` when KRS is not configured OR the listing failed (already logged). */
export async function listKrsTables(): Promise<KrsTableSummary[] | null> {
  const config = await buildConnectionConfig();
  if (!config) return null;
  return listKrsTablesWithConfig(config);
}

/**
 * The detail-fetch result is a small tagged union so the route can return a clean
 * 404 (table is not a real base table) vs 502 (driver/query failed) vs the payload.
 *  - `{ status: "ok", detail }` — found + read.
 *  - `{ status: "not-found" }` — `tableName` is NOT a real base table.
 *  - `{ status: "error" }` — a driver/query fault (already logged, sanitized).
 */
export type KrsTableDetailResult =
  | { status: "ok"; detail: KrsTableDetail }
  | { status: "not-found" }
  | { status: "error" };

/**
 * Read ONE chosen table's columns + a capped sample (`SELECT TOP (50) *`).
 *
 * SECURITY — this is the ONLY KRS path where the table name is USER-SUPPLIED, so it
 * is treated as untrusted and is NEVER raw-interpolated into SQL:
 *
 *  1. EXISTENCE CHECK (parameterized): we look the name up in
 *     `INFORMATION_SCHEMA.TABLES` via `request.input("t", sql.NVarChar, tableName)`
 *     + `WHERE TABLE_NAME = @t AND TABLE_TYPE = 'BASE TABLE'`. The user string only
 *     ever travels as a BOUND PARAMETER — it can never break out of the query. If no
 *     row comes back, we return `not-found` and touch nothing else. This both
 *     authorizes the name against the live table list AND resolves its REAL
 *     `TABLE_SCHEMA` (we do not trust any client-sent schema).
 *
 *  2. COLUMNS (parameterized): the columns query is also bound on `@t` (+ the
 *     resolved `@s` schema) — no interpolation.
 *
 *  3. SAMPLE rows: T-SQL cannot bind an IDENTIFIER (table name) as a parameter, so
 *     for `SELECT TOP (N) * FROM <table>` we build the identifier SERVER-SIDE with
 *     `QUOTENAME()` from the schema+name we just VALIDATED, and run it via
 *     `sp_executesql` whose @stmt is itself assembled inside SQL Server from
 *     `QUOTENAME(@s) + '.' + QUOTENAME(@t)`. The raw user string is bound to @s/@t
 *     as NVarChar and `QUOTENAME` escapes it into a safe bracketed identifier, so
 *     even a name containing `]` or `;` cannot escape. `TOP (50)` is a constant
 *     literal (SAMPLE_ROW_CAP), never user input.
 *
 * Sanitized errors only (never the raw mssql error/config/password). Pool always
 * closed.
 */
async function getKrsTableDetailWithConfig(
  config: sql.config,
  tableName: string
): Promise<KrsTableDetailResult> {
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();

    // (1) PARAMETERIZED existence check — authorize the user-supplied name against
    // the live base-table list AND resolve its real schema. The name is a BOUND
    // parameter; it can never break out of the query.
    const existence = await pool
      .request()
      .input("t", sql.NVarChar, tableName)
      .query<{ TABLE_SCHEMA: string; TABLE_NAME: string }>(
        `SELECT TABLE_SCHEMA, TABLE_NAME
         FROM INFORMATION_SCHEMA.TABLES
         WHERE TABLE_NAME = @t AND TABLE_TYPE = 'BASE TABLE';`
      );
    const found = existence.recordset[0];
    if (!found) {
      // Not a real base table — reject (never touch the table).
      return { status: "not-found" };
    }
    const schema = found.TABLE_SCHEMA;
    const name = found.TABLE_NAME;

    // (2) PARAMETERIZED columns query (bound on the resolved schema + name).
    const colsResult = await pool
      .request()
      .input("s", sql.NVarChar, schema)
      .input("t", sql.NVarChar, name)
      .query<{
        COLUMN_NAME: string;
        DATA_TYPE: string;
        CHARACTER_MAXIMUM_LENGTH: number | null;
        NUMERIC_PRECISION: number | null;
        NUMERIC_SCALE: number | null;
        IS_NULLABLE: string;
      }>(
        `SELECT COLUMN_NAME, DATA_TYPE,
                CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t
         ORDER BY ORDINAL_POSITION;`
      );
    const columns: KrsColumn[] = colsResult.recordset.map((r) => ({
      columnName: r.COLUMN_NAME,
      dataType: r.DATA_TYPE,
      isNullable: r.IS_NULLABLE === "YES",
      maxLength: r.CHARACTER_MAXIMUM_LENGTH,
      numericPrecision: r.NUMERIC_PRECISION,
      numericScale: r.NUMERIC_SCALE,
    }));

    // (3) SAMPLE rows. An identifier cannot be a SQL parameter, so we assemble the
    // statement INSIDE SQL Server with QUOTENAME (which bracket-escapes the
    // VALIDATED schema+name) and run it via sp_executesql. `TOP (N)` is a constant.
    // `@s`/`@t` are still bound NVarChar — QUOTENAME turns them into a safe
    // `[schema].[name]` identifier that cannot break out even if it contains `]`.
    const sampleResult = await pool
      .request()
      .input("s", sql.NVarChar, schema)
      .input("t", sql.NVarChar, name)
      .query<KrsSampleRow>(
        `DECLARE @stmt NVARCHAR(MAX) =
           N'SELECT TOP (${SAMPLE_ROW_CAP}) * FROM ' + QUOTENAME(@s) + N'.' + QUOTENAME(@t) + N';';
         EXEC sp_executesql @stmt;`
      );
    const sample: KrsSampleRow[] = sampleResult.recordset ?? [];

    return { status: "ok", detail: { schema, name, columns, sample } };
  } catch (e) {
    logger.error({ krsErr: sanitizedKrsErr(config, e) }, "KRS table-detail failed");
    return { status: "error" };
  } finally {
    await closePoolQuietly(pool);
  }
}

/** Convenience wrapper: build the saved config then read one table's detail.
 *  Returns `not-configured` when KRS is not set up (no row / no stored password) so
 *  the route can distinguish that from a not-found table or a driver error. */
export async function getKrsTableDetail(
  tableName: string
): Promise<KrsTableDetailResult | { status: "not-configured" }> {
  const config = await buildConnectionConfig();
  if (!config) return { status: "not-configured" };
  return getKrsTableDetailWithConfig(config, tableName);
}

export { listKrsTablesWithConfig, getKrsTableDetailWithConfig };

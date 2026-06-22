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

/**
 * Fixed allow-list of KRS tables to introspect (P0 spec §6.2/§6.3). Hardcoded —
 * NEVER user-supplied — so the INFORMATION_SCHEMA query has no injection surface.
 */
const INTROSPECT_TABLES = [
  "sales",
  "sale_items",
  "stock_movements",
  "products",
  "price_list",
  "stock_balance",
  "customers",
] as const;

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
 *  driver-specific keys (which may embed the config/password) are dropped. */
function safeErrorParts(e: unknown): { code: string; message: string } {
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

/**
 * Introspect the KRS schema via `INFORMATION_SCHEMA.COLUMNS` over the fixed table
 * allow-list (P0 spec §6.3 — parameter-free, no injection surface) using a config
 * the CALLER already built. Groups the rows by table name. On a driver error logs a
 * SANITIZED error and returns `null`. The pool is always closed.
 *
 * The schema route holds an already-built config (to classify "not configured" vs
 * "configured but unreachable"), so it calls THIS variant to avoid a redundant
 * second Prisma read + password decrypt (code-review M2). `introspectSchema()`
 * below is the convenience wrapper that builds the config then delegates here.
 */
async function introspectSchemaWithConfig(
  config: sql.config
): Promise<Record<string, KrsColumn[]> | null> {
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();
    const tableList = INTROSPECT_TABLES.map((t) => `'${t}'`).join(",");
    const result = await pool.request().query<{
      TABLE_NAME: string;
      COLUMN_NAME: string;
      DATA_TYPE: string;
      CHARACTER_MAXIMUM_LENGTH: number | null;
      NUMERIC_PRECISION: number | null;
      NUMERIC_SCALE: number | null;
      IS_NULLABLE: string;
    }>(
      `SELECT
         TABLE_NAME, COLUMN_NAME, DATA_TYPE,
         CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_NAME IN (${tableList})
       ORDER BY TABLE_NAME, ORDINAL_POSITION;`
    );

    const tables: Record<string, KrsColumn[]> = {};
    for (const r of result.recordset) {
      const col: KrsColumn = {
        columnName: r.COLUMN_NAME,
        dataType: r.DATA_TYPE,
        isNullable: r.IS_NULLABLE === "YES",
        maxLength: r.CHARACTER_MAXIMUM_LENGTH,
        numericPrecision: r.NUMERIC_PRECISION,
        numericScale: r.NUMERIC_SCALE,
      };
      (tables[r.TABLE_NAME] ??= []).push(col);
    }
    return tables;
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
    logger.error({ krsErr: sanitized }, "KRS schema introspection failed");
    return null;
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        // See runTest: swallow a close error after the work is done.
      }
    }
  }
}

/**
 * Convenience wrapper: build the live config from the saved singleton then
 * introspect. Returns `null` when KRS is not configured OR introspection fails
 * (the latter already logged a sanitized error). The schema route prefers
 * `buildConnectionConfig()` + `introspectSchemaWithConfig()` so it can classify the
 * two cases AND avoid a double Prisma read/decrypt; other callers can use this.
 */
export async function introspectSchema(): Promise<Record<string, KrsColumn[]> | null> {
  const config = await buildConnectionConfig();
  if (!config) return null;
  return introspectSchemaWithConfig(config);
}

export { introspectSchemaWithConfig };

import { z } from "zod";

/**
 * KRS connection settings request schema (NODE-ONLY — do NOT import from a client
 * component, `src/auth.config.ts`, or `src/middleware.ts`; it is imported only by
 * the Node-runtime KRS route handlers).
 *
 * Validates the PATCH /api/krs/settings body SHAPE + BOUNDS at the parse boundary
 * (via `parseBody`), returning the standard `{ error, code: "VALIDATION", issues }`
 * contract. The bounds below are the SSRF / connection-string-injection floor from
 * P0 spec §1.2.1 — every field feeds the `mssql` ConnectionPool, so an unbounded /
 * metachar-laden value is the attack surface:
 *
 *   - host     : ≤253 chars, hostname / IPv4 / IPv6 charset only (rejects
 *                whitespace, control chars, `@` `/` `\` and other smuggling chars).
 *   - port     : int 1–65535.
 *   - database : ≤128 chars, conservative charset (alnum + `_ - .`).
 *   - username : ≤128 chars, same conservative charset.
 *   - password : 1–256 chars, OPTIONAL on PATCH (omit = keep the existing
 *                password). Write-only; never returned (§2.5). Messages MUST NOT
 *                interpolate the value (path+message only, per the `conciseIssues`
 *                contract in `_shared.ts`) so cleartext can never leak via an issue.
 *   - ssl      : boolean (maps to mssql options.encrypt).
 *   - engine   : fixed literal "SQLSERVER" (read-only in the UI; server rejects else).
 *   - syncMode : enum realtime | daily | manual.
 *
 * SSRF stance (P0 spec §1.2.1): NO private-IP / metadata-IP denylist — KRS is a
 * deliberately admin-configured outbound target that may legitimately be an on-prem
 * / RFC1918 address. The compensating controls are requireAdmin on every route, the
 * bounded charset here, and a KRS_SETTINGS_CHANGED audit on host/port change.
 */

/** Hostname / IPv4 / IPv6 charset. Allows alphanumerics, dots, hyphens, and the
 *  `[` `]` `:` used in bracketed IPv6 literals; rejects whitespace, control chars,
 *  `@` `/` `\` — anything that could smuggle into the mssql connection string. */
const HOST_RE = /^[a-zA-Z0-9.\-[\]:]+$/;

/** Conservative SQL Server identifier charset (database / username). */
const IDENT_RE = /^[a-zA-Z0-9_.\-]+$/;

const HOST_MAX = 253;
const IDENT_MAX = 128;
const PASSWORD_MAX = 256;

export const KrsSettingsPatchBodySchema = z.object({
  host: z
    .string()
    .min(1, "ต้องระบุ Host")
    .max(HOST_MAX, `Host ต้องไม่เกิน ${HOST_MAX} ตัวอักษร`)
    .regex(HOST_RE, "Host มีอักขระที่ไม่อนุญาต"),
  port: z
    .number()
    .int("Port ต้องเป็นจำนวนเต็ม")
    .min(1, "Port ต้องอยู่ระหว่าง 1–65535")
    .max(65535, "Port ต้องอยู่ระหว่าง 1–65535"),
  database: z
    .string()
    .min(1, "ต้องระบุ Database")
    .max(IDENT_MAX, `Database ต้องไม่เกิน ${IDENT_MAX} ตัวอักษร`)
    .regex(IDENT_RE, "Database มีอักขระที่ไม่อนุญาต"),
  username: z
    .string()
    .min(1, "ต้องระบุ Username")
    .max(IDENT_MAX, `Username ต้องไม่เกิน ${IDENT_MAX} ตัวอักษร`)
    .regex(IDENT_RE, "Username มีอักขระที่ไม่อนุญาต"),
  // Optional: omit to keep the existing stored password. Messages are
  // value-free (no `.refine` embedding cleartext) so the password never leaks
  // through a VALIDATION issue.
  password: z
    .string()
    .min(1, "รหัสผ่านต้องไม่ว่าง")
    .max(PASSWORD_MAX, `รหัสผ่านต้องไม่เกิน ${PASSWORD_MAX} ตัวอักษร`)
    .optional(),
  ssl: z.boolean(),
  // Trust a self-signed KRS cert when SSL/encrypt is on (on-prem-friendly). Moot
  // when ssl is false — the client forces trust-on for an unencrypted connection.
  trustServerCert: z.boolean(),
  engine: z.literal("SQLSERVER"),
  syncMode: z.enum(["realtime", "daily", "manual"]),
});

export type KrsSettingsPatchBody = z.infer<typeof KrsSettingsPatchBodySchema>;

/**
 * Test-connection override body (the "test before save" UX). Reuses the same
 * bounded host/port/database/username/ssl rules; the password here is REQUIRED
 * (a test needs a credential) and plaintext (held only in the request, never the
 * DB blob). The route never logs or echoes it.
 */
export const KrsTestConnectionBodySchema = z.object({
  host: z
    .string()
    .min(1, "ต้องระบุ Host")
    .max(HOST_MAX, `Host ต้องไม่เกิน ${HOST_MAX} ตัวอักษร`)
    .regex(HOST_RE, "Host มีอักขระที่ไม่อนุญาต"),
  port: z
    .number()
    .int("Port ต้องเป็นจำนวนเต็ม")
    .min(1, "Port ต้องอยู่ระหว่าง 1–65535")
    .max(65535, "Port ต้องอยู่ระหว่าง 1–65535"),
  database: z
    .string()
    .min(1, "ต้องระบุ Database")
    .max(IDENT_MAX, `Database ต้องไม่เกิน ${IDENT_MAX} ตัวอักษร`)
    .regex(IDENT_RE, "Database มีอักขระที่ไม่อนุญาต"),
  username: z
    .string()
    .min(1, "ต้องระบุ Username")
    .max(IDENT_MAX, `Username ต้องไม่เกิน ${IDENT_MAX} ตัวอักษร`)
    .regex(IDENT_RE, "Username มีอักขระที่ไม่อนุญาต"),
  password: z
    .string()
    .min(1, "รหัสผ่านต้องไม่ว่าง")
    .max(PASSWORD_MAX, `รหัสผ่านต้องไม่เกิน ${PASSWORD_MAX} ตัวอักษร`),
  ssl: z.boolean(),
  // See the PATCH schema: trust a self-signed cert when SSL is on (moot when off).
  trustServerCert: z.boolean(),
});

export type KrsTestConnectionBody = z.infer<typeof KrsTestConnectionBodySchema>;

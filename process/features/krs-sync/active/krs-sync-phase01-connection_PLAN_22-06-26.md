# KRS Sync — Phase 1: Connection Layer + Functional Connection Screen

- Feature: krs-sync
- Phase: P1 of 5 (P0–P4)
- Date: 2026-06-22
- Complexity: COMPLEX (part of phase program)
- Status: READY TO EXECUTE — P0 spec approved, owner approved P1 start
- Umbrella plan: `process/features/krs-sync/active/krs-sync-program_PLAN_22-06-26.md`
- Spec authority: `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md`
- P0 report: `process/features/krs-sync/reports/krs-sync-phase00-contracts_REPORT_22-06-26.md`
- Report destination (this phase): `process/features/krs-sync/reports/krs-sync-phase01-connection_REPORT_22-06-26.md`

---

## Phase Goal

Install the `mssql` driver (orchestrator-owned); add the `KrsConnectionSettings` Prisma singleton
model (execute-agent adds the model, orchestrator runs the migration); build the AES-256-GCM crypto
util, pooled KRS client, three admin-only API routes (`settings`, `test-connection`, `schema`), and
make the `/data` Connection tab fully functional — persisted settings, real Test Connection with
latency, password field, Save action, SQL Server defaults.

**P1/P2 boundary:** P1 ships the `/api/krs/schema` introspection endpoint but does NOT consume its
output in the Field Mapping UI. Consuming it in `MappingTab.tsx` is P2/P3 scope. The KRS outbox
(`SyncJob` extension fields), dispatcher, and all checkout/orders/stock-movements wiring are P2.

---

## Spec References

All contracts implemented here are pinned in the P0 spec. This plan implements; it does not
re-derive the contract. Section numbers below refer to
`process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md`.

| Contract | Spec section |
|---|---|
| `KrsConnectionSettings` model + singleton pattern | §1 |
| Field types, nullable `encryptedPassword`, `engine`/`syncMode` as plain String | §1.2 |
| Zod SSRF/injection bounds (host/database/username/port/password/ssl/engine/syncMode) | §1.2.1 |
| AES-256-GCM encrypt — random IV per write, fixed AAD, `v1` version prefix | §2.3 |
| AES-256-GCM decrypt — split on `:`, assert 4 parts, assert `v1`, hex/length regex, setAAD | §2.4 |
| Password masking rule — `passwordSet` boolean in ALL responses, never the blob | §2.5 |
| Sanitized error logging — never raw driver error/config to logger | §2.5 R5 |
| `KRS_CONFIG_ENC_KEY` env var — lazy/callsite fail-fast, NOT a boot requirement | §2.1, §3.3 |
| `.env.example` placeholder (no real value) | §3.1 |
| SSRF stance — no private-IP denylist, compensating controls: `requireAdmin` + bounded charset + host-change audit | §1.2.1 |
| `KRS_SETTINGS_CHANGED` audit on host (and port) change | §1.2.1 |
| `introspectSchema()` — `INFORMATION_SCHEMA.COLUMNS`, fixed allow-list of 7 tables | §6 |
| `testConnection()` — open + SELECT 1 + latency | §9.2 |
| `mssql` v11 | §9.1 |
| P1 runtime verification gates | §10 P1 block |

---

## Touchpoints

### New files (execute-agent creates)

| File | What it does |
|---|---|
| `src/lib/krs/crypto.ts` | AES-256-GCM encrypt/decrypt; lazy key validation |
| `src/lib/krs/client.ts` | Pooled `mssql` `ConnectionPool`; `testConnection()`; `introspectSchema()` |
| `src/lib/krs/index.ts` | Public exports from `src/lib/krs/` |
| `src/lib/schemas/krsSettings.ts` | Zod PATCH-body schema with SSRF/injection bounds (§1.2.1) |
| `src/app/api/krs/settings/route.ts` | GET (masked) + PATCH (encrypted write) — `requireAdmin` |
| `src/app/api/krs/test-connection/route.ts` | POST — opens real mssql; returns `{connected, latencyMs, error}` |
| `src/app/api/krs/schema/route.ts` | GET — `INFORMATION_SCHEMA.COLUMNS` introspection |

### Edited files (execute-agent edits)

| File | Change |
|---|---|
| `prisma/schema.prisma` | Add `KrsConnectionSettings` model + `AuditAction.KRS_SETTINGS_CHANGED` enum value |
| `src/lib/env.ts` | Add optional shape-check for `KRS_CONFIG_ENC_KEY` (NOT a fail-fast boot requirement) |
| `.env.example` | Add `KRS_CONFIG_ENC_KEY=` placeholder + generation hint comment |
| `src/types/index.ts` | Add `KrsConnectionSettingsDTO` type |
| `src/components/data/connectionTypes.ts` | Flip defaults: engine → `"SQL Server"`, port → `"1433"`, host placeholder → SQL Server hint, connection string scheme → `sqlserver://` |
| `src/components/data/ConnectionTab.tsx` | Full rewrite to functional: load config on mount, add password input, Save → PATCH, real Test Connection → POST, show real status/latency |

### Orchestrator-owned (NOT execute-agent scope)

| Action | When |
|---|---|
| `npm install mssql@^11` | Before execute-agent begins |
| `npx prisma migrate dev --name krs_connection_settings` | After execute-agent adds the model to `schema.prisma` |
| `npm run type-check` | After execute-agent declares CODE DONE |
| `npm run build` (isolated worktree) | After type-check passes |
| Docker SQL Server smoke tests | After build passes |
| Real KRS instance verification | Final gate before P1 VERIFIED |

---

## Public Contracts

### API surface (admin-only — all require `requireAdmin`, all inside `runWithRequestId`)

**`GET /api/krs/settings`**

Success 200:
```
{
  settings: {
    host: string,
    port: number,
    database: string,
    username: string,
    passwordSet: boolean,   // true when encryptedPassword is non-null
    ssl: boolean,
    engine: "SQLSERVER",
    syncMode: "realtime" | "daily" | "manual"
  }
}
```
When no row exists: `{ settings: null }` (or upsert-on-read with empty defaults — see step 17).

**`PATCH /api/krs/settings`**

Request body (Zod-validated via `parseBody(KrsSettingsPatchBodySchema, raw)`):
```
{
  host: string,          // ≤253 chars, hostname/IPv4/IPv6 charset
  port: number,          // 1–65535
  database: string,      // ≤128 chars, conservative charset
  username: string,      // ≤128 chars, conservative charset
  password?: string,     // 1–256 chars (optional: omit = keep existing)
  ssl: boolean,
  engine: "SQLSERVER",
  syncMode: "realtime" | "daily" | "manual"
}
```
Success 200: same `{ settings: { ..., passwordSet: boolean } }` as GET. NEVER echoes password blob.

Validation failure: `{ error, code: "VALIDATION", issues }` (via `parseBody`).

**`POST /api/krs/test-connection`**

Request body: `{}` (uses saved config from DB) OR optional `{ host, port, database, username, password, ssl }` override for "test before save" UX.

Success 200: `{ connected: boolean, latencyMs: number | null, error: string | null }`

On no config: `{ connected: false, latencyMs: null, error: "KRS connection not configured" }` (no throw).

Error string is SANITIZED (never raw mssql/tedious message or config values).

**`GET /api/krs/schema`**

Success 200: `{ configured: true, tables: { [tableName]: Array<{ columnName, dataType, isNullable, maxLength, numericPrecision, numericScale }> } }`

When no config: `{ configured: false }` (200, no throw).

### Type additions (`src/types/index.ts`)

`KrsConnectionSettingsDTO` — mirrors the GET response `settings` object shape above.

### Prisma model (`prisma/schema.prisma`)

Exact model text (per §1.1 spec):

```
model KrsConnectionSettings {
  id                String   @id @default("singleton")
  host              String
  port              Int      @default(1433)
  database          String
  username          String
  encryptedPassword String?
  ssl               Boolean  @default(true)
  engine            String   @default("SQLSERVER")
  syncMode          String   @default("realtime")
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}
```

New `AuditAction` enum value added to `prisma/schema.prisma`:
```
KRS_SETTINGS_CHANGED
```
(appended to the existing `AuditAction` enum; additive — no existing value altered.)

### Env var (`src/lib/env.ts`)

`KRS_CONFIG_ENC_KEY` added as `.optional()` in `EnvSchema` (no fail-fast at boot). The fail-fast
lives in `src/lib/krs/crypto.ts` at the encrypt/decrypt callsite (§2.1 / §3.3). The build-phase
bypass block in `loadEnv()` must pass through `KRS_CONFIG_ENC_KEY: process.env.KRS_CONFIG_ENC_KEY`.

---

## Blast Radius

**P1 does NOT touch the checkout/orders path.** `src/app/api/orders/route.ts` — the highest-risk
file in the repo (per umbrella plan) — is untouched in P1. Its risk appears in P2.

**P1-specific blast:**

| File | Risk | Mitigation |
|---|---|---|
| `prisma/schema.prisma` | New model + new enum value | Additive only; no existing table altered; no seed data affected. Migration name: `krs_connection_settings`. |
| `src/lib/krs/crypto.ts` | High — wrong IV handling or AAD omission corrupts stored passwords | Explicit test in verification: round-trip encrypt→decrypt + AAD-mismatch fails closed. DB inspection confirms ciphertext blob format. |
| `src/app/api/krs/settings/route.ts` | Medium — password masking bug exposes secret | Code-review gate: PATCH response body must have zero `password`/`encryptedPassword` keys; GET Prisma `select` explicitly omits `encryptedPassword`. |
| `src/components/data/ConnectionTab.tsx` | Low-medium — UI-only; no financial data | State management for password field must clear on successful save; form must not cache plaintext. |
| `src/lib/env.ts` | Low | Only adding an optional field; existing boot validation unchanged. |

**No P2/P3/P4 files are modified in P1.** `SyncJob`, `src/app/api/sync-jobs/`, `MappingTab.tsx`
(field mapping UI), `src/app/api/orders/route.ts`, and `src/app/api/stock-movements/route.ts` are
all out of scope.

---

## Implementation Checklist (Ordered — Foundation → Client → API → UI)

Steps marked `[CODE]` are execute-agent scope.
Steps marked `[ORCH]` are orchestrator scope (run outside execute-agent).

### Foundation: Schema + Env

1. `[ORCH]` Confirm `mssql@^11` is installed: `npm install mssql@^11` — record resolved version. If lockfile already has it, skip.

2. `[CODE]` Edit `prisma/schema.prisma`:
   - Append `KrsConnectionSettings` model exactly as specified in §1.1 (copy the model text from the "Public Contracts" section above).
   - Append `KRS_SETTINGS_CHANGED` to the `AuditAction` enum (after `SESSION_REVOKED`).
   - Keep all existing models/enums untouched — additive only.

3. `[ORCH]` Run `npx prisma migrate dev --name krs_connection_settings` against the dev Postgres instance.

4. `[CODE]` Edit `src/lib/env.ts`:
   - In `EnvSchema` object, after `SELLER_BRANCH_LABEL`, add:
     ```
     KRS_CONFIG_ENC_KEY: z.string().optional(),
     ```
   - In the build-phase bypass block (`NEXT_PHASE === "phase-production-build"`), add:
     ```
     KRS_CONFIG_ENC_KEY: process.env.KRS_CONFIG_ENC_KEY,
     ```
   - Do NOT make it a boot-time requirement (§2.1, §3.3) — optional only.

5. `[CODE]` Edit `.env.example` — append after the seller-identity block:
   ```
   # =============================================================================
   # KRS Sync — AES-256-GCM encryption key for KrsConnectionSettings.encryptedPassword
   # =============================================================================
   # Must decode to exactly 32 bytes. Generate with: openssl rand -base64 32
   # git-ignored .env only; NEVER commit a real value.
   KRS_CONFIG_ENC_KEY=
   ```

### Library Layer: `src/lib/krs/`

6. `[CODE]` Create `src/lib/krs/crypto.ts`:
   - Export `encrypt(plaintext: string): string` and `decrypt(blob: string): string`.
   - `encrypt`:
     - Read `process.env.KRS_CONFIG_ENC_KEY`. If absent/empty → throw: `"KRS_CONFIG_ENC_KEY is required to encrypt/decrypt the KRS connection password. Generate one with: openssl rand -base64 32"`.
     - `Buffer.from(key, "base64")` → assert `keyBuf.length === 32`; if not → throw: `"KRS_CONFIG_ENC_KEY must decode to exactly 32 bytes (AES-256). Got N bytes."`.
     - `crypto.randomBytes(12)` for IV.
     - `createCipheriv("aes-256-gcm", keyBuf, iv)`.
     - `cipher.setAAD(Buffer.from("krs.connection.password.v1"))` — BEFORE `update`.
     - `update(plaintext, "utf8") + final()` → ciphertext.
     - `cipher.getAuthTag()` → 16-byte authTag.
     - Return `"v1:" + iv.toString("hex") + ":" + authTag.toString("hex") + ":" + ciphertext.toString("hex")`.
   - `decrypt`:
     - Same key load/length-assert as encrypt (fail-fast).
     - `split(":")` → assert exactly 4 non-empty parts `[version, ivHex, authTagHex, ciphertextHex]`; if not → throw `"corrupt ciphertext: expected v1:ivHex:authTagHex:ciphertextHex"`.
     - Assert `version === "v1"`; if not → throw `"unknown ciphertext version: " + version`.
     - Regex-validate: `ivHex` must match `/^[0-9a-f]{24}$/`, `authTagHex` must match `/^[0-9a-f]{32}$/`, `ciphertextHex` must match `/^[0-9a-f]+$/` and `ciphertextHex.length % 2 === 0`. If any fail → throw `"corrupt ciphertext: malformed hex segment"`.
     - `createDecipheriv("aes-256-gcm", keyBuf, Buffer.from(ivHex, "hex"))`.
     - `decipher.setAAD(Buffer.from("krs.connection.password.v1"))`.
     - `decipher.setAuthTag(Buffer.from(authTagHex, "hex"))`.
     - `update(Buffer.from(ciphertextHex, "hex")) + final()` → return as `"utf8"` string.
     - The GCM `final()` throws on auth-tag mismatch (wrong key, wrong AAD, tampered) — let it propagate.
   - Import: `import { createCipheriv, createDecipheriv, randomBytes } from "crypto"`. Node built-in — no npm dep.
   - NODE-ONLY — add a `// NODE-ONLY` warning comment at the top; do NOT export from a client component.

7. `[CODE]` Create `src/lib/krs/client.ts`:
   - Import: `import sql from "mssql"`. Do NOT import `src/lib/prisma.ts` anywhere in this file.
   - Import `{ decrypt }` from `"./crypto"`.
   - Import `{ prisma }` from `"@/lib/prisma"` for loading `KrsConnectionSettings` only.
   - Import `{ logger }` from `"@/lib/logger"`.
   - Pool constants: `const POOL_MIN = 2; const POOL_MAX = 8; const CONNECT_TIMEOUT_MS = 10_000; const REQUEST_TIMEOUT_MS = 15_000;`
   - Export `async function buildConnectionConfig(): Promise<sql.config | null>`:
     - Loads `KrsConnectionSettings` singleton from Postgres via `prisma.krsConnectionSettings.findUnique({ where: { id: "singleton" }, select: { host: true, port: true, database: true, username: true, encryptedPassword: true, ssl: true } })`.
     - If no row or `encryptedPassword` is null → return `null`.
     - `decrypt(row.encryptedPassword)` → password in memory.
     - Return `sql.config` object: `{ server: row.host, port: row.port, database: row.database, user: row.username, password: decryptedPassword, options: { encrypt: row.ssl, trustServerCertificate: !row.ssl }, pool: { min: POOL_MIN, max: POOL_MAX }, connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS }`.
     - The decrypted password must NOT be logged or returned.
   - Export `async function testConnection(): Promise<{ connected: boolean; latencyMs: number | null; error: string | null }>`:
     - Calls `buildConnectionConfig()`. If null → return `{ connected: false, latencyMs: null, error: "KRS connection not configured" }`.
     - Opens a `new sql.ConnectionPool(config)`, `await pool.connect()`, runs `await pool.request().query("SELECT 1")`, measures latency with `Date.now()`, closes pool.
     - On success: `{ connected: true, latencyMs: <elapsed>, error: null }`.
     - On error: construct a SANITIZED error object `{ host: config.server, port: config.port, database: config.database, user: config.user, code: (e as { code?: string }).code ?? "UNKNOWN", message: <safe message> }`. Log ONLY the sanitized object: `logger.error({ krsErr: sanitized }, "KRS test-connection failed")`. Return `{ connected: false, latencyMs: null, error: "Connection failed: " + sanitized.message }`. NEVER pass the raw `mssql` error or config to the logger.
     - Always `try/finally` close the pool even on error.
   - Export `async function introspectSchema(): Promise<Record<string, Array<{ columnName: string; dataType: string; isNullable: boolean; maxLength: number | null; numericPrecision: number | null; numericScale: number | null }>> | null>`:
     - Calls `buildConnectionConfig()`. If null → return `null`.
     - Opens pool, runs the fixed `INFORMATION_SCHEMA.COLUMNS` query from §6.3 (hardcoded table allow-list: `'sales','sale_items','stock_movements','products','price_list','stock_balance','customers'` — no user-supplied SQL).
     - Groups rows by `TABLE_NAME` into the return map.
     - Closes pool. Returns the map.
     - On error: sanitized log (same pattern as `testConnection`); return `null`.
   - NODE-ONLY comment at top.

8. `[CODE]` Create `src/lib/krs/index.ts`:
   - Re-export `{ buildConnectionConfig, testConnection, introspectSchema }` from `"./client"`.
   - Re-export `{ encrypt, decrypt }` from `"./crypto"`.

### Schema: Zod Body Schema

9. `[CODE]` Create `src/lib/schemas/krsSettings.ts`:
   - NODE-ONLY warning comment at top (mirrors `shopSettings.ts`).
   - Import `{ z }` from `"zod"`.
   - Define `KrsSettingsPatchBodySchema` using these exact bounds (§1.2.1):
     - `host`: `z.string().min(1).max(253)` + `.regex(/^[a-zA-Z0-9.\-\[\]:]+$/, "host contains invalid characters")` — rejects whitespace, control chars, `@`, `/`, `\`.
     - `port`: `z.number().int().min(1).max(65535)`.
     - `database`: `z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.\-]+$/, "database name contains invalid characters")`.
     - `username`: `z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.\-]+$/, "username contains invalid characters")`.
     - `password`: `z.string().min(1).max(256).optional()` — optional so the client can omit it to keep the existing password.
     - `ssl`: `z.boolean()`.
     - `engine`: `z.literal("SQLSERVER")`.
     - `syncMode`: `z.enum(["realtime", "daily", "manual"])`.
   - Export `type KrsSettingsPatchBody = z.infer<typeof KrsSettingsPatchBodySchema>`.
   - NOTE: Zod `.message()` on the password field must NOT interpolate the value — path+message only (matching the `conciseIssues` contract in `_shared.ts`).

### Types

10. `[CODE]` Edit `src/types/index.ts` — add after `ShopSettingsDTO`:
    ```typescript
    /**
     * KRS connection settings as returned by GET /api/krs/settings.
     * `passwordSet` is true when an encrypted password is stored; the plaintext
     * and the ciphertext are never returned.
     */
    export type KrsConnectionSettingsDTO = {
      host: string;
      port: number;
      database: string;
      username: string;
      passwordSet: boolean;
      ssl: boolean;
      engine: string;
      syncMode: string;
    };
    ```

### API Routes

11. `[CODE]` Create `src/app/api/krs/settings/route.ts`:
    - Follow the exact pattern of `src/app/api/settings/route.ts`: `runWithRequestId`, `requireAdmin`, `logger`, `parseBody`, Prisma upsert, typed `select`.
    - `const SINGLETON_ID = "singleton";`
    - `const KRS_SETTINGS_SELECT = { host: true, port: true, database: true, username: true, encryptedPassword: true, ssl: true, engine: true, syncMode: true } as const;` — includes `encryptedPassword` for internal use only.
    - `GET`: `requireAdmin`; `prisma.krsConnectionSettings.findUnique({ where: { id: SINGLETON_ID }, select: KRS_SETTINGS_SELECT })`. Build response: `{ settings: row ? { ...row (without encryptedPassword), passwordSet: row.encryptedPassword !== null } : null }`. The `encryptedPassword` key MUST NOT appear in the JSON response.
    - `PATCH`: `requireAdmin`; parse body with `parseBody(KrsSettingsPatchBodySchema, raw)`. If `password` is provided in the body, `encrypt(password)` → `encryptedPassword` (fail-fast if `KRS_CONFIG_ENC_KEY` is absent). Build `updateData` and `createData` objects. If host or port differs from the existing row, call `logAudit({ action: "KRS_SETTINGS_CHANGED", detail: JSON.stringify({ newHost: data.host, newPort: data.port }) })` best-effort AFTER the upsert (same pattern as other best-effort audit writes). Upsert with `prisma.krsConnectionSettings.upsert(...)`. Response uses the same `passwordSet`-only projection — never echoes the submitted plaintext or the stored blob.
    - On any Prisma/crypto error: `logger.error({ err }, "PATCH /api/krs/settings failed")` (the `err` key is fine here because it will NOT contain the password — the error is from crypto/DB, not from the request body).
    - Import `logAudit` from wherever it lives in the repo (check `src/lib/auditLog.ts`).

12. `[CODE]` Create `src/app/api/krs/test-connection/route.ts`:
    - `POST` handler only.
    - `requireAdmin`; `runWithRequestId`.
    - Parse optional body: `{ host?, port?, database?, username?, password?, ssl? }` — if provided, build a one-shot config override instead of loading from DB. Validate the override fields with the same Zod bounds as the PATCH schema (reuse `KrsSettingsPatchBodySchema` subset or define a partial Zod schema).
    - If body is empty `{}` or absent: call `testConnection()` from `src/lib/krs/client.ts`.
    - If override body is present: decrypt is not applicable (plaintext password is in the body); build the `sql.config` directly and run the test inline (or pass config override into a `testConnectionWithConfig(config)` variant if preferred — the execute-agent can choose the cleanest approach as long as the plaintext password is never logged and the response never echoes it).
    - Return `NextResponse.json({ connected, latencyMs, error })`.
    - NEVER log the password in either code path.

13. `[CODE]` Create `src/app/api/krs/schema/route.ts`:
    - `GET` handler only.
    - `requireAdmin`; `runWithRequestId`.
    - Call `introspectSchema()` from `src/lib/krs/client.ts`.
    - If `null` (no config): return `NextResponse.json({ configured: false })`.
    - Otherwise: return `NextResponse.json({ configured: true, tables })`.
    - On error from `introspectSchema`: return `{ configured: true, tables: null, error: "Schema introspection failed" }` (sanitized — no raw driver message).

### UI Layer

14. `[CODE]` Edit `src/components/data/connectionTypes.ts`:
    - Change `INITIAL_DB_STATE.engine` → `"SQL Server"` (display string for the read-only Engine field; the DB stores `"SQLSERVER"`).
    - Change `INITIAL_DB_STATE.port` → `"1433"`.
    - Change `INITIAL_DB_STATE.host` → `""` (empty; will be loaded from DB on mount).
    - Change `INITIAL_DB_STATE.name` → `""` (empty initial).
    - Change `INITIAL_DB_STATE.user` → `""` (empty initial).
    - `INITIAL_DB_STATE.status` → `"disconnected"` (unknown until first test).
    - `INITIAL_DB_STATE.latency` → `0`.
    - `INITIAL_DB_STATE.lastCheck` → `""`.
    - Add `passwordSet: false` to `DbState` type and `INITIAL_DB_STATE`.
    - The connection-string display function in `ConnectionTab.tsx` must use `sqlserver://` as the scheme prefix when `engine === "SQL Server"`.

15. `[CODE]` Rewrite `src/components/data/ConnectionTab.tsx` to be functional:

    **Props change:** the component must be self-sufficient (loads its own config; manages its own `saving`/`testing` state internally). The parent `page.tsx` that renders the Connection tab passes only `stockSync` and `onToggleStockSync` (the stock-sync toggle is a display-only `syncMode` hint in P1 — keep the existing toggle wired to local state as before; the real `syncMode` is saved via the PATCH route).

    **State shape (internal `useState`):**
    - `db: DbState` — starts at `INITIAL_DB_STATE`, populated on mount from GET.
    - `password: string` — live plaintext in component memory only; never stored; cleared on successful save.
    - `showPassword: boolean` — toggle for the masked input eye icon.
    - `saving: boolean` — tracks in-flight PATCH.
    - `testing: boolean` — tracks in-flight POST test-connection.
    - `testResult: { connected: boolean; latencyMs: number | null; error: string | null } | null`.
    - `loadError: string | null` — if GET fails on mount.

    **On mount (`useEffect`):**
    - `fetch("/api/krs/settings")` → if settings non-null, populate `db` (host, port, name/database, user/username, ssl, syncMode, passwordSet).
    - On fetch error: set `loadError`.

    **Password field (NEW — the missing field from the original design):**
    - `<input type={showPassword ? "text" : "password"} autocomplete="new-password" value={password} onChange={...} placeholder={db.passwordSet ? "•••• saved — leave blank to keep" : "Password"} />`
    - Eye-icon button to toggle `showPassword`.
    - Place below the Username field in the grid (full-width or same column as Username — match the Taste visual language).
    - The field is intentionally NOT pre-populated with any server value (password never returned from GET).

    **Save button (NEW):**
    - Green pill button below the connection form (or inside the form card) — `"บันทึก · Save"` label.
    - On click: `saving = true`; POST/PATCH `fetch("/api/krs/settings", { method: "PATCH", body: JSON.stringify({ host: db.host, port: Number(db.port), database: db.name, username: db.user, ...(password ? { password } : {}), ssl: db.ssl, engine: "SQLSERVER", syncMode: db.syncMode ?? "realtime" }) })`.
    - On success: update `db.passwordSet = true` (from response); clear `password` to `""` (do NOT keep plaintext in state after save); `showToast("บันทึกการตั้งค่า KRS สำเร็จ · Saved")`.
    - On error: `showToast("บันทึกไม่สำเร็จ: " + error.message ?? "Unknown error")`.
    - `saving = false` in finally.

    **Test Connection button (make real):**
    - On click: `testing = true`; `fetch("/api/krs/test-connection", { method: "POST", body: JSON.stringify({}) })`.
    - On success: update `db.status`, `db.latency`, `db.lastCheck` from `{ connected, latencyMs }`. Set `testResult`. Update status card.
    - On error: set `db.status = "disconnected"`, `testResult = { connected: false, latencyMs: null, error: <message> }`.
    - `testing = false` in finally.
    - The "ทดลอง INSERT" (Insert Test Row) button: keep the existing button in the status card but wire it to `showToast("ทดลอง INSERT ยังไม่พร้อมใช้ใน P1")` — the real insert path is P2. The button stays visible so the UI layout does not regress.

    **Connection string display:**
    - Use `sqlserver://` prefix when `db.engine === "SQL Server"` (or always, since engine is fixed in P1).
    - Pattern: `sqlserver://${db.user}@${db.host}:${db.port}/${db.name}${db.ssl ? "?ssl=true" : ""}`.

    **Stock-sync toggle:**
    - Keep the existing `stockSync` / `onToggleStockSync` prop wiring exactly as-is. The `syncMode` value (`realtime`/`daily`/`manual`) is now stored via the PATCH route (in `db.syncMode`); the toggle in P1 reflects the saved `syncMode`. Full syncMode selector UI is P2/P3 scope.

    **Taste visual language (per CLAUDE.md UI rule):**
    - Preserve ALL existing visual structure from `ConnectionTab.tsx` — dark status card at top, two-column grid below (config panel left, connection-string + stock-sync right). Do not change colors, radius, or font sizes.
    - New password field and Save button use the SAME `Field` component style and the same green pill style as the existing `onInsertTestRow` button.
    - Password field: use a wrapper `div` with `position:relative` to position the eye-icon toggle button inside the field's right edge (14px from right, vertically centered).

---

## Verification Plan (Orchestrator-Owned)

These verification steps are orchestrator-owned and run AFTER the execute-agent declares CODE DONE.
The execute-agent writes code only; it does NOT run migrations, builds, or smoke tests.

### Gate 1 — Type-check and Build

```bash
npm run type-check      # tsc --noEmit; must be zero errors
npm run build           # in an isolated worktree so dev :3000 .next is not clobbered
```

Both must pass before proceeding. The isolated-worktree build pattern from the repo memory doc
(`live-smoke-and-next-build-race.md`) applies here.

### Gate 2 — Prisma Migration on Ephemeral Postgres

Run `npx prisma migrate dev --name krs_connection_settings` against the dev Postgres instance.
Confirm: `\d "KrsConnectionSettings"` in psql shows all columns including `encryptedPassword`,
`ssl`, `engine`, `syncMode`. Confirm `AuditLog` table still exists and `AuditAction` enum includes
`KRS_SETTINGS_CHANGED`.

### Gate 3 — Crypto Round-Trip Assertion (from spec §10 P1 gate)

Run a Node REPL test (or a one-off script — NOT committed) that:
- Encrypts a known password → blob starts with `"v1:"`.
- Decrypts the blob → recovers the original password.
- Alters the AAD constant → `final()` throws (auth-tag mismatch).
- Alters the version segment → throws `"unknown ciphertext version"`.
- Passes a malformed hex `ivHex` (e.g. odd-length) → throws `"corrupt ciphertext: malformed hex segment"`.

### Gate 4 — Docker SQL Server Smoke (live API end-to-end)

Spin up an ephemeral Docker SQL Server:
```bash
docker run -e "ACCEPT_EULA=Y" -e "SA_PASSWORD=<DevPass123!>" \
  -p 1433:1433 --rm mcr.microsoft.com/mssql/server:2022-latest
```
Seed a minimal mock KRS schema (tables: `sales`, `sale_items`, `stock_movements`, `products`).

Run the following scenario (automated or manual via curl/browser):

1. `PATCH /api/krs/settings` with `{ host: "localhost", port: 1433, database: "mock_krs", username: "sa", password: "<DevPass123!>", ssl: false, engine: "SQLSERVER", syncMode: "realtime" }`.
   - Assert response: `{ settings: { ..., passwordSet: true } }`. No `password` or `encryptedPassword` key in the response body (§10 write-path masking assertion).
2. DB inspection: `SELECT "encryptedPassword" FROM "KrsConnectionSettings"` — confirm the value starts with `"v1:"` (ciphertext, not plaintext).
3. `GET /api/krs/settings` — confirm `passwordSet: true`, no `encryptedPassword` field.
4. `POST /api/krs/test-connection {}` — confirm `{ connected: true, latencyMs: <N> }` where N is a real integer.
5. `GET /api/krs/schema` — confirm `{ configured: true, tables: { sales: [...], ... } }` with real column metadata.
6. `PATCH /api/krs/settings` with a new `host` value — confirm `AuditLog` table has a new row with `action = "KRS_SETTINGS_CHANGED"`.
7. `PATCH /api/krs/settings` with `host` exceeding 253 chars — confirm `{ code: "VALIDATION" }` 400.
8. `PATCH /api/krs/settings` with `host = "host@with/meta:chars"` — confirm `{ code: "VALIDATION" }` 400.

### Gate 5 — UI Smoke

Start dev server; navigate to `/data` → Connection tab as Admin:
- Confirm saved settings load on mount (host/port/database/username/passwordSet).
- Confirm password field shows `"•••• saved — leave blank to keep"` placeholder when `passwordSet = true`.
- Enter new settings; click Save; confirm toast `"บันทึกการตั้งค่า KRS สำเร็จ"`.
- Click Test Connection; confirm real `{ connected, latencyMs }` response drives the status card.
- Confirm connection string displays with `sqlserver://` prefix.

### Gate 6 — Real KRS Instance (Final Gate — Owner Required)

Enter the owner's real KRS SQL Server credentials via the Connection tab (host/port/database/
username/password/SSL). Click Save. Click Test Connection. Confirm:
- `{ connected: true, latencyMs: <N> }` against the owner's real SQL Server.
- `GET /api/krs/schema` returns real column metadata for the owner's KRS tables.
- DB confirms `encryptedPassword` is ciphertext.

P1 is VERIFIED only after Gate 6 passes.

### Adversarial Security Review (Pre-Verified)

Before declaring P1 VERIFIED, a code reviewer must confirm:
- `src/lib/krs/crypto.ts`: AAD is set on BOTH cipher and decipher, hex-length regexes are present on all three segments, version is checked before buffer construction.
- `src/app/api/krs/settings/route.ts`: GET Prisma `select` does NOT include `encryptedPassword`; PATCH response does not contain `password`/`encryptedPassword` key; `encrypt()` is called server-side, never client-side.
- `src/app/api/krs/test-connection/route.ts`: no password value logged; sanitized error only.
- `src/lib/krs/client.ts`: no import of `src/lib/prisma.ts` for mssql purposes (only for loading `KrsConnectionSettings`); raw driver error/config never passed to `logger`.
- `src/components/data/ConnectionTab.tsx`: plaintext `password` state is cleared on successful save; `type="password"` on the input.

---

## P1/P2 Explicit Boundary

| Capability | Phase |
|---|---|
| `KrsConnectionSettings` Prisma model | P1 |
| AES-256-GCM crypto util | P1 |
| `mssql` pooled client + `testConnection()` + `introspectSchema()` | P1 |
| `GET /api/krs/settings`, `PATCH /api/krs/settings` | P1 |
| `POST /api/krs/test-connection` | P1 |
| `GET /api/krs/schema` | P1 |
| Functional Connection tab (password, Save, real Test Connection, SQL Server defaults) | P1 |
| Field Mapping tab consuming `/api/krs/schema` output (`MappingTab.tsx` rewrite) | P2/P3 |
| `SyncJob` outbox extension fields (`payload`, `idempotencyKey`, `attempts`, etc.) | P2 |
| `sync_job_outbox` Prisma migration | P2 |
| `src/lib/krs/dispatcher.ts` | P2 |
| `src/lib/krs/mapper.ts` | P2 |
| Checkout wiring (`src/app/api/orders/route.ts` enqueue) | P2 |
| Stock-movements wiring | P2 |
| Refund/void wiring | P2 |
| `src/lib/krs/puller.ts` (inbound product pull) | P3 |
| NavRail failed-job badge from real rows | P4 |
| Secrets audit + runbook | P4 |

---

## Dependencies and Blockers

| Dependency | Status |
|---|---|
| P0 spec approved (§12 checklist) | RESOLVED — owner approved P1 start |
| `mssql@^11` in `package.json` | ORCH: run `npm install mssql@^11` before execute-agent begins |
| `KRS_CONFIG_ENC_KEY` in owner's `.env` | ORCH: owner generates with `openssl rand -base64 32` |
| Dev Postgres running for migration | ORCH: docker-compose up db (standard dev setup) |
| Docker SQL Server for smoke tests (Gates 3–5) | ORCH: pull `mcr.microsoft.com/mssql/server:2022-latest` |
| Owner's real KRS test SQL Server (Gate 6) | OPEN: owner supplies at P1 verification |
| `logAudit` location in repo | Execute-agent must verify: check `src/lib/auditLog.ts` for the function signature before step 11 |

---

## Open Questions (from P0 §11 — informational for P1, not blockers)

Q1–Q11 from spec §11 are informational during P1 and do not block connection layer implementation.
`introspectSchema()` in Gate 4–6 will answer Q1 (table names), Q2 (`price_list`/`stock_balance`
layout), Q3 (join keys), Q4 (barcode), and confirm §4.2 conceptual mapping. Answers must be
documented in the P1 phase report for P2's mapper.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| AES-GCM AAD omission (ciphertext not context-bound) | HIGH | Gate 3 explicitly tests AAD-mismatch fails closed. Adversarial review before VERIFIED. |
| PATCH response echoes password (masking bug) | HIGH | Gate 4 step 1 asserts no `password`/`encryptedPassword` key. Adversarial review. |
| Raw mssql error leaks connection config | HIGH | `client.ts` sanitized-error-only logging pattern. Adversarial review. |
| `mssql` pool not closed on error in `testConnection` | MEDIUM | Use try/finally to close pool in all paths. |
| Isolated-worktree build not used → `.next` corruption | MEDIUM | Follow `live-smoke-and-next-build-race.md` repo memory pattern for Gate 1. |
| `connectionTypes.ts` defaults break existing Connection tab layout before mount loads data | LOW | `INITIAL_DB_STATE` uses empty strings; the form shows empty until GET response; this is acceptable for the functional screen. |

---

## Code-Only Boundary for Execute-Agent

The execute-agent writes and edits source files only. The following are explicitly FORBIDDEN for
the execute-agent in P1:

- Running `npx prisma migrate dev` or any migration command
- Running `npm install` / `npm run build` / `npm run type-check`
- Starting `npm run dev` or any dev server
- Running Docker commands
- Making any HTTP requests to the running app
- Committing to git

The execute-agent declares `CODE DONE` when all files in the checklist are written/edited and the
agent is confident `npm run type-check` will pass (based on TS type reasoning). The orchestrator
then takes over for migration, type-check, build, and smoke tests.

---

## Acceptance Criteria (P1 Gate — must ALL pass before P1 VERIFIED)

1. `npm run type-check` exits zero.
2. `npm run build` exits zero (isolated worktree).
3. `GET /api/krs/settings` returns `{ settings: { ..., passwordSet: true } }` after a PATCH — no `encryptedPassword` key.
4. `PATCH /api/krs/settings` response body contains no `password` or `encryptedPassword` key.
5. `KrsConnectionSettings.encryptedPassword` in DB is a `v1:...` ciphertext blob, not plaintext.
6. Crypto round-trip: `decrypt(encrypt("test123"))` === `"test123"`; AAD-mismatch throws.
7. `POST /api/krs/test-connection {}` returns `{ connected: true, latencyMs: <N> }` against Docker SQL Server.
8. `GET /api/krs/schema` returns real `INFORMATION_SCHEMA.COLUMNS` metadata for the mock tables.
9. PATCH with `host` > 253 chars returns `{ code: "VALIDATION" }` 400.
10. Host-change PATCH writes a `KRS_SETTINGS_CHANGED` audit row.
11. Connection tab loads saved settings on mount; Save button persists to DB; Test Connection drives the status card with real data.
12. Owner enters real KRS credentials via the UI → `{ connected: true }` from the real SQL Server (Gate 6).

---

## Resume and Execution Handoff

**State at plan creation:** P0 COMPLETE, P1 UNBLOCKED. No code exists for the krs lib or krs API routes. `ConnectionTab.tsx` and `connectionTypes.ts` are demo-only.

**Next action for orchestrator:** confirm `mssql@^11` installed → pass this plan path to the execute-agent:
`process/features/krs-sync/active/krs-sync-phase01-connection_PLAN_22-06-26.md`

**Execute-agent entry point:** step 2 (`prisma/schema.prisma` edit). Steps 1, 3 (migration), and all
Gates are orchestrator-owned.

**If execute-agent is interrupted** after writing some but not all files: resume from the last
incomplete step in the Implementation Checklist. Check which files already exist before re-writing.

**After CODE DONE:** orchestrator runs Gates 1–5, then arranges Gate 6 with the owner. On Gate 6
pass, write the P1 phase report to `process/features/krs-sync/reports/krs-sync-phase01-connection_REPORT_22-06-26.md`
documenting: resolved introspection evidence (table/column names from the real instance), any
deviations from P0 spec §11 open questions, and the P2 start signal.

**P2 start signal:** P1 VERIFIED → write P2 phase plan at `process/features/krs-sync/active/krs-sync-phase02-outbound_PLAN_22-06-26.md` (do not start P2 before P1 Gate 6 passes).

**Validator:**
```bash
node .claude/skills/vc-generate-plan/scripts/validate-plan-artifact.mjs \
  process/features/krs-sync/active/krs-sync-phase01-connection_PLAN_22-06-26.md
```

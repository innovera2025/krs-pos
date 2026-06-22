# KRS Sync — Phase 0 Spec / Contract Document

- Feature: krs-sync
- Phase: P0 of 5 (P0–P4) — **spec only, no production code**
- Date: 2026-06-22
- Status: ⏳ AWAITING OWNER REVIEW (see §12 Approval Checkpoint)
- Plan: `process/features/krs-sync/active/krs-sync-phase00-contracts_PLAN_22-06-26.md`
- Umbrella: `process/features/krs-sync/active/krs-sync-program_PLAN_22-06-26.md`
- Grounding: `process/features/krs-sync/references/krs-sync-grounding_22-06-26.md`
- Owner decisions applied: 2026-06-22 (Admin-UI config · `KrsConnectionSettings` singleton · AES-256-GCM password · runtime schema introspection)
- Adversarial review folded in: 2026-06-22 (2 reviews, 13 findings — 11 applied, 2 deferred; see the P0 report `process/features/krs-sync/reports/krs-sync-phase00-contracts_REPORT_22-06-26.md`). Material contract changes: AES-GCM AAD + `v1` versioned format (§2.2–§2.6); SSRF/injection Zod bounds + host-change audit (§1.2.1); SyncJob outbox enqueued INSIDE the checkout `$transaction` (§8.1); atomic compare-and-swap dispatcher claim + 10-min stale-lock reclaim (§8.3); refund/void stock-reversal row + sign conventions (§4.1/§4.3).

---

## 0. Purpose and Reading Order

This document is the single source of truth that removes implementation ambiguity from
P1–P4 of the KRS Sync program. **No production code is written in P0.** P0 defines the
*conceptual* contract (which POS event maps to which KRS table) plus every engineering
contract (model shapes, encryption scheme, env contract, idempotency, outbox, introspection,
verification). Exact KRS column names are NOT fixed here — they are discovered at P1 runtime
via `INFORMATION_SCHEMA` introspection.

This spec gates P1: **no P1 code begins until the owner reviews and approves §12.**

What changed from the original program framing (owner decision, 2026-06-22):
- The hard dependency on the owner handing over KRS DDL is **removed**. The app introspects
  the KRS schema at runtime instead.
- KRS connection credentials move **out of `.env`** and into a new Postgres model
  (`KrsConnectionSettings`), configured from the Admin UI. The only new env var is the
  encryption key, `KRS_CONFIG_ENC_KEY`.

Section map (matches the P0 plan's required ordering):

1. `KrsConnectionSettings` model design
2. AES-256-GCM encryption scheme
3. Revised env contract (`KRS_CONFIG_ENC_KEY` only)
4. Conceptual OUTBOUND event→table mapping (POS → KRS)
5. Conceptual INBOUND mapping (KRS → POS)
6. Schema introspection approach
7. Idempotency + dedup design
8. Fail-open contract + `SyncJob` outbox extension fields
9. `mssql` package version + dev verification approach
10. Verification approach for P1–P4
11. Open questions for the owner
12. Approval checkpoint
13. Appendix: P1 deliverables / touchpoints

Architectural invariants baked in across every section (do not relitigate):

- **Fail-open:** a KRS write failure NEVER blocks or rolls back a POS checkout.
- **Cross-engine separation:** KRS (`mssql`) writes NEVER enlist in the POS Prisma
  `$transaction`; the KRS client is a separate driver, never the Prisma singleton.
- **Secret hygiene:** the password is encrypted at rest, never stored plaintext, never
  logged at any level, never returned in any API response.

---

## 1. `KrsConnectionSettings` Model Design

A new Postgres model storing the single KRS SQL Server connection profile. It is a
**singleton** that mirrors the existing `ShopSettings` pattern in `prisma/schema.prisma`
(`id String @id @default("singleton")` — exactly one row ever exists).

This model holds *connection parameters only*. It does NOT open a second Prisma datasource;
Prisma 5 is PostgreSQL-provider-locked. The actual MS SQL Server connection is opened by the
separate `mssql` driver in `src/lib/krs/client.ts` (P1), which reads these fields at connect
time.

### 1.1 Model sketch (SPEC ONLY — not applied; created in the P1 migration)

```prisma
// KRS connection profile (krs-sync P1). Singleton — exactly ONE row, mirroring
// ShopSettings (id @default("singleton")). Stores the MS SQL Server connection
// parameters configured from the Admin /data Connection tab. The password is
// AES-256-GCM encrypted at rest (see encryptedPassword); plaintext never persists.
// This model is connection CONFIG only — the live mssql ConnectionPool is opened
// in src/lib/krs/client.ts, NOT here, and NEVER via the Prisma singleton.
model KrsConnectionSettings {
  id                String   @id @default("singleton")
  host              String                                  // SQL Server hostname or IP
  port              Int      @default(1433)                 // SQL Server default port
  database          String                                  // target database name
  username          String                                  // SQL Server SQL-auth username
  encryptedPassword String?                                 // AES-256-GCM blob (see §2); null = not yet set
  ssl               Boolean  @default(true)                 // TLS / encrypt connection
  engine            String   @default("SQLSERVER")          // fixed; read-only display in UI
  syncMode          String   @default("realtime")           // "realtime" | "daily" | "manual"
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}
```

### 1.2 Field contract

| Field | Prisma type | Default | Notes |
|---|---|---|---|
| `id` | `String @id` | `"singleton"` | Singleton key; only one row ever exists. |
| `host` | `String` | — | SQL Server hostname or IP. Required on save. |
| `port` | `Int` | `1433` | SQL Server default; validated `1–65535` server-side. |
| `database` | `String` | — | Target DB name. Required on save. |
| `username` | `String` | — | SQL Server SQL-auth username. Required on save. |
| `encryptedPassword` | `String?` | `null` | AES-256-GCM blob (§2). `null` until first password save; surfaced to the UI as `passwordSet: false`. |
| `ssl` | `Boolean` | `true` | Maps to the mssql `options.encrypt` connection flag. |
| `engine` | `String` | `"SQLSERVER"` | Fixed value; the UI shows it read-only (matches the design's read-only `{{ dbEngine }}` display). |
| `syncMode` | `String` | `"realtime"` | One of `realtime` / `daily` / `manual`; validated against an enum server-side. |
| `createdAt` | `DateTime` | `now()` | Singleton metadata; not returned to clients. |
| `updatedAt` | `DateTime` | `@updatedAt` | Singleton metadata; not returned to clients. |

**Decision — string vs Prisma enum for `engine` / `syncMode`:** use plain `String` with a
default and a Zod-enum server-side guard (mirrors how `ShopSettings`/`SyncJob` mix enums and
free strings, and how `provider` is an open string). This keeps the migration additive and
avoids minting Postgres enum types for fixed single-value (`engine`) or
likely-to-grow (`syncMode`) fields. The UI restricts `engine` to read-only.

**Decision — `encryptedPassword` is nullable.** A fresh/unseeded DB has no KRS password.
The "not configured" state (no row, or a row with `encryptedPassword = null`) must be handled
gracefully: Test Connection returns `{ connected: false, error: "KRS connection not configured" }`
rather than throwing.

**Decision — pool sizing and retry knobs are NOT stored on the model in P1.** The design
shows "pool 8/20 connections" as a static hint. P1 hardcodes sensible pool defaults
(`min` / `max`) in `src/lib/krs/client.ts`; max retry attempts and backoff are hardcoded in
the P2 dispatcher (default `maxAttempts = 5`). These may be promoted to optional
`KrsConnectionSettings` fields in a later phase if the owner wants them tunable from the UI —
flagged as an open question (§11).

### 1.2.1 Server-side validation contract (Zod — SSRF / injection bounds)

(Review finding R2.) The PATCH `/api/krs/settings` body feeds the `mssql` `ConnectionPool`, so
every field is validated + bounded server-side at the parse boundary via the shared
`parseBody` / `conciseIssues` helper (`src/lib/schemas/_shared.ts`) — mirroring the rigor of
`ShopSettingsPatchBodySchema` / `sellerConfig`. P1 adds `src/lib/schemas/krsSettings.ts`. The
contract (exact messages/regex finalized in P1, but the BOUNDS are pinned here so P1 cannot
ship an unbounded field):

| Field | Bound | Rationale |
|---|---|---|
| `host` | string, **≤ 253 chars**, matches a hostname-or-IPv4/IPv6 pattern; reject control chars, whitespace, `:` `@` `/` `\` (anything that could smuggle into a connection string) | The host is passed straight into the pool; an unbounded/free-form host is the SSRF + connection-string-injection surface. |
| `port` | int, **1–65535** | Already specified; restated for completeness. |
| `database` | string, **≤ 128 chars**, conservative charset (alphanumerics + `_ - .`); reject control chars + the connection-string metacharacters above | SQL Server identifier; bounded length + charset blocks injection into the connection string. |
| `username` | string, **≤ 128 chars**, same conservative charset/metachar rejection as `database` | SQL-auth username; same injection surface. |
| `password` | string, **1–256 chars** (write-only; never returned — §2.5) | Bounded to keep the encrypted blob sane; never echoed. |
| `ssl` | boolean | Maps to `options.encrypt`. |
| `engine` | Zod enum, fixed `"SQLSERVER"` | Read-only in UI; server rejects anything else. |
| `syncMode` | Zod enum `realtime` \| `daily` \| `manual` | Already specified; restated. |

**SSRF stance (explicit decision):** KRS is a **deliberately admin-configured outbound
target** — the whole point is to let the store owner point the POS at their own KRS SQL Server,
which may legitimately be an on-prem/RFC1918 address. A hard private-IP / metadata-IP
(`169.254.169.254`, `127.0.0.1`, RFC1918) **denylist is therefore NOT imposed** (it would break
the legitimate single-store deployment). The compensating controls are: (a) all KRS routes are
`requireAdmin`; (b) the bounded-charset host validation above blocks connection-string
smuggling; (c) **every change to `host` (and `port`) is written as an audit-log event** so a
silently-repointed pool is detectable in the audit trail. The audit event reuses the existing
`logAudit` infrastructure (a new `AuditAction.KRS_SETTINGS_CHANGED` value is added in the P1
migration alongside `KrsConnectionSettings`). Re-auth-on-host-change is deferred (see §11) as a
heavier control than a single-store admin tool warrants today; the audit trail is the P1 floor.

### 1.3 Migration placement

- The `KrsConnectionSettings` model is created in a **NEW Prisma migration at P1** (not P2).
- It is **additive only** — a brand-new table, no existing table altered. No existing seed
  data is affected.
- Naming suggestion for the P1 migration: `krs_connection_settings`.

---

## 2. AES-256-GCM Encryption Scheme

The SQL Server password is the only secret stored in the POS DB. It is encrypted at rest with
**AES-256-GCM**. P1 implements this as `src/lib/krs/crypto.ts`.

### 2.1 Key source

- **Env var:** `KRS_CONFIG_ENC_KEY` — a 32-byte key, **base64-encoded** (44 base64 chars,
  decodes to exactly 32 bytes for AES-256).
- **Location:** git-ignored `.env` only. `.env.example` documents the *name* with a
  generation hint, never a real value (see §3).
- **Generate:** `openssl rand -base64 32`.

**Fail-fast rule (non-negotiable):** if `KRS_CONFIG_ENC_KEY` is absent, empty, or does not
decode to exactly 32 bytes, the crypto module must throw immediately at first use rather than
silently degrading to plaintext. The app must never store an unencrypted password as a
fallback.

- Suggested error message (missing): `KRS_CONFIG_ENC_KEY is required to encrypt/decrypt the KRS connection password. Generate one with: openssl rand -base64 32`
- Suggested error message (wrong length): `KRS_CONFIG_ENC_KEY must decode to exactly 32 bytes (AES-256). Got N bytes.`

**Validation placement:** because env validation in `src/lib/env.ts` runs at server boot, but
a deploy that never configures KRS must still boot, the key is validated **lazily at the
encrypt/decrypt callsite** in `crypto.ts` (fail-fast at first KRS write/connect), not as a
hard boot-time requirement in `env.ts`. `env.ts` may optionally record `KRS_CONFIG_ENC_KEY` as
an optional/shape-checked var (see §3); the authoritative fail-fast lives in `crypto.ts`. This
matches the existing pattern where seller-identity env vars are shape-checked but enforced at
the request that needs them, not at boot.

### 2.2 Stored format

The encrypted value packs a **scheme-version tag**, the IV, the GCM auth tag, and the
ciphertext into a single string so all parts travel together in one `encryptedPassword` column:

```
<version>:<iv_hex>:<authTag_hex>:<ciphertext_hex>
```

- `version` — a short scheme/key-vintage tag, **`v1`** for the initial scheme (review finding
  R3). It is the first segment so decrypt can distinguish "wrong key vintage" from "tampered"
  and so a future key rotation (§2.6) can support old+new key during a swap window and bump the
  tag. It is also part of the AAD (see §2.3 step 2) so a version mismatch fails closed.
- `iv_hex` — 12-byte (96-bit) IV, hex-encoded (24 hex chars). 96 bits is the GCM-recommended
  IV length.
- `authTag_hex` — 16-byte GCM authentication tag, hex-encoded (32 hex chars).
- `ciphertext_hex` — the encrypted password bytes, hex-encoded.
- Separator: `:` (colon). The version is a fixed short token (`v1`) and hex segments contain no
  `:`, so splitting on `:` into exactly **four** parts is unambiguous.

**Fixed AAD (review finding R1 — context-binding):** every encrypt and decrypt MUST bind a
**fixed Additional Authenticated Data** value via `cipher.setAAD()` / `decipher.setAAD()`. The
AAD is a constant context+version label, **`Buffer.from("krs.connection.password.v1")`**. AAD
is authenticated but not encrypted; it binds the ciphertext to its purpose so a blob produced
by some *other* AES-256-GCM field encrypted under the same `KRS_CONFIG_ENC_KEY` (a future
second secret, a copied row, a restored-from-backup blob) cannot be cross-decrypted into the
KRS-password slot — the GCM tag check fails closed on an AAD mismatch. Bump the AAD label
alongside the §2.2 version tag if the scheme changes.

### 2.3 Encrypt (write path — PATCH settings)

1. Decode `KRS_CONFIG_ENC_KEY` from base64 → 32-byte `Buffer`; assert length 32 (else
   fail-fast per §2.1).
2. `createCipheriv("aes-256-gcm", key, iv)`; **`cipher.setAAD(Buffer.from("krs.connection.password.v1"))`**
   (the fixed context-binding AAD, set BEFORE `update`).
3. Generate a **fresh random 12-byte IV per write** (`crypto.randomBytes(12)`). IVs are NEVER
   reused — every save (even re-saving the same password) gets a new IV.
4. `update(plaintext, "utf8")` + `final()` → ciphertext.
5. `cipher.getAuthTag()` → 16-byte auth tag.
6. Serialize as `"v1" + ":" + iv.toString("hex") + ":" + authTag.toString("hex") + ":" + ciphertext.toString("hex")`
   (the `v1` version tag is the first segment — §2.2).
7. Store in `KrsConnectionSettings.encryptedPassword`.

### 2.4 Decrypt (read/connect path — Test Connection, dispatcher, puller)

1. Decode the key (as §2.3 step 1).
2. Split the stored string on `:` into `[version, ivHex, authTagHex, ciphertextHex]`; if it
   does not split into exactly **four** non-empty parts, treat as corrupt → throw a clear
   `corrupt ciphertext` error.
3. Assert `version === "v1"` (reject unknown vintages with a clear error — review finding R3),
   then **validate each remaining segment is well-formed hex of the expected length BEFORE
   constructing Buffers** (review finding R6): `ivHex` matches `/^[0-9a-f]{24}$/` (12 bytes),
   `authTagHex` matches `/^[0-9a-f]{32}$/` (16 bytes), and `ciphertextHex` matches
   `/^[0-9a-f]+$/` with even length. `Buffer.from(x, "hex")` silently truncates on bad/odd hex
   rather than throwing, so this regex gate turns a malformed blob into a clean
   `corrupt ciphertext` error instead of a confusing downstream crypto failure.
4. `createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"))`;
   **`decipher.setAAD(Buffer.from("krs.connection.password.v1"))`** (same fixed AAD as encrypt);
   `setAuthTag(Buffer.from(authTagHex, "hex"))`.
5. `update(ciphertext) + final()` → plaintext. **GCM auth-tag verification throws on any
   tampering, wrong key, OR AAD mismatch** — this is the integrity + context-binding guarantee.
6. Return plaintext **in memory only**. NEVER persist it, NEVER log it, NEVER include it in a
   response. It is used solely to build the `mssql` connection config and then discarded.

### 2.5 Masking rule (ALL GET responses)

- The `encryptedPassword` column is **never** returned by any API handler — neither the raw
  blob nor a decrypted value.
- `GET /api/krs/settings` returns every other field plus a derived boolean
  **`passwordSet: boolean`** (`true` when `encryptedPassword` is non-null), so the UI can show
  "password is configured" without ever transmitting it.
- The Prisma `select` for the GET path explicitly omits `encryptedPassword` (mirroring the
  `SETTINGS_SELECT` projection pattern in `src/app/api/settings/route.ts`), so the secret
  cannot leak through the serializer by accident.
- **Write-path projection (review finding R4):** the `PATCH /api/krs/settings` response MUST
  use the SAME `passwordSet`-only projection as GET — it never echoes the submitted plaintext
  password and never returns the `encryptedPassword` blob. Zod messages for the password field
  MUST NOT interpolate the value (no `.refine()` / custom message that embeds the cleartext);
  the shared `parseBody`/`conciseIssues` helper already returns path+message only, and the
  password field must keep it that way. The §10 P1 gate adds an explicit assertion that the
  PATCH response body contains no `password`/`encryptedPassword` key and no cleartext value.
- Plaintext password is NEVER logged at any level (info / warn / error). Connection errors log
  the host/port/database/username and error code — never the password.
- **Sanitized error logging (review finding R5 — defense against driver-object leakage):** the
  KRS client MUST construct a SANITIZED error object (`{ host, port, database, username, code,
  message }` only) and log THAT — it MUST NEVER pass the raw `mssql`/`tedious` error object or
  the connection-config object to the logger. Rationale: a driver error can embed the full
  connection config (including the password) under driver-specific keys NOT covered by the pino
  `redact` list (`src/lib/logger.ts` redacts `*.password`/`*.secret` by key name only), and the
  repo's established `logger.error({ err }, ...)` pattern would serialize the whole object.
  As cheap defense-in-depth, P4 MAY add `config.password` / `*.connectionString` to the pino
  `redact` list, but the PRIMARY rule is "never hand the raw driver error/config to the logger."

### 2.6 Threat-model notes

- AES-256-GCM provides confidentiality **and** integrity (the auth tag detects tampering /
  wrong key).
- Compromise model: an attacker with DB read access but without `KRS_CONFIG_ENC_KEY` cannot
  recover the password. The key lives only in the runtime environment, never in the DB or git.
- Key rotation (documented for the P4 runbook): decrypt all stored passwords with the old key,
  re-encrypt with the new key, swap the env var. With a single singleton row this is a
  one-row re-encrypt.
- **Versioned format for safe rotation (review finding R3):** the stored format carries a
  leading scheme/key-vintage tag (`v1`, §2.2) and the encrypt/decrypt path asserts it (§2.4
  step 3). This lets decrypt distinguish "wrong key vintage" (clear, recoverable signal) from
  "tampered/corrupt", and lets a future rotation bump the tag (e.g. `v2`) and run a window where
  both the old and new key are accepted while the singleton row is re-encrypted. Even though the
  singleton makes today's rotation a single-row swap, baking the version into the format now is
  trivial and impossible to retrofit cleanly once blobs exist. The AAD label (§2.3) is bumped in
  lockstep with the version tag so a vintage mismatch fails closed.

---

## 3. Revised Env Contract

**Only ONE new env var is added by this feature.** All KRS *connection* parameters (host,
port, database, username, password, ssl, syncMode) live in the `KrsConnectionSettings` DB
model, NOT in `.env`.

### 3.1 New env var

| Var | Format | `.env.example` placeholder | Purpose |
|---|---|---|---|
| `KRS_CONFIG_ENC_KEY` | 32 bytes, base64 (44 chars) | `KRS_CONFIG_ENC_KEY=` *(comment: generate with `openssl rand -base64 32`)* | AES-256-GCM key for encrypting `KrsConnectionSettings.encryptedPassword`. |

`.env.example` documents the **name with a generation hint only** — never a real or fabricated
key value (matches the existing `.env.example` discipline of placeholders such as
`CHANGE_ME`). Suggested entry:

```
# KRS sync — AES-256-GCM key for encrypting the stored KRS SQL Server password.
# Must decode to exactly 32 bytes. Generate with: openssl rand -base64 32
# git-ignored .env only; NEVER commit a real value.
KRS_CONFIG_ENC_KEY=
```

### 3.2 Removed / never-added env vars

The following connection-credential env vars from the *original* (pre-2026-06-22) design are
**explicitly NOT part of the contract** and must never be added:

`KRS_HOST`, `KRS_PORT`, `KRS_DB`, `KRS_USER`, `KRS_PASS`, `KRS_POOL_MIN`, `KRS_POOL_MAX`,
`KRS_ENCRYPT`, `KRS_TRUST_SERVER_CERT`, `KRS_SYNC_MODE`, `KRS_MAX_ATTEMPTS`,
`KRS_RETRY_DELAY_MS`.

These are now either `KrsConnectionSettings` fields (host/port/db/user/password/ssl/syncMode)
or hardcoded defaults in the krs lib (pool sizing, retry config).

### 3.3 `src/lib/env.ts` impact (P1)

`src/lib/env.ts` at P1 needs at most a shape-check entry for `KRS_CONFIG_ENC_KEY` (optional at
boot, so a non-KRS deploy still boots). The authoritative fail-fast for a missing/invalid key
lives in `src/lib/krs/crypto.ts` at first use (§2.1). No connection-cred validation is added to
`env.ts` — those values come from the DB at runtime.

---

## 4. Conceptual OUTBOUND Event → Table Mapping (POS → KRS)

This is the *conceptual* contract: which POS event triggers a write to which KRS table. Exact
KRS column names are discovered by P1 introspection (§6); the column names below are the
**design's best-guess baseline** (from `design/Simple POS.dc.html` field-mapping section,
verified against the live introspection at P1).

### 4.1 Event → table

| POS event | KRS target table(s) | Idempotency key (§7) | Notes |
|---|---|---|---|
| Checkout (sale completed) | `sales` (1 header row) + `sale_items` (N line rows) | `orderNumber + "_SALE"` | One `sales` row + one `sale_items` row per `OrderItem`. |
| Stock receive (GRN) | `stock_movements` (1..N rows, one per item received) | `GRN_ref + "_STOCK"` | Positive `qty_delta`. |
| POS sale stock deduction | `stock_movements` (negative `qty_delta`) | `orderNumber + "_STOCK"` | Emitted alongside the sale (real-time stock sync per design). |
| Refund / void | `sales` (1 row, negative `grand_total`) | `orderNumber + "_REFUND"` or `orderNumber + "_VOID"` | Same table, negative amount; mirrors design seed row `J-1040` (refund, `-65.00`). Sign conventions: see §4.3. |
| Refund / void stock reversal | `stock_movements` (positive `qty_delta`, reversing the sale's negative delta) | `orderNumber + "_STOCK_REVERSAL"` | (Review finding stock-reversal — HIGH.) The POS refund/void path already restores Postgres stock + writes an `ADJUST` `StockMovement` (`src/app/api/orders/[id]/route.ts`). KRS must receive a **compensating positive `stock_movements` row**, else KRS stock permanently diverges after every void/refund (it keeps the original negative sale delta). Uses the existing `STOCK_ADJ` `SyncJobType` (no new enum value needed). **Owner to confirm at P1** whether KRS independently reverses stock on a void document (in which case the POS does NOT send this row) — but the DEFAULT contract is: the POS sends the compensating reversal. |
| Tax invoice request | `sales` (separate document type — target confirmed at P1) | `orderNumber + "_TAX_INVOICE"` | Owner to confirm whether tax invoices target `sales` with a doc-type flag or a separate table. |
| KRS product pull (inbound) | *no KRS write* — SELECT only | `"KRS.products_PULL_" + bangkokYyyymmdd()` | Listed for completeness; detailed in §5. |

### 4.2 Design field-mapping baseline — the 7 outbound rows

From the design's `mapOut` (outbound POS → KRS), exactly as authored in
`design/Simple POS.dc.html`:

| # | POS field | KRS column | Data type | Meaning (TH) | Mapped? |
|---|---|---|---|---|---|
| 1 | `pos_no` | `sales.ref_no` | `string` | คีย์อ้างอิงบิล (bill reference key) | ✅ |
| 2 | `total` | `sales.grand_total` | `decimal(12,2)` | ยอดสุทธิรวม VAT (net total incl. VAT) | ✅ |
| 3 | `vat` | `sales.tax_amount` | `decimal(12,2)` | ภาษีมูลค่าเพิ่ม (VAT amount) | ✅ |
| 4 | `pay_method` | `sales.payment_type` | `enum` | วิธีชำระเงิน (payment method) | ✅ |
| 5 | `sku` | `stock_movements.item_code` | `string` | รหัสสินค้า (product code) | ✅ |
| 6 | `qty` | `stock_movements.qty_delta` | `int` | จำนวนเคลื่อนไหว (movement quantity) | ✅ |
| 7 | `vat_code` | `sales.tax_code` | `string` | รหัสภาษีขาย (sales tax code) | ❌ unmapped |

Row 7 (`vat_code → sales.tax_code`) is the design's intentionally-unmapped example that drives
the `FIELD_MAP_MISMATCH` failed-job demo (design seed `J-1042`). At P1 introspection the real
`sales.tax_code` column existence is confirmed; whether the POS has a `vat_code` source value
to map is an open question (§11).

### 4.3 Money + key conversion rules

- **Money:** POS stores money as Prisma `Decimal(10,2)` (baht) — see `Order.total`,
  `OrderItem.lineTotal`, etc. The design's KRS columns are `decimal(12,2)` (baht). Mapping is
  baht→baht with no scale change; the mapper passes the Decimal as a baht value (string-safe
  to avoid float drift). The introspected `NUMERIC_PRECISION`/`NUMERIC_SCALE` from §6 confirm
  the KRS column shape at P1. (Note: the repo-wide money hazard about JS float math still
  applies — the P2 mapper must avoid `Number()` round-trips on money fields.)
- **POS reference key:** `Order.orderNumber` (e.g. `POS-20260616-0041`) → `sales.ref_no`.
- **SKU:** `Product.sku` → `stock_movements.item_code`.
- **KRS-generated id:** the design seed shows KRS returning `{"krs_id":"BK-48280"}`. If a write
  returns an inserted id, store it in `SyncJob.response` (existing `String?` field).

**Refund / void sign conventions (review finding refund-sign — MED — TO BE CONFIRMED at P1).**
The P2 mapper needs explicit ledger conventions for reversal rows; the DEFAULT contract below is
pinned now and CONFIRMED against the real KRS ledger rules at P1 introspection + owner review:

- All monetary fields on a refund/void `sales` row are **negative** (`grand_total` AND
  `tax_amount` both negative — a refund reverses the VAT too).
- A refund/void is a **header-only reversal**: no `sale_items` line rows are created for the
  reversal header (the original sale's line rows are not re-sent; the negative header is the
  reversal document).
- `payment_type` on the reversal row reflects the **original tender** (not a possibly-different
  refund method). Partial-refund / mixed-tender edge cases are flagged for owner confirmation.
- Stock reversal is a SEPARATE `stock_movements` row with a **positive** `qty_delta` (§4.1), not
  part of the negative `sales` header.

These conventions are marked **TO BE CONFIRMED at P1** — KRS may have its own ledger rules that
override them; the P2 mapper follows whatever P1 introspection + the owner confirm.

---

## 5. Conceptual INBOUND Mapping (KRS → POS)

Inbound is **pull-on-demand only** (no push from KRS). A pull SELECTs KRS product data and
upserts the POS `Product` catalog keyed on SKU. Exact source columns/tables confirmed at P1
introspection.

### 5.1 Design field-mapping baseline — the 6 inbound rows

From the design's `mapIn` (inbound KRS → POS), exactly as authored:

| # | KRS column | POS field | Data type | Meaning (TH) | Mapped? |
|---|---|---|---|---|---|
| 1 | `products.item_code` | `Product.sku` | `string` | รหัสสินค้า (product code) — upsert key | ✅ |
| 2 | `products.name_th` | `Product.name` | `string` | ชื่อสินค้า (ไทย) (Thai product name) | ✅ |
| 3 | `price_list.unit_price` | `Product.price` | `decimal(10,2)` | ราคาขายล่าสุด (latest sale price) | ✅ |
| 4 | `products.vat_rate` | `Product.vat`* | `int` | อัตราภาษี % (VAT rate) | ✅ |
| 5 | `stock_balance.on_hand` | `Product.stock` | `int` | ยอดคงเหลือเรียลไทม์ (real-time on-hand) | ✅ |
| 6 | `customers.tax_id` | `Customer.taxId` | `string` | เลขผู้เสียภาษี (tax ID) | ✅ |

\* **Note:** the POS `Product` model in `prisma/schema.prisma` has **no `vat` column today**
(it has `id, name, sku, price, stock, barcode, imageUrl, isActive, branchId, categoryId`).
The design's `products.vat_rate → vat` mapping therefore targets a field the POS does not yet
have. This is flagged as an open question (§11) — either the inbound mapper drops `vat_rate`
(VAT is handled at checkout, not per-product), or a future migration adds `Product.vat`. P0
does NOT add the column (no schema change in P0).

### 5.2 Upsert contract

- **Upsert key:** `Product.sku` (which has `@unique` in the schema) matched against KRS
  `products.item_code`.
- **Mapped fields:** `name` (from `name_th`), `price` (from `price_list.unit_price`, baht),
  `stock` (from `stock_balance.on_hand`).
- **Idempotency:** re-pulling the same data produces NO duplicate products — upsert on the
  unique SKU updates in place.
- `Customer.taxId` inbound (row 6) is an optional tax-customer match; lower priority than the
  product catalog pull and may be deferred within P3.

---

## 6. Schema Introspection Approach (replaces DDL hand-over)

Instead of the owner handing over DDL, the app discovers real KRS column names/types at
runtime. P1 adds `GET /api/krs/schema` (admin-only).

### 6.1 What `GET /api/krs/schema` does (P1)

1. Loads `KrsConnectionSettings`; if not configured, returns `{ configured: false }` (no throw).
2. Opens an `mssql` connection (decrypting the password in memory per §2.4).
3. Queries `INFORMATION_SCHEMA.COLUMNS` for the target tables.
4. Returns a JSON map: `{ [tableName]: Array<{ columnName, dataType, isNullable, maxLength, numericPrecision, numericScale }> }`.
5. The Field Mapping tab (`MappingTab.tsx`) fetches this and displays **real** column metadata
   instead of the current hardcoded static diagram.

### 6.2 Tables to introspect

- **Minimum (always queried):** `sales`, `sale_items`, `stock_movements`, `products`.
- **Also attempt (include if present):** `price_list`, `stock_balance`, `customers`.

### 6.3 Suggested INFORMATION_SCHEMA query (P1 reference)

Standard, SQL-Server-compatible `INFORMATION_SCHEMA` syntax:

```sql
SELECT
  TABLE_NAME, COLUMN_NAME, DATA_TYPE,
  CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME IN ('sales','sale_items','stock_movements','products',
                     'price_list','stock_balance','customers')
ORDER BY TABLE_NAME, ORDINAL_POSITION;
```

The query is parameter-free over a fixed allow-list of table names (no user-supplied SQL), so
there is no injection surface. The result drives both the Field Mapping UI and the P2 mapper's
column-name resolution.

---

## 7. Idempotency + Dedup Design

The transport is eventual-consistency with retries; the same job may be dispatched more than
once (retry, replay, daily re-drain). The invariant is: **a given POS event is applied to KRS
at most once — never double-applied.**

### 7.1 Idempotency key

- **Scheme:** `<naturalRef> + "_" + <jobType>`.
- Examples:
  - Sale: `POS-20260616-0041_SALE`
  - Sale stock: `POS-20260616-0041_STOCK`
  - GRN stock: `GRN-20260616-007_STOCK`
  - Refund: `POS-20260616-0038_REFUND`
  - Void: `POS-20260616-0041_VOID`
  - Refund/void stock reversal: `POS-20260616-0041_STOCK_REVERSAL` (§4.1)
  - Tax invoice: `POS-20260616-0041_TAX_INVOICE`
  - Product pull: `KRS.products_PULL_20260622` (daily granularity via `bangkokYyyymmdd()`)
- **Storage:** `SyncJob.idempotencyKey` (new field, §8) with a `@unique` index.

### 7.2 Dedup strategy (chosen)

**Primary (POS-side sync log) — CHOSEN:** before any KRS INSERT, query `SyncJob` for an
existing `SYNCED` row with the same `idempotencyKey`. If found, skip the INSERT and mark the
current job `SKIPPED` (idempotent no-op). The `@unique` index on `idempotencyKey` also prevents
two competing dispatch attempts from both inserting — the second hits a unique violation and is
treated as already-handled. This keeps idempotency entirely under POS control and does not
depend on the KRS schema having a unique constraint.

**Secondary (KRS-side natural key) — fallback only:** if a KRS table happens to have a unique
constraint (e.g. `sales.ref_no` unique), a SQL unique-violation on INSERT is caught and treated
as a successful idempotent insert (the row already exists). This is defense-in-depth, not the
primary mechanism, because we cannot assume KRS enforces it.

**Race-safety dependency (review finding D2 — HIGH).** The dedup read above is a read-then-act
pattern and is **only race-safe when the dispatcher claim (§8.3) is an atomic conditional
`UPDATE`**. Without the atomic claim, two workers can both pass the dedup check for the same
single SyncJob row and both issue the KRS INSERT — the `@unique` on `idempotencyKey` does NOT
block this (both hold the same row id) and the KRS-side natural-key fallback is explicitly
unreliable. The at-most-once guarantee therefore depends on §8.3's atomic claim, not on the
dedup read alone.

**Invariant restated:** never double-apply. A retry/replay of an already-`SYNCED`
`idempotencyKey` results in zero new KRS rows.

---

## 8. Fail-Open Contract + `SyncJob` Outbox Extension

### 8.1 Fail-open contract (architectural invariant)

- A KRS write failure **NEVER** blocks or rolls back the POS checkout. The Postgres
  `$transaction` in `src/app/api/orders/route.ts` stays **Postgres-only** (stock decrement,
  order/payment rows, counters). The KRS **network write** is always deferred to the dispatcher
  — it is NEVER attempted during checkout.
- KRS (`mssql`) writes are NEVER enlisted in the POS Prisma `$transaction` — cross-engine
  transactions are impossible and would corrupt the checkout. The dispatcher (§8.3) performs the
  KRS network write entirely outside any Postgres transaction.

**Enqueue is atomic with the Order (review finding C — CRITICAL, fix a — CHOSEN).** The
`SyncJob` outbox row(s) MUST be created **INSIDE the same Postgres `$transaction`** that creates
the `Order` (and stock decrement + `StockMovement`), via `tx.syncJob.create(...)` — exactly the
pattern the existing tax-invoice path already uses (`src/app/api/orders/[id]/route.ts` creates a
`TAX_INVOICE` SyncJob with `tx.syncJob.create` inside its transaction). This eliminates the
crash window where the Order commits but the SyncJob enqueue throws or the process dies between
commit and enqueue — a window a rolling deploy hits on every restart, permanently losing the
sync with no dead-letter path. The outbox row records the work durably and atomically; the KRS
network write is still fully deferred to the dispatcher, so fail-open is preserved AND the
enqueue cannot be lost.

- This **supersedes** the earlier "enqueue after the transaction commits, outside it / fire-and-
  enqueue" framing. The audit-log write stays best-effort-after-commit (it is observability, not
  the outbox); the SyncJob outbox is part of the atomic checkout commit. This also honors the
  repo lesson "never fire-and-forget a DB write a later request reads" — the dispatcher reads
  these SyncJob rows, so their write must be committed atomically, not fire-and-forget.
- **Reconciliation backstop (fix b — defense-in-depth, documented for the P4 runbook):** a named
  reconciliation query catches any Order with no enqueued SyncJob (should be empty given fix a,
  but cheap insurance):
  `SELECT o.id FROM "Order" o LEFT JOIN "SyncJob" s ON s."ref" = o."orderNumber" AND s."type" = 'SALE' WHERE o."syncStatus" = 'PENDING' AND s.id IS NULL AND o."createdAt" < now() - interval '5 minutes';`
  (final column/enum names confirmed against the schema at P4).
- **Non-null idempotencyKey invariant (review finding I-null, MED):** every SyncJob created by
  the P2 enqueue path MUST supply a **non-null** `idempotencyKey`. `null` is reserved EXCLUSIVELY
  for legacy seed rows. Because Postgres allows multiple NULLs under a `@unique` index, a null
  key gives ZERO dedup protection — two null-key PENDING rows could both dispatch. P2 adds a
  runtime assertion in the enqueue helper (throw if the key is null/empty) and a P2 code-review
  gate verifying every `prisma.syncJob.create(...)` / `tx.syncJob.create(...)` in enqueue +
  dispatcher code sets a non-null `idempotencyKey`.

### 8.2 `SyncJob` outbox extension fields (SPEC ONLY — added in the P2 migration)

Current `SyncJob` fields (from `prisma/schema.prisma` L43–56):
`id, type, direction, ref, amount, status, provider, error, response, branchId, createdAt, updatedAt`.

New fields for a real durable outbox (all nullable or defaulted → additive, non-destructive):

| Field | Type | Default | Purpose |
|---|---|---|---|
| `payload` | `Json?` | `null` | Snapshot of the POS row at enqueue time (Order or StockMovement JSON), so the dispatcher does not re-query the POS DB at dispatch time. |
| `idempotencyKey` | `String?` | `null` | `<naturalRef>_<jobType>` (§7). `@unique` index for dedup. Nullable for back-compat (existing seed rows). |
| `attempts` | `Int` | `0` | Retry counter. Default `maxAttempts = 5` (hardcoded in P2 dispatcher). |
| `lastError` | `String?` | `null` | Last error / SQL error string from a failed attempt (distinct from the existing `error` field; `lastError` is the most-recent attempt's detail). |
| `nextAttemptAt` | `DateTime?` | `null` | Retry backoff: `null` = eligible immediately; set to a future timestamp on failure. |
| `lockedAt` | `DateTime?` | `null` | Optimistic dispatch lock: set when a job is being dispatched, cleared on success/failure. Prevents double-dispatch (esp. the daily poller). |

Migration notes:
- All new fields are nullable or have defaults — no existing seed data breaks.
- `idempotencyKey` gets a `@unique` index (Postgres allows multiple NULLs under a unique
  index, so legacy rows are fine).
- Suggested P2 migration name: `sync_job_outbox`. **Additive only.**

### 8.3 Dispatcher / retry state machine (described; implemented in P2)

States use the existing `SyncJobStatus` enum (`PENDING / SYNCED / FAILED / RETRYING / SKIPPED`).

```
                          enqueue (after checkout commit)
                                     │
                                     ▼
                                 [PENDING]
                                     │  dispatcher claims it: set lockedAt=now()
                                     ▼
                                [RETRYING]  ── (transient claim/in-flight) ──┐
                                     │                                       │
            dedup check: SYNCED row with same idempotencyKey exists? ──yes──▶ [SKIPPED]
                                     │ no                                    (lockedAt cleared)
                                     ▼
                          attempt mssql INSERT (idempotent)
                          ┌──────────┴───────────┐
                       success                 failure
                          │                       │ attempts += 1, lastError set
                          ▼                       ▼
                       [SYNCED]          attempts < maxAttempts (5)?
                  (lockedAt cleared,      ┌────────┴─────────┐
                   response stored)     yes                  no
                                          │                   │
                                          ▼                   ▼
                          nextAttemptAt = now()+backoff   [FAILED]
                          status → PENDING/RETRYING      (terminal until manual retry;
                          (lockedAt cleared)              drives NavRail failed badge)
```

- **Backoff:** exponential with a cap (e.g. `min(baseDelay * 2^attempts, maxDelay)`); exact
  values fixed in P2. `nextAttemptAt` gates eligibility — a job is only claimable when
  `nextAttemptAt IS NULL OR nextAttemptAt <= now()`.
- **Atomic claim (review finding D — HIGH — REQUIRED).** The dispatcher claim MUST be a single
  **atomic conditional `UPDATE` (compare-and-swap)**, never a SELECT followed by a separate
  UPDATE. The claim query shape:
  `UPDATE "SyncJob" SET "lockedAt" = now(), status = 'RETRYING' WHERE id = ? AND ("lockedAt" IS NULL OR "lockedAt" < now() - interval '10 minutes') AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now()) RETURNING id;`
  A worker whose UPDATE returns **0 rows** MUST treat the job as already-claimed (or not yet
  eligible) and abort that job. Without this, two concurrent workers (daily poller + manual
  drain, or two poller instances) can both read the same unlocked PENDING row, both pass the
  dedup pre-check, and both issue the KRS INSERT — the `@unique` on `idempotencyKey` does NOT
  protect here because both workers hold the SAME single SyncJob row's id. A `SELECT`-then-
  `UPDATE` claim is **explicitly forbidden**.
- **Dedup depends on the atomic claim (review finding D2 — HIGH, restated for §7.2).** The §7.2
  dedup pre-check (read for an existing `SYNCED` row with the same key) is a read-then-act
  pattern that is only race-safe BEHIND the atomic claim above. Once a job is exclusively
  claimed, only one worker reaches the dedup read for that job, so the read-then-act is safe.
  This dependency is also noted inline in §7.2.
- **Stale-lock reclaim (review finding D-stale — MED — specified).** A worker that crashes after
  setting `lockedAt` but before clearing it would otherwise leave the job stuck in `RETRYING`
  forever. The claim query above reclaims any lock older than **10 minutes** (generous above any
  expected KRS round-trip) via the `"lockedAt" < now() - interval '10 minutes'` clause. A
  reclaimed-stale job has `attempts` **NOT incremented** (the crashed worker never actually
  completed an attempt) and `lockedAt` reset by the claim. `RETRYING` (including in-flight/
  recently-reclaimed jobs) is therefore self-healing; see the NavRail note below.
- **Locking summary:** `lockedAt` prevents two dispatch passes (or the daily poller + a manual
  drain) from claiming the same job. A claim sets `lockedAt`; a stale lock (>10 min) is
  reclaimable by the atomic claim.
- **Manual retry / skip:** an admin retry resets `attempts`/`nextAttemptAt` and re-enqueues; a
  skip marks `SKIPPED` with a reason — both already exist as simulated actions in
  `src/app/api/sync-jobs/[id]/route.ts` and become real in P2.
- **`FAILED`** is terminal (until manual retry) and is what the NavRail failed-job badge counts.
  `RETRYING` jobs are self-healing (stale locks reclaimed at 10 min), so the badge counting
  `FAILED`-only is **by design** — a stuck-forever `RETRYING` job cannot exist once stale-lock
  reclaim is implemented. (If P2 wants extra visibility, it MAY also surface a count of jobs that
  have been `RETRYING` beyond the reclaim window, but that is optional.)
- **`syncMode` gating (review finding sync-mode — LOW → moved to §11).** How `syncMode`
  (`realtime` / `daily` / `manual`) gates dispatcher behavior is an open question for the owner
  (§11 Q9); P2 MUST NOT default to "always dispatch immediately" without resolving it.

---

## 9. `mssql` Package Version + Dev Verification

### 9.1 `mssql` package version

- Recommend pinning **`"mssql": "^11.0.0"`** (current stable major as of 2026). The exact patch
  is confirmed/locked at P1 install time (`npm install mssql` → record the resolved version in
  `package.json` + lockfile).
- `mssql` v11+ bundles `tedious` (the TDS driver) — **no separate `tedious` install needed**.
- Pin a single major to avoid surprise breaking changes; the connection config is built
  server-side from `KrsConnectionSettings` (host, port, user, decrypted password, database,
  `options.encrypt` from `ssl`).

### 9.2 Dev verification approach for P1

- The owner has a **real KRS test SQL Server channel** (host/port/db/creds supplied via the
  Admin UI at P1 verification). This is the authoritative dev/verify target.
- Before the owner instance is available, P1 can be developed/tested against an **ephemeral
  Docker** SQL Server:

  ```
  docker run -e "ACCEPT_EULA=Y" -e "SA_PASSWORD=<DevPass123!>" \
    -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
  ```

  Then seed a **mock KRS schema** (tables: `sales`, `sale_items`, `stock_movements`,
  `products`, optionally `price_list`, `stock_balance`, `customers`) matching the conceptual
  mapping in §4–§5. This container is **separate** from the project's own Postgres
  docker-compose stack and is **not committed**.
- This Docker mock is sufficient for P1 (connection + introspection + type-check + build).
  **P2–P4 verification gates require the owner's REAL test instance**, not the Docker mock.

---

## 10. Verification Approach for P1–P4

P0 is spec-only (no runtime evidence). Each later phase carries its own runtime gate.

### P1 — Connection Layer + Config UI
- Save KRS settings via the Admin UI → `GET /api/krs/settings` returns settings with
  `passwordSet: true` and **no password value** (masked).
- **Write-path masking assertion (review finding R4):** the `PATCH /api/krs/settings` response
  body contains NO `password` / `encryptedPassword` key and NO cleartext password value (same
  `passwordSet`-only projection as GET).
- Test Connection returns `{ connected: true, latencyMs: <N> }` from the owner's test SQL
  Server (or the Docker dev container).
- DB inspection confirms `KrsConnectionSettings.encryptedPassword` is the
  `v1:iv:authTag:ciphertext` ciphertext blob (with the `v1` version tag — §2.2), **not
  plaintext**.
- **Crypto round-trip + AAD assertion (review findings R1/R3/R6):** encrypt→decrypt returns the
  original password; a blob whose AAD/version is altered, or whose hex segments are malformed,
  fails closed with a clear `corrupt ciphertext` error (not a wrong-slot decrypt).
- **Validation/SSRF-bounds assertion (review finding R2):** PATCH rejects an over-long /
  metachar-laden `host` / `database` / `username` with the `{ code: "VALIDATION" }` contract; a
  `host` change writes a `KRS_SETTINGS_CHANGED` audit row.
- `GET /api/krs/schema` returns real column metadata for the target tables.
- `npm run type-check` + `npm run build` pass.

### P2 — Outbound Transport
- After a POS checkout, a SQL query on the test instance confirms real rows:
  `SELECT TOP 5 * FROM sales ORDER BY created_at DESC;` and matching `sale_items` /
  `stock_movements` rows.
- A `SyncJob` `FAILED → retry → SYNCED` cycle is exercised.
- Replaying the same `idempotencyKey` produces **no duplicate** KRS row (§7 invariant).
- **Atomic-claim concurrency (review findings D/D2):** two dispatchers run concurrently against
  the same PENDING job → exactly ONE KRS INSERT (the loser's atomic claim returns 0 rows and
  aborts). The SyncJob outbox row is created INSIDE the checkout `$transaction` (review finding
  C) — a forced enqueue failure rolls back the Order too (no orphan sale with no sync row).
- **Stale-lock reclaim (review finding D-stale):** a job whose worker is killed mid-dispatch
  (lockedAt set, never cleared) is reclaimed after the 10-min window and re-dispatched, with
  `attempts` not double-counted.
- **Stock reversal (review finding stock-reversal):** a void/refund produces a positive
  `stock_movements` reversal row in KRS (or, if the owner chose KRS-side reversal, the POS sends
  none) — KRS stock matches POS stock after the reversal.
- Killing the connection mid-session: checkout still completes (fail-open) and the queued job
  drains on reconnect.
- Run the `pricing-tester` agent after any change to `src/app/api/orders/route.ts`.
- `npm run type-check` + `npm run build` pass.

### P3 — Inbound Pulls
- Trigger a product pull; count POS products before/after and compare to
  `SELECT COUNT(*) FROM products;` on KRS.
- A repeat pull produces **no duplicate** POS products (upsert on SKU).
- `npm run type-check` + `npm run build` pass.

### P4 — Ops Hardening
- Secrets audit:
  `git grep -nE "KRS_PASS|KRS_USER|encryptedPassword" -- "*.ts" "*.tsx" "*.env*"` returns no
  committed plaintext credential values.
- DB inspection confirms `encryptedPassword` is ciphertext.
- NavRail failed-job badge reflects real `FAILED` rows from P2.
- Full P0–P3 regression on the test instance; `npm run type-check` + `npm run build` pass.

---

## 11. Open Questions for the Owner

These do not block P0 approval but should be resolved at/by P1 introspection:

1. **Conceptual table names:** are `sales`, `sale_items`, `stock_movements`, `products` the
   correct table names in your KRS instance? (Soft confirmation — introspection verifies at
   P1.)
2. **`price_list` / `stock_balance`:** are these separate tables, or columns on `products`?
   (Introspection confirms; the inbound mapper adapts.)
3. **Join key consistency:** is `item_code` the consistent key across `products`, `price_list`,
   and `stock_balance`?
4. **`products.barcode`:** does KRS `products` expose a barcode column to map to
   `Product.barcode`? (Not in the design's 6 inbound rows; would be an extra mapping.)
5. **Tax invoice target:** does a tax-invoice document go to `sales` with a doc-type flag, or a
   separate KRS table?
6. **`vat_code` source:** does the POS have a per-line/per-sale `vat_code` value to map to
   `sales.tax_code` (design row 7, currently unmapped)? If not, this stays unmapped by design.
7. **`Product.vat` gap:** the design maps inbound `products.vat_rate → vat`, but the POS
   `Product` model has no `vat` column. Drop the inbound `vat_rate` mapping, or add a
   `Product.vat` column in a future migration? (No P0 schema change either way.)
8. **Pool/retry tunability:** keep pool sizing and max-attempts/backoff hardcoded (P1/P2
   defaults), or promote them to `KrsConnectionSettings` fields editable from the Admin UI?
9. **`syncMode` dispatcher gating (review finding sync-mode):** how does `syncMode` gate the
   dispatcher? Under **manual**, does the dispatcher refuse to auto-drain (jobs stay `PENDING`
   until an admin triggers an insert-all)? Under **daily**, does it drain only during a
   configured window? Under **realtime**, dispatch immediately post-enqueue? This MUST be
   resolved before the P2 dispatcher is built — P2 must not silently default to "always dispatch
   immediately" regardless of the setting.
10. **Void stock reversal ownership (review finding stock-reversal):** on a void/refund, does the
    POS send a compensating positive `stock_movements` row to KRS (the spec's DEFAULT, §4.1), or
    does KRS independently reverse stock on its own void document (in which case the POS sends
    nothing)? Pick one explicitly at P1 to avoid double-reversal or permanent divergence.
11. **Refund/void sign conventions (review finding refund-sign):** confirm KRS's ledger rules for
    a reversal row — negative `grand_total` + negative `tax_amount`, header-only (no `sale_items`),
    `payment_type` = original tender (§4.3). Confirm partial-refund / mixed-tender handling.

---

## 12. Approval Checkpoint

P0 is complete when the owner has reviewed this spec and approved the contracts below. Until
then P1 does not start.

- [ ] `KrsConnectionSettings` model design approved (§1).
- [ ] AES-256-GCM encryption scheme approved (§2) — key var, stored format, masking, fail-fast.
- [ ] Revised env contract approved (§3) — `KRS_CONFIG_ENC_KEY` only; old `KRS_*` cred vars
      removed.
- [ ] Conceptual outbound mapping approved (§4).
- [ ] Conceptual inbound mapping approved (§5).
- [ ] Introspection approach approved (§6).
- [ ] Idempotency + dedup strategy approved (§7).
- [ ] `SyncJob` outbox extension + fail-open contract + dispatcher state machine approved (§8)
      — **note the post-review changes:** outbox enqueued INSIDE the checkout `$transaction`
      (§8.1), atomic compare-and-swap claim + 10-min stale-lock reclaim (§8.3), non-null
      `idempotencyKey` invariant.
- [ ] `mssql` version + dev verification approach approved (§9).
- [ ] **Adversarial-review changes acknowledged:** AES-GCM AAD + `v1` versioned format (§2),
      SSRF/injection Zod bounds + host-change audit (§1.2.1), refund/void stock-reversal +
      sign conventions (§4). See the P0 report for the full applied/deferred list.
- [ ] Open questions (§11, now 11 items incl. `syncMode` gating, void-reversal ownership, and
      refund sign conventions) reviewed (answers may be deferred to P1 introspection).

**Owner has reviewed and approved this spec. Date: ____________**

---

## 13. Appendix — P1 Deliverables / Touchpoints (for orientation)

P0 produces **no code**. The following is the P1 work this spec unblocks (authoritative scope
lives in the P1 phase plan, written after this spec is approved):

**Functional Connection screen (`/data` Connection tab):**
- Add a **password input** (type=password, autocomplete=new-password) — the field missing from
  the original design.
- Add a **Save** action → `PATCH /api/krs/settings` (admin-only, validated, encrypts password).
- Make **Test Connection** a real server-side call (real latency), replacing the fake React
  state.
- Load saved settings on mount via `GET /api/krs/settings` (password masked as `passwordSet`).
- Flip `src/components/data/connectionTypes.ts` to **SQL Server**: `engine "SQL Server"`,
  default port **1433**, `sqlserver://` connection-string hint (replacing the current MySQL /
  3306 / `203.0.113.45` demo defaults).
- Field Mapping tab (`MappingTab.tsx`) driven by live introspection (`GET /api/krs/schema`),
  replacing the hardcoded static diagram.

**New API routes (all admin-only via `requireAdmin`):**
- `src/app/api/krs/settings/route.ts` — `GET` (masked) + `PATCH` (encrypted write).
- `src/app/api/krs/test-connection/route.ts` — real mssql connect + latency; never logs the
  password.
- `src/app/api/krs/schema/route.ts` — `INFORMATION_SCHEMA.COLUMNS` introspection.

**New library files:**
- `src/lib/krs/crypto.ts` — AES-256-GCM encrypt/decrypt with the fixed AAD + `v1` version tag
  (§2.2–§2.4); fail-fast on missing/wrong-length key; hex-segment validation on decrypt.
- `src/lib/krs/client.ts` — pooled `mssql` `ConnectionPool`; reads params from
  `KrsConnectionSettings`; isolated from the Prisma singleton; **constructs a sanitized error
  before logging — never passes the raw driver error/config to the logger (§2.5, finding R5).**
- `src/lib/krs/index.ts` — public exports for the krs lib.
- `src/lib/schemas/krsSettings.ts` — Zod PATCH-body schema with the §1.2.1 SSRF/injection bounds
  (host ≤253 + charset, database/username bounded + charset, port 1–65535, password 1–256,
  engine/syncMode enums), via the shared `parseBody` helper (review finding R2).

**Schema / config / env:**
- New Prisma migration: `KrsConnectionSettings` singleton model (additive) + a new
  `AuditAction.KRS_SETTINGS_CHANGED` enum value for the host-change audit event (review finding
  R2). Additive only — no existing table altered, no seed broken.
- `npm install mssql` (`^11.x`), recorded in `package.json` + lockfile.
- `src/lib/env.ts` — at most a shape-check for `KRS_CONFIG_ENC_KEY` (no connection-cred vars).
- `.env.example` — add the `KRS_CONFIG_ENC_KEY` placeholder/comment only.

**P1 hard safety constraints (carried from §1–§3 + §8.1):**
- Password encrypted at rest with AES-256-GCM + fixed AAD + `v1` version tag; never plaintext,
  never logged, never returned (read OR write path).
- All KRS routes `requireAdmin`; all fields validated/bounded server-side per §1.2.1 (host/
  database/username length + charset caps — no unbounded field reaches the `mssql` pool).
- `host` (and `port`) changes are written as a `KRS_SETTINGS_CHANGED` audit event.
- KRS client never hands a raw driver error/config to the logger (sanitized error only).
- KRS client strictly separate from `src/lib/prisma.ts`; no cross-engine `$transaction`.
- Fail-fast if `KRS_CONFIG_ENC_KEY` is missing/wrong length.
</content>
</invoke>

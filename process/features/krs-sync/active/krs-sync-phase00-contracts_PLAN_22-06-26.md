# KRS Sync — Phase 0: Contracts / Spec

- Feature: krs-sync
- Phase: P0 of 5 (P0–P4)
- Date: 2026-06-22
- Status: ⏳ PLANNED — IMMEDIATELY ACTIONABLE (UNBLOCKED)
- Plan type: Phase plan (spec-only; no production code)
- Umbrella plan: `process/features/krs-sync/active/krs-sync-program_PLAN_22-06-26.md`
- Grounding source: `process/features/krs-sync/references/krs-sync-grounding_22-06-26.md`
- Owner decision applied: 2026-06-22 (Admin UI config + KrsConnectionSettings + AES-256-GCM + schema introspection)

---

## Objective

Produce a single spec/contract document (`references/krs-sync-spec_P0_22-06-26.md`) that
removes all implementation ambiguity from P1–P4. No production code is written in P0.
The document gates P1 start — no P1 work begins until the owner reviews and approves it.

**P0 is now UNBLOCKED.** The prior hard-dependency on KRS DDL has been removed by the
owner's 2026-06-22 decision: the app will introspect the KRS schema at runtime via
`INFORMATION_SCHEMA` rather than requiring the owner to hand over DDL upfront. P0 therefore
defines the CONCEPTUAL mapping (which POS event → which KRS table) and all engineering
contracts. Exact column names are resolved at P1 runtime.

The spec document answers these concrete questions:
1. What is the `KrsConnectionSettings` model design (fields, singleton pattern, migration shape)?
2. What is the AES-256-GCM encryption scheme (key env var, what is encrypted, IV strategy,
   masking on read, fail-fast behavior)?
3. What is the revised env contract (only `KRS_CONFIG_ENC_KEY` — no connection-cred env vars)?
4. What is the CONCEPTUAL outbound event→table mapping (POS event → KRS table)?
5. What is the CONCEPTUAL inbound mapping (KRS table → POS model)?
6. What is the introspection approach (which tables to query in INFORMATION_SCHEMA)?
7. How is idempotency implemented (key design + dedup strategy)?
8. What does the SyncJob model extension look like (outbox fields)?
9. What is the mssql package version to pin?
10. What is the dev verification approach (ephemeral Docker mssql for P1 dev)?

---

## Hard Dependency — STATUS: REMOVED

~~**The KRS SQL Server target schema (DDL) must be obtained from the owner before P0 can
produce a complete spec.** Without DDL the field-mapping tables are guesses.~~

**RESOLVED (owner decision 2026-06-22):** DDL hand-over is no longer required.
The app will introspect the KRS schema via `INFORMATION_SCHEMA.COLUMNS` at runtime (P1).
P0 defines the conceptual mapping only. Exact column names are verified at P1 via the
introspection endpoint against the owner's real test instance (or a Docker dev container).

P0 is therefore IMMEDIATELY ACTIONABLE with no blocking input from the owner.

The conceptual table targets (minimum set — introspection will discover their columns at P1):
- `sales` — one row per POS sale/refund/tax_invoice
- `sale_items` — one row per line item per sale
- `stock_movements` — one row per stock event (receive, sale-deduction, adjust)
- `products` — source for inbound pull
- `price_list` (may be separate from products — introspection will confirm)
- `stock_balance` (may be separate from products — introspection will confirm)
- `customers` (if it has `tax_id` — inbound tax-customer match)

---

## P0 Scope Boundary

| In scope | Out of scope |
|---|---|
| `KrsConnectionSettings` model design (fields, singleton pattern) | Writing any TypeScript/SQL/migration code |
| AES-256-GCM encryption scheme design (key env var, IV, masking) | Installing npm packages |
| Revised env contract (`KRS_CONFIG_ENC_KEY` only — no cred env vars) | Modifying prisma/schema.prisma |
| CONCEPTUAL outbound event→table mapping (sale→sales/sale_items, stock→stock_movements, etc.) | Touching any src/ file |
| CONCEPTUAL inbound mapping (KRS.products → POS Product) | Making any network calls to KRS |
| Introspection approach design (INFORMATION_SCHEMA query plan for P1) | Updating process/context/all-context.md |
| Idempotency key design + dedup strategy | P1–P4 planning (done at phase entry for each) |
| SyncJob outbox extension fields (sketch only) | Any UI or config changes |
| mssql package version recommendation | — |
| Dev verification approach (Docker mssql + mock schema) | — |
| Verification approach for P1–P4 (real instance notes) | — |

---

## Implementation Checklist (P0 — Spec Writing Steps)

All steps produce writing to the spec doc. No code changes.

---

**Step 1 — Design the `KrsConnectionSettings` Model**

Document the Prisma model design for the new `KrsConnectionSettings` singleton.
Mirror the `ShopSettings` pattern (`id @default("singleton")`).

Fields to specify in the model sketch:

| Field | Prisma type | Notes |
|---|---|---|
| id | String @id @default("singleton") | Singleton — only one row ever exists |
| host | String | SQL Server hostname or IP |
| port | Int @default(1433) | Default SQL Server port |
| database | String | Target database name |
| username | String | SQL Server SQL auth username |
| encryptedPassword | String | AES-256-GCM ciphertext + IV encoded together (see Step 2) |
| ssl | Boolean @default(true) | TLS encryption |
| engine | String @default("SQLSERVER") | Fixed value; read-only display in UI |
| syncMode | String @default("realtime") | "realtime" / "daily" / "manual" |
| createdAt | DateTime @default(now()) | — |
| updatedAt | DateTime @updatedAt | — |

Design notes to document in spec:
- The model is created in a NEW Prisma migration at P1 (not P2).
- POS DB (Postgres) stores this model; it only CONTAINS the KRS connection params, not a
  second DB connection. The actual mssql connection is opened in `src/lib/krs/client.ts`.
- On first run (no row exists), the client returns a "not configured" state; Test Connection
  must gracefully return `{connected:false, error:"KRS connection not configured"}`.

---

**Step 2 — Design the AES-256-GCM Encryption Scheme**

Document the encryption design for the password field. P1 implements this as `src/lib/krs/crypto.ts`.

Key decisions to document in spec:

**Key source:**
- Env var: `KRS_CONFIG_ENC_KEY` — 32 bytes, base64-encoded.
- Location: git-ignored `.env` only. `.env.example` documents the name with a placeholder:
  `KRS_CONFIG_ENC_KEY=<generate: openssl rand -base64 32>`.
- Fail-fast rule: if `KRS_CONFIG_ENC_KEY` is absent or not exactly 32 bytes decoded,
  the server must refuse to start (or return a clear error at the encrypt/decrypt callsite)
  rather than silently storing plaintext. Document the exact error message.

**Encryption process (write path):**
1. Generate a fresh 12-byte random IV per write (never reuse IV).
2. Encrypt `plaintext_password` using AES-256-GCM with the decoded key and generated IV.
3. Produce an `authTag` (16 bytes from GCM).
4. Store as a single string: `<iv_hex>:<authTag_hex>:<ciphertext_hex>` in `encryptedPassword`.

**Decryption process (read/connect path):**
1. Split the stored string on `:` to recover IV, authTag, ciphertext.
2. Decrypt using AES-256-GCM; throw if authTag verification fails.
3. Return plaintext password in memory only — never persist, log, or transmit.

**Masking rule (all GET API responses):**
- `encryptedPassword` field is NEVER returned in any API response.
- On `GET /api/krs/settings`, return all other fields; replace password with `"passwordSet": true`
  (boolean indicating whether a password has been saved) or omit entirely.
- Plaintext password is NEVER logged at any log level (info, warn, error).

---

**Step 3 — Define the Revised Env Contract**

Document the complete new env-config contract for the KRS feature.

**IMPORTANT CHANGE from original design:** KRS connection credentials (host, port, database,
username, password) are now stored in `KrsConnectionSettings` DB model, NOT in env vars.

New env vars for KRS (only ONE):

| Var | Format | `.env.example` placeholder | Purpose |
|---|---|---|---|
| `KRS_CONFIG_ENC_KEY` | 32 bytes, base64 | `<generate: openssl rand -base64 32>` | AES-256-GCM key for encrypting KrsConnectionSettings.encryptedPassword |

**REMOVED env vars (from original P0 plan — these are NO LONGER PART OF THE CONTRACT):**
KRS_HOST, KRS_PORT, KRS_DB, KRS_USER, KRS_PASS, KRS_POOL_MIN, KRS_POOL_MAX, KRS_ENCRYPT,
KRS_TRUST_SERVER_CERT, KRS_SYNC_MODE, KRS_MAX_ATTEMPTS, KRS_RETRY_DELAY_MS.

These connection params are now Admin UI fields persisted to `KrsConnectionSettings`.
Pool sizing and retry config may be added to `KrsConnectionSettings` as optional fields
(document in spec whether to include them in the model or hardcode defaults).

Note: `src/lib/env.ts` in P1 only needs to validate `KRS_CONFIG_ENC_KEY`. All other KRS
config comes from the DB at runtime.

---

**Step 4 — CONCEPTUAL Outbound Event→Table Mapping (POS → KRS)**

Document the conceptual mapping: which POS event triggers which KRS write.
Exact column names are NOT required here — they are discovered by P1 introspection.

| POS event | KRS target table(s) | Notes |
|---|---|---|
| Checkout (sale completed) | `sales` (1 header row) + `sale_items` (N line-item rows) | idempotencyKey = `orderNumber + "_SALE"` |
| Stock receive (GRN) | `stock_movements` (1 or N rows per item received) | idempotencyKey = `GRN_ref + "_STOCK"` |
| Refund / void | `sales` (1 row, negative grand_total) | idempotencyKey = `orderNumber + "_REFUND"` or `"_VOID"` |
| Tax invoice request | `sales` (separate document type — owner to confirm target at P1) | idempotencyKey = `orderNumber + "_TAX_INVOICE"` |
| KRS product pull (inbound) | No KRS write; SELECT only | idempotencyKey = `"KRS.products_PULL_" + bangkokYyyymmdd()` |

Field-level notes to document in spec (best-guess from design; exact columns confirmed at P1 introspection):
- `sales`: expected to have a bill-reference column (e.g., `ref_no`), total amount, VAT amount,
  payment type, tax code. Refund rows use same table with negative amount.
- `sale_items`: expected to have SKU/item_code, qty, unit_price, line_total per item.
  One row per `OrderItem`.
- `stock_movements`: expected to have item_code/SKU, qty_delta (+receive, -sale), movement type,
  reference (orderNumber or GRN).
- Money conversion: POS stores amounts in satang (integer). KRS likely expects baht (decimal).
  Document: convert satang ÷ 100 before writing to KRS; confirm baht type from introspection.
- KRS-generated primary key: the seed data shows `krs_id: "BK-48280"` in response. If KRS
  returns an inserted `id`, store it in `SyncJob.response` (already a String? field).

---

**Step 5 — CONCEPTUAL Inbound Mapping (KRS → POS)**

Document the conceptual inbound mapping. Exact columns confirmed at P1 introspection.

| KRS source table | POS target model / field | Notes |
|---|---|---|
| `products` (or `products`+`price_list`+`stock_balance`) | `Product` upsert | Upsert key = SKU/item_code |
| products.item_code (expected) | Product.sku | Match/upsert key |
| products.name_th (expected) | Product.name | Thai product name |
| price_list.unit_price (or products.unit_price) | Product.price (satang) | Convert baht×100; table source confirmed via introspection |
| products.vat_rate (expected) | Product.vat | VAT rate as int (7, 0) |
| stock_balance.on_hand (or products.qty) | Product.stock | Current on-hand; source confirmed via introspection |
| customers.tax_id (if exists) | Customer.taxId | Optional; inbound tax-customer match |

Open questions to flag in spec (answered at P1 introspection):
- Are `price_list` and `stock_balance` separate tables or columns on `products`?
- Is the join key `item_code` consistent across all three potential tables?
- Does `products` have a `barcode` column to map to `Product.barcode`?

---

**Step 6 — Introspection Approach for Field Mapping**

Document the runtime introspection design that replaces the DDL requirement.

**What P1's `GET /api/krs/schema` does:**
1. Opens an mssql connection using `KrsConnectionSettings` params.
2. Queries `INFORMATION_SCHEMA.COLUMNS` for the target tables.
3. Returns a JSON map of `{ tableName: [{ columnName, dataType, isNullable, maxLength, numericPrecision, numericScale }] }`.
4. The Field Mapping tab (`MappingTab.tsx`) fetches this endpoint and displays real column
   metadata instead of the current hardcoded static diagram.

**Tables to introspect (minimum):** `sales`, `sale_items`, `stock_movements`, `products`.
Also attempt: `price_list`, `stock_balance`, `customers` — include in result if found.

Document the suggested INFORMATION_SCHEMA query in the spec (for P1 implementation reference):
```sql
SELECT
  TABLE_NAME, COLUMN_NAME, DATA_TYPE,
  CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, IS_NULLABLE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME IN ('sales','sale_items','stock_movements','products',
                     'price_list','stock_balance','customers')
ORDER BY TABLE_NAME, ORDINAL_POSITION;
```

Note: this query is SQL Server-compatible syntax (standard INFORMATION_SCHEMA).

---

**Step 7 — Idempotency Design**

Document the chosen idempotency strategy. Same as original P0 design — no changes.

**Key:** `orderNumber + "_" + jobType` (e.g., `"POS-20260616-0041_SALE"`, `"GRN-20260616-007_STOCK"`)

Key design decisions to document:
- Where stored: `SyncJob.idempotencyKey` (new field in P2 migration; `@unique` index).
- Dedup check: before every KRS INSERT attempt, query `SyncJob` for an existing SYNCED row
  with the same `idempotencyKey`. If found, skip INSERT and mark current job SKIPPED.
- Alternative (KRS-side): if KRS tables have a `ref_no` unique constraint, catch SQL
  constraint violation and treat as successful idempotent insert. Document both; spec chooses one.
- Pull idempotency key: `"KRS.products_PULL_" + bangkokYyyymmdd()` (daily granularity).
- Tax invoice key: `orderNumber + "_TAX_INVOICE"`.

---

**Step 8 — Fail-Open Outbox: SyncJob Model Extension Design**

Document the new fields to add to `SyncJob` in the P2 migration. Same as original P0 design.

Current `SyncJob` fields (from `prisma/schema.prisma` ~L43–56):
id, type, direction, ref, amount, status, provider, error, response, branchId, createdAt, updatedAt

New fields needed for real outbox (sketch for P2 migration):

| Field | Type | Default | Purpose |
|---|---|---|---|
| payload | Json? | null | Full POS row snapshot at enqueue time (Order or StockMovement JSON). Avoids re-querying POS DB at dispatch time. |
| idempotencyKey | String? | null | `orderNumber + "_" + jobType`; `@unique` index for dedup. |
| attempts | Int | 0 | Retry counter. Max attempts = configurable (hardcoded default 5 for now; KrsConnectionSettings may expose this later). |
| lastError | String? | null | Last error message / SQL error string from failed attempt. |
| nextAttemptAt | DateTime? | null | Retry backoff: null = eligible immediately; set to future timestamp on failure. |
| lockedAt | DateTime? | null | Optimistic concurrency for dispatcher: set when job being dispatched; cleared on success or failure. Prevents double-dispatch. |

Migration design notes:
- All new fields are nullable (or have defaults) — no existing seed data broken.
- `idempotencyKey` gets `@unique` index.
- `lockedAt` enables safe concurrent dispatch (relevant for daily poller).
- ADDITIVE migration only; no existing data altered.

---

**Step 9 — mssql Package Version + Dev Verification Approach**

**mssql version:**
- Document the current stable major version of `mssql` npm package (confirm at P0 execution time).
- As of 2026 the current stable is v11. Confirm and record the exact `"mssql": "^11.x.x"` to pin.
- Note: `mssql` v11+ uses `tedious` as the underlying TDS driver; no separate `tedious` install needed.

**Dev verification approach for P1:**
- Owner has a real KRS test SQL Server channel (to be supplied at P1 verification).
- For dev (before owner instance available), P1 can be tested against an ephemeral Docker container:
  ```
  docker run -e "ACCEPT_EULA=Y" -e "SA_PASSWORD=<DevPass123!>" \
    -p 1433:1433 mcr.microsoft.com/mssql/server:2022-latest
  ```
  Then create a mock KRS schema (tables: sales, sale_items, stock_movements, products) matching
  the conceptual mapping in Steps 4–5. This docker instance is SEPARATE from the project's
  postgres docker-compose stack and is not committed.
- P2–P4 verification gates require the owner's real test instance (not the Docker mock).

---

**Step 10 — Verification Approach for P1–P4**

Document in the spec how each subsequent phase will be verified:

- **P1 (Connection + Config UI):** Save KRS settings via Admin UI → GET returns settings with
  password masked → Test Connection returns `{connected:true, latencyMs:<N>}` from owner's
  test SQL Server (or Docker dev container). DB row confirms `encryptedPassword` is ciphertext
  (not plaintext). Introspection endpoint returns real column metadata for target tables.
  `npm run type-check` + `npm run build` pass.
- **P2 (Outbound):** SQL query against test instance after POS checkout confirms real rows.
  Recommended query: `SELECT TOP 5 * FROM sales ORDER BY created_at DESC` (SQL Server syntax).
- **P3 (Inbound):** count of POS products before and after pull; query `SELECT COUNT(*) FROM products`
  in KRS and compare to upserted count in POS.
- **P4 (Ops):** `git grep -r "KRS_PASS\|KRS_USER\|encryptedPassword" -- "*.ts" "*.tsx" "*.env*"`
  must return no committed plaintext values; DB inspection confirms ciphertext; `npm run
  type-check && npm run build` pass clean.

---

**Step 11 — Write the Spec Document**

Write the completed spec to:
`process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md`

The spec document must contain (ordered sections):
1. `KrsConnectionSettings` model design (fields table, singleton pattern, migration phase).
2. AES-256-GCM encryption scheme (key env var, encrypt process, decrypt process, masking rule,
   fail-fast rule, `.env.example` placeholder format).
3. Revised env contract (only `KRS_CONFIG_ENC_KEY`; removed KRS_* cred env vars).
4. CONCEPTUAL outbound event→table mapping table (sale, stock, refund, tax_invoice → KRS tables).
5. CONCEPTUAL inbound mapping table (KRS tables → POS Product model).
6. Introspection approach (INFORMATION_SCHEMA query, tables to introspect, response shape).
7. Idempotency design (key scheme, dedup strategy, chosen approach).
8. SyncJob outbox extension fields table (from Step 8).
9. mssql package version recommendation + dev Docker verification approach.
10. Verification approach for P1–P4 (from Step 10).
11. Open questions for owner (anything still unresolved after conceptual mapping).
12. Approval checkpoint: `[ ] Owner has reviewed and approved this spec. Date: ___`.

---

**Step 12 — Write Phase 0 Report**

After completing the spec document, write:
`process/features/krs-sync/reports/krs-sync-phase00-contracts_REPORT_22-06-26.md`

The report must record:
- Date of P0 execution
- Confirmation that DDL dependency was removed (introspection approach adopted)
- Approval status (approved / pending owner review)
- Any deviations from this plan
- Recommended next action: `P1 plan ready to write once owner approves spec`

---

## Touchpoints (P0 only — spec doc files)

| File | Action |
|---|---|
| `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md` | CREATE (primary deliverable) |
| `process/features/krs-sync/reports/krs-sync-phase00-contracts_REPORT_22-06-26.md` | CREATE (phase report) |

**NO src/ files touched in P0. NO prisma/schema.prisma changes. NO npm installs.**

---

## Acceptance Criteria (P0)

P0 is `✅ VERIFIED` when ALL of the following are true:

1. `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md` exists and is complete.
2. The spec contains the `KrsConnectionSettings` model design (fields, singleton, migration phase).
3. The spec contains the full AES-256-GCM encryption scheme (key, IV, authTag, masking rule,
   fail-fast rule, `.env.example` placeholder).
4. The spec contains the revised env contract (only `KRS_CONFIG_ENC_KEY`; old KRS_* vars removed).
5. The spec contains the CONCEPTUAL outbound event→table mapping table.
6. The spec contains the CONCEPTUAL inbound mapping table.
7. The spec contains the introspection approach (INFORMATION_SCHEMA query design).
8. The spec contains the idempotency key design and dedup strategy.
9. The spec contains the SyncJob outbox extension field table.
10. The spec contains the mssql package version recommendation.
11. The spec contains the dev Docker verification approach for P1.
12. The spec contains the verification approach for P1–P4.
13. The spec has an approval checkpoint section (filled in or marked "pending owner review").
14. The phase report exists and records outcome + approval status.
15. **No production code has been written or modified.**

P0 gates P1: P1 MUST NOT start until criteria 1–14 above are met AND the owner has approved
the spec (or explicitly grants conditional P1 approval).

---

## Blockers (P0)

None. P0 is UNBLOCKED as of the 2026-06-22 owner decision.

~~KRS DDL not provided~~ — REMOVED. Schema introspection replaces DDL hand-over.

Residual watch items (not blockers):
- Owner must confirm the conceptual table targets (sales, sale_items, stock_movements, products)
  are correct names in their KRS instance — this is a soft confirmation at P0 approval, not
  a hard prerequisite.
- Owner must supply test SQL Server credentials (host/port/db/user/pass) before P1 can be
  VERIFIED (not needed for P0 or P1 development).

---

## Failure Modes (P0)

| Failure | Response |
|---|---|
| Owner cannot review spec promptly | Document as "pending owner review"; P1 does NOT start until approved |
| Owner identifies different table names in their KRS instance | Update the conceptual mapping table in spec; adjust introspection query table list |
| Owner wants additional encryption requirements (e.g., field-level for username too) | Document in spec as an extension decision; update model design accordingly |

---

## Dependencies (P0)

| Dependency | Status | Notes |
|---|---|---|
| ~~KRS DDL from owner~~ | RESOLVED (REMOVED) | Introspection replaces DDL at P1 runtime |
| Design field-mapping rows (conceptual baseline) | RESOLVED | `design/Simple POS.dc.html` L1742–1759 + Connection screen fields |
| Grounding research | RESOLVED | `process/features/krs-sync/references/krs-sync-grounding_22-06-26.md` |
| SyncJob current schema | RESOLVED | `prisma/schema.prisma` L43–56 |
| ShopSettings singleton pattern | RESOLVED | `prisma/schema.prisma` (mirror this pattern for KrsConnectionSettings) |
| mssql package research | OPEN at P0 | Confirm current stable major version at execution time |
| Owner decision on KrsConnectionSettings design | RESOLVED | 2026-06-22: singleton; fields as specified; AES-256-GCM for password |

---

## Resume and Execution Handoff

**To execute P0:**
Pass this file (`process/features/krs-sync/active/krs-sync-phase00-contracts_PLAN_22-06-26.md`)
to a research/writing subagent (NOT a code-execution subagent). P0 is a spec-writing phase only.

**Subagent instructions:**
1. Read this plan file in full.
2. Read the grounding doc: `process/features/krs-sync/references/krs-sync-grounding_22-06-26.md`.
3. Read `prisma/schema.prisma` to confirm current SyncJob fields and ShopSettings singleton pattern.
4. Work through Steps 1–11 in order (no blocking human interaction needed — DDL dependency removed).
5. Write the spec doc to `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md`.
6. Write the phase report to `process/features/krs-sync/reports/krs-sync-phase00-contracts_REPORT_22-06-26.md`.
7. Do NOT write or modify any file outside `process/features/krs-sync/references/` and `process/features/krs-sync/reports/`.
8. Do NOT install packages, modify source files, or create migrations.
9. End with a clear statement of whether P0 is VERIFIED or PARTIAL, and what the next action is.

**After P0 is VERIFIED:**
The orchestrator writes the P1 phase plan:
`process/features/krs-sync/active/krs-sync-phase01-connection_PLAN_22-06-26.md`
(P1–P4 plans are NOT written until the prior phase is verified — avoids stale specs.)

---

## Validation Commands (P0 — no runtime commands; only artifact checks)

```
# Confirm spec doc exists
ls process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md

# Confirm phase report exists
ls process/features/krs-sync/reports/krs-sync-phase00-contracts_REPORT_22-06-26.md

# Confirm no src/ files were touched (should be empty diff)
git diff --name-only src/

# Confirm no prisma/schema.prisma changes
git diff prisma/schema.prisma

# Confirm no package.json changes
git diff package.json
```

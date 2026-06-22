# KRS Sync — Umbrella Program Plan (Phase Program)

- Feature: krs-sync
- Date: 2026-06-22
- Complexity: COMPLEX / Phase Program (5 phases: P0–P4)
- Status: P0 IMMEDIATELY ACTIONABLE (UNBLOCKED) · P1–P4 sequenced (each gate-locked on prior phase)
- Plan type: Umbrella / Orchestration
- Grounding source: `process/features/krs-sync/references/krs-sync-grounding_22-06-26.md`
- Owner decision applied: 2026-06-22 (config from Admin UI + KrsConnectionSettings model + AES-256-GCM + schema introspection)

---

## Program Goal Charter

```
# KRS Sync — Program Goal Charter

North star:
- Replace the fully-simulated KRS state machine with a real, bidirectional MS SQL Server
  transport: POS sales/stock/refunds are written to KRS durably via an outbox+retry queue
  (fail-open, never blocking checkout), and KRS products are pulled back to POS on demand —
  end-to-end from a real Admin-UI-configured connection to real SQL Server rows.

Definition of done (the unattended agent must be able to do all of these after program completion):
1. Open the /data Connection tab as Admin; enter KRS SQL Server credentials (host, port, database,
   username, password, SSL); click Save; click Test Connection; see a real "connected / latency"
   result against the owner's test instance.
2. Complete a POS checkout; observe a real INSERT row appearing in KRS.sales + KRS.sale_items
   within the configured sync window (realtime or daily batch).
3. Complete a stock receipt (GRN); observe a real INSERT in KRS.stock_movements.
4. Issue a refund/void; observe the matching KRS.sales row inserted with negative amount.
5. Trigger a KRS product pull; observe POS Product catalog updated from KRS.products data.
6. Kill the SQL Server connection mid-session; confirm checkout still completes (fail-open);
   confirm the queued SyncJob drains on reconnect.
7. Replay a job with the same idempotencyKey; confirm no duplicate row in KRS.
8. Observe the NavRail failed-job badge count driven by real FAILED rows (not simulated).

What "verified" means (program level):
- Each phase gate passes with recorded evidence (SQL query output, HTTP response logs, or
  npm run type-check + npm run build green) against the owner's real test SQL Server instance
  (not ephemeral or mocked). P0 is spec-only (no runtime evidence required). P1–P4 require
  runtime evidence on the real connection.

Scope tiers → phase mapping:
- Tier 1 (Foundation — contracts + connection): P0, P1
- Tier 2 (Core transport — outbox + real writes): P2
- Tier 3 (Inbound + full bidirectionality): P3
- Tier 4 (Ops hardening — secrets, alerting, runbook): P4
- This program retires Tiers 1–4.

Explicitly out of scope (deferred):
- Full visual redesign of the /data Connection/Mapping tabs (cosmetic overhaul is a separate
  design task; P1 adds only the missing password field + Save + real Test Connection).
- Multi-branch KRS routing (all P0–P4 work targets a single branchId BR-01 target).
- Windows Authentication / Kerberos (only SQL Server SQL auth via Admin UI creds is in scope).
- Real-time webhook/push FROM KRS (inbound is pull-on-demand only, per design).
- CI/CD pipeline changes or production deployment automation.
- The P6c Design Spec docs hub (/docs placeholder) — separate P6c work.

Hard safety constraints (non-negotiable, per phase):
- NEVER commit real SQL Server credentials. Creds are stored in the DB (KrsConnectionSettings,
  password AES-256-GCM encrypted) and loaded at runtime only; they must never appear in any
  committed file, log output, or API response body.
- KRS_CONFIG_ENC_KEY (32-byte base64) goes in git-ignored .env only; .env.example documents
  the name with a placeholder only. If the key is absent at startup, the app must fail-fast
  with a clear error (do not fall back to plaintext).
- NEVER allow a KRS write failure to block or roll back a POS checkout. Fail-open is
  an architectural invariant — enqueue and return success to the cashier.
- NEVER enlist KRS (mssql) writes in the POS Prisma $transaction — cross-engine transaction
  participation is impossible and attempting it corrupts the checkout.
- NEVER use the Prisma singleton (src/lib/prisma.ts) for the KRS mssql client — maintain
  strict separation between the two database connections at all times.
- Password field is NEVER returned in any GET API response (masked/omitted). Plaintext
  password is NEVER logged at any log level.
- Test Connection, schema introspection, and KrsConnectionSettings GET/PATCH are admin-only
  (requireAdmin middleware). Validate + bound all fields server-side before use.
- Keep process/plan/context commits separate from execution commits; commit each phase
  before advancing to the next.
- Do not widen scope across phases — P0 is spec-only, no code; P1 is connection layer only;
  P2 is outbound only; P3 is inbound only; P4 is ops hardening only.
```

---

## Overview

**What this program does:** replaces the KRS transport from a fully-simulated state machine
(canned responses, zero network calls) to a real MS SQL Server bidirectional transport,
configured from the Admin UI Connection tab.

**Current state (source: grounding doc):**
- `/data` Connection tab: `INITIAL_DB_STATE` in `src/components/data/connectionTypes.ts` is
  hardcoded (engine=`"MySQL"`, host RFC5737 placeholder, port `3306`). Never persisted.
- Connection form has no password field and no Save action.
- `SyncJob` mutations (insert-all, retry, pull) in `src/app/api/sync-jobs/route.ts` return
  canned responses. TODO comment at L25 explicitly calls out "production-readiness: real KRS
  transport, idempotency on insert-all".
- `prisma/schema.prisma` comment at L38: "SIMULATED state machine — there is NO real KRS
  transport in P6".

**Target state after program:** all five phases green; see Definition of Done above.

**Cross-engine constraint:** Prisma 5 is PostgreSQL-provider-locked; the KRS SQL Server
client MUST be a separate npm `mssql`/`tedious` driver at `src/lib/krs/` — never the Prisma
singleton. KRS writes cannot participate in POS Prisma `$transaction`.

---

## Phase Sequence and Dependencies

```
P0 (Contracts/Spec) ─────────────────────────────────────── IMMEDIATELY ACTIONABLE (UNBLOCKED)
  Deliverable: spec doc (references/). No code.
  DDL hard-dependency REMOVED: schema introspected at runtime via INFORMATION_SCHEMA.
  P0 defines the CONCEPTUAL mapping (POS event → KRS table) + all contracts.
  Gate: owner reviews and approves conceptual mapping + SyncJob extension + env contract
        + KrsConnectionSettings model + AES-256-GCM scheme.

P1 (Connection Layer + Config UI) ──────────────────────── BLOCKED until P0 approved
  Deliverable: KrsConnectionSettings model + migration; AES-256-GCM encryption util;
               GET/PATCH settings API (admin-only, password masked on read);
               mssql driver + pooled client; real Test Connection endpoint (real latency);
               KRS schema introspection endpoint; functional Connection UI (password field,
               Save, real Test Connection, SQL Server defaults).
  Dependency: P0 spec doc approved + owner's test SQL Server channel available.

P2 (Outbound Transport) ────────────────────────────────── BLOCKED until P1 green
  Deliverable: durable outbox extension on SyncJob + dispatcher + real mssql writes.
  Dependency: P1 real connection verified on owner's test instance.

P3 (Inbound Pulls) ─────────────────────────────────────── BLOCKED until P2 green
  Deliverable: real product pull (KRS.products → POS upsert).
  Dependency: P2 outbound transport verified.

P4 (Ops Hardening) ─────────────────────────────────────── BLOCKED until P3 green
  Deliverable: secrets audit, failed-job alerting live, field-mapping UI wired, runbook.
  Dependency: P3 full bidirectional transport verified.
```

---

## Phase Scopes

### P0 · Contracts / Spec (IMMEDIATELY ACTIONABLE — UNBLOCKED)

**Goal:** produce a single spec/contract document in `references/` that removes all
ambiguity from P1–P4 before any code is written.

**What changed from original P0 (owner decision 2026-06-22):**
- DDL hard-dependency REMOVED. Schema introspection via `INFORMATION_SCHEMA` at runtime replaces
  the DDL-hand-over requirement. P0 is therefore UNBLOCKED — no DDL needed before starting.
- P0 defines the CONCEPTUAL mapping (which POS event maps to which KRS table), not exact columns.
  Exact columns are discovered by P1's introspection endpoint.
- New items added to P0 scope: `KrsConnectionSettings` model design (singleton pattern),
  AES-256-GCM password encryption scheme (key env var, what is encrypted, masking on read),
  `KRS_CONFIG_ENC_KEY` env var contract (the ONLY new env var; connection params move to DB).

**Scope:**
- Design the `KrsConnectionSettings` model (singleton, mirror `ShopSettings` pattern:
  `id @default("singleton")`). Fields: host, port, database, username, encryptedPassword,
  ssl (bool), engine (fixed = "SQLSERVER"), syncMode (realtime/daily/manual), timestamps.
- Document the AES-256-GCM encryption scheme: key = `KRS_CONFIG_ENC_KEY` (32-byte base64 from
  `.env`); what is encrypted (password only); IV generated fresh each write, stored alongside
  ciphertext; masking rule on read (password field omitted/replaced with `"***"` in all GET
  responses); fail-fast if key absent.
- Define CONCEPTUAL outbound event→table mapping:
  sale/checkout → KRS.sales + KRS.sale_items;
  stock-receive (GRN) → KRS.stock_movements;
  refund/void → KRS.sales (negative amount);
  tax_invoice → KRS.sales (separate document type, owner to confirm target).
- Define CONCEPTUAL inbound mapping: KRS.products (+ price_list, stock_balance) → POS Product upsert.
- Define introspection approach: P1 reads `INFORMATION_SCHEMA.COLUMNS` to discover actual column
  names at runtime; the Field Mapping tab is fed by this introspection result.
- Design idempotency strategy: key = `orderNumber + jobType`; dedup check before INSERT.
- Design fail-open outbox model: SyncJob extension fields (payload, idempotencyKey, attempts,
  lastError, nextAttemptAt, lockedAt).
- Define env contract: only ONE new env var (`KRS_CONFIG_ENC_KEY`). Connection params (host,
  port, db, user, password, ssl, syncMode) are now stored in `KrsConnectionSettings` DB model,
  NOT in `.env`. Remove the KRS_HOST/KRS_PORT/KRS_DB/KRS_USER/KRS_PASS vars from env contract.
- Note verification approach for P1–P4 (real test instance OR ephemeral
  `mcr.microsoft.com/mssql/server` Docker container with mock KRS schema for dev).

**Gate:** owner reviews spec doc + approves conceptual field mapping + approves
KrsConnectionSettings model + approves AES-256-GCM scheme + approves SyncJob extension shape.

**Deliverable:** `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md`

**No code produced in P0.** See Phase 0 plan for detailed step sequence.

---

### P1 · Connection Layer + Config UI (functional screen)

**Goal:** install the mssql driver; create the `KrsConnectionSettings` model + migration +
encryption util; wire the Admin Connection UI (password field, Save, real Test Connection,
SQL Server defaults); add schema introspection endpoint feeding the Field Mapping tab.

**What changed from original P1 (owner decision 2026-06-22):**
- No longer reads connection params from `.env`. Reads from `KrsConnectionSettings` DB model.
- New Prisma migration for `KrsConnectionSettings` singleton model (P1, not P2).
- New `src/lib/krs/crypto.ts` — AES-256-GCM encrypt/decrypt util using `KRS_CONFIG_ENC_KEY`.
- New `GET /api/krs/settings` + `PATCH /api/krs/settings` — admin-only, password masked on GET,
  encrypted on PATCH write.
- Connection UI gains: password input (type=password), Save button (calls PATCH settings),
  real Test Connection (calls server-side endpoint using saved/entered params, returns real
  latency), SQL Server defaults (engine fixed "SQL Server", port 1433, `sqlserver://` hint).
- New `GET /api/krs/schema` — admin-only; opens mssql connection, queries
  `INFORMATION_SCHEMA.COLUMNS` for configured tables, returns column metadata to Field Mapping tab.
- `src/lib/env.ts` now only validates `KRS_CONFIG_ENC_KEY` (not the old KRS_HOST/PORT/DB/USER/PASS).
- `.env.example` adds `KRS_CONFIG_ENC_KEY=<32-byte-base64-placeholder>` comment only.

**Scope:**
- `npm install mssql` (add to package.json). Pin version per P0 spec.
- New Prisma migration: `KrsConnectionSettings` singleton model.
- `src/lib/krs/crypto.ts` — AES-256-GCM encrypt/decrypt; fail-fast if key absent.
- `src/lib/krs/client.ts` — pooled ConnectionPool; reads connection params from
  `KrsConnectionSettings` DB model at connection time; singleton pattern.
- `src/lib/krs/index.ts` — public exports from the krs lib.
- Update `src/lib/env.ts` — validate `KRS_CONFIG_ENC_KEY` only (not connection params).
- Update `.env.example` — add `KRS_CONFIG_ENC_KEY` placeholder only.
- `GET /api/krs/settings` (admin-only) — returns KrsConnectionSettings with password masked.
- `PATCH /api/krs/settings` (admin-only, validated) — encrypts password, writes to DB.
- Flip `src/components/data/connectionTypes.ts` — engine "SQL Server", port 1433,
  host placeholder → SQL Server format hint, `sqlserver://` prefix.
- `src/app/api/krs/test-connection/route.ts` (admin-only) — accepts optional overrides
  (for "test before save" UX), opens real mssql connection, measures latency, returns
  `{ connected, latencyMs, error }`. NEVER logs password.
- `src/app/api/krs/schema/route.ts` (admin-only) — queries INFORMATION_SCHEMA, returns
  table→columns map for tables: sales, sale_items, stock_movements, products.
- Update `src/components/data/ConnectionTab.tsx`:
  - Load saved settings via GET /api/krs/settings on mount.
  - Add password input (type=password, autocomplete=new-password).
  - Add Save button (calls PATCH /api/krs/settings).
  - Wire Test Connection button to real server-side endpoint (replaces fake React state).
  - Display real status/latency from endpoint response.
- Update `src/components/data/MappingTab.tsx` (or the field mapping panel) — fetch
  `/api/krs/schema` to populate Field Mapping from real introspection data.
- Verification gate: `npm run type-check` + `npm run build` pass; Save → Test Connection
  returns real `{connected:true, latencyMs:<N>}` from owner's test SQL Server (or
  ephemeral Docker mssql container for dev); introspection returns real column metadata.

**Dependency:** P0 spec doc approved + owner's test SQL Server channel (or Docker dev instance) available.

---

### P2 · Outbound Transport (Core)

**Goal:** implement the durable outbox + dispatcher; replace simulated `insert-all`/`retry`/
`pull` routes with real mssql writes for all outbound job types.

**What changed from original P2:** connection params now come from `KrsConnectionSettings`
DB model (via `src/lib/krs/client.ts`), not from env vars directly. No other scope change.

**Scope:**
- New Prisma migration (phase P2): extend `SyncJob` model with outbox fields (payload,
  idempotencyKey, attempts, lastError, nextAttemptAt, lockedAt). Field names per P0 spec.
- `src/lib/krs/mapper.ts` — POS Order/StockMovement → KRS row shape. Column names
  informed by P1 introspection results (documented in P0 spec as conceptual mapping;
  exact column names verified at P1).
- `src/lib/krs/dispatcher.ts` — real-time push attempt + retry/backoff; reads next pending
  job, maps it, executes mssql INSERT with idempotency dedup, updates SyncJob status.
- Poller entry point for daily/batch mode (configurable via `syncMode` in KrsConnectionSettings).
- Update `POST /api/orders/route.ts` — after transaction commit, enqueue SyncJob(SALE) +
  SyncJob(STOCK) items; never await the KRS write. FAIL-OPEN.
- Update `POST /api/stock-movements/route.ts` — enqueue SyncJob(STOCK) on receive-stock.
- Update `PATCH /api/orders/[id]/route.ts` — enqueue SyncJob(REFUND/VOID) on refund/void.
- Replace simulated `POST /api/sync-jobs` `action=insert-all` with real dispatcher drain.
- Replace simulated `PATCH /api/sync-jobs/[id]` retry with real re-dispatch call.
- Verification gate: end-to-end checkout → real KRS.sales + KRS.sale_items rows visible;
  SyncJob FAILED → retry → SYNCED cycle tested; `npm run type-check` + `npm run build` pass.

**Dependency:** P1 real connection verified.

---

### P3 · Inbound Pulls

**Goal:** implement the real KRS → POS product pull with idempotent upsert.

**What changed from original P3:** none (connection params sourced from DB via client.ts).

**Scope:**
- `src/lib/krs/puller.ts` — executes SELECT against KRS.products (+ price_list, stock_balance
  per P0 conceptual mapping, exact columns from P1 introspection); maps to POS Product shape;
  upserts via Prisma upsertMany per product.
- Update `POST /api/sync-jobs` `action=pull` — call real puller; record SyncJob(PULL) result.
- Idempotency: re-pulling the same data produces no duplicate products (upsert on SKU).
- Verification gate: pull → count of updated/created POS products matches KRS.products count;
  no duplicates on repeat pull; `npm run type-check` + `npm run build` pass.

**Dependency:** P2 outbound transport verified.

---

### P4 · Ops Hardening

**Goal:** close the gap between "real transport works" and "safe to use in production":
secrets audit, live alerting, field-mapping UI wired to real mapping, runbook.

**What changed from original P4:** secrets audit now includes verifying `KrsConnectionSettings`
password is stored encrypted (not plaintext) in the DB; and checking no plaintext password
appears in logs. Env audit scope narrows to `KRS_CONFIG_ENC_KEY` only (not KRS_* cred vars).

**Scope:**
- Secrets audit: verify `.env` is git-ignored; verify `.env.example` has only placeholder value
  for `KRS_CONFIG_ENC_KEY` (no real value); verify no KRS creds in any committed file; verify
  `KrsConnectionSettings.encryptedPassword` is ciphertext in DB (not plaintext).
- Failed-job alerting: NavRail badge (`GET /api/sync-jobs/failed-count`) reflects real FAILED
  rows from P2. Add toast/notification trigger on new FAILED row (optional, configurable).
- Field-mapping UI: `src/components/data/MappingTab.tsx` — confirm it is now wired to P1's
  real introspection data; ensure display-only; no runtime mutation needed.
- Context update: update `process/context/all-context.md` KRS sync section.
- Runbook: `process/features/krs-sync/references/krs-sync-runbook_P4_22-06-26.md` — how to
  update KRS connection settings via Admin UI, rotate credentials, rotate `KRS_CONFIG_ENC_KEY`,
  drain a stuck queue, check FAILED jobs.
- Verification gate: full P0–P3 regression check; `npm run type-check` + `npm run build` pass;
  no KRS creds visible in git history or DB plaintext.

**Dependency:** P3 inbound pulls verified.

---

## Cross-Cutting Decisions (Baked In — Do Not Relitigate)

| Decision | Value |
|---|---|
| Transport direction | Bidirectional (outbound + inbound) |
| Config source | Admin UI → `KrsConnectionSettings` DB singleton (NOT env vars for creds) |
| Sync mode | Realtime + daily batch + manual; stored in KrsConnectionSettings.syncMode |
| Fail-open | YES — checkout never blocks on KRS; enqueue + retry |
| DB engine | MS SQL Server (not MySQL); driver = npm mssql / tedious |
| Connection-string format | mssql config-object built server-side from KrsConnectionSettings |
| Idempotency key | `orderNumber + jobType` (e.g., "POS-20260616-0041_SALE") |
| Cross-engine transaction | IMPOSSIBLE — KRS writes are eventual-consistency only |
| Auth method | SQL Server SQL auth (username + password) stored in KrsConnectionSettings |
| Password at rest | AES-256-GCM encrypted; key = `KRS_CONFIG_ENC_KEY` env var (32-byte base64) |
| Password on read | ALWAYS masked/omitted in GET responses; NEVER logged |
| New env vars | `KRS_CONFIG_ENC_KEY` only (no KRS_HOST/PORT/DB/USER/PASS env vars) |
| KRS client location | `src/lib/krs/` — completely separate from `src/lib/prisma.ts` |
| POS Prisma singleton | Untouched; postgres-only; NEVER used for KRS |
| Schema discovery | Runtime introspection via INFORMATION_SCHEMA (no DDL hand-over needed) |
| Connection UI | Admin-only; password input added; Save persists to DB; Test Connection is real |
| Fail-fast on missing enc key | YES — if KRS_CONFIG_ENC_KEY absent, server returns clear error |

---

## Touchpoints (Files Affected Across Program)

| File | Phases | Change |
|---|---|---|
| `src/components/data/connectionTypes.ts` | P1 | MySQL→SQL Server defaults (engine, port 1433, sqlserver:// hint) |
| `src/components/data/ConnectionTab.tsx` | P1 | Add password input, Save action, real Test Connection, load saved settings |
| `src/components/data/MappingTab.tsx` | P1, P4 | P1: wire to introspection API; P4: confirm wired |
| `src/lib/krs/crypto.ts` | P1 | NEW — AES-256-GCM encrypt/decrypt util |
| `src/lib/krs/client.ts` | P1 | NEW — pooled mssql client; reads from KrsConnectionSettings |
| `src/lib/krs/index.ts` | P1 | NEW — public exports |
| `src/lib/krs/mapper.ts` | P2 | NEW — POS→KRS field mapper |
| `src/lib/krs/dispatcher.ts` | P2 | NEW — outbox dispatcher + retry |
| `src/lib/krs/puller.ts` | P3 | NEW — KRS→POS product puller |
| `src/lib/env.ts` | P1 | Validate KRS_CONFIG_ENC_KEY only (not connection creds) |
| `src/app/api/krs/settings/route.ts` | P1 | NEW — GET (masked) + PATCH (encrypted write), admin-only |
| `src/app/api/krs/test-connection/route.ts` | P1 | NEW — real server-side test, returns latency |
| `src/app/api/krs/schema/route.ts` | P1 | NEW — INFORMATION_SCHEMA introspection, admin-only |
| `src/app/api/sync-jobs/route.ts` | P2 | Replace simulated insert-all/pull with real |
| `src/app/api/sync-jobs/[id]/route.ts` | P2 | Replace simulated retry with real |
| `src/app/api/orders/route.ts` | P2 | Enqueue SyncJob(SALE+STOCK) post-commit |
| `src/app/api/stock-movements/route.ts` | P2 | Enqueue SyncJob(STOCK) on receive |
| `src/app/api/orders/[id]/route.ts` | P2 | Enqueue SyncJob(REFUND/VOID) on refund |
| `prisma/schema.prisma` | P1, P2 | P1: KrsConnectionSettings model; P2: SyncJob outbox fields |
| `prisma/migrations/` | P1, P2 | P1: krs_connection_settings; P2: sync_job_outbox |
| `.env.example` | P1 | Add KRS_CONFIG_ENC_KEY placeholder only |
| `process/context/all-context.md` | P4 | Update KRS sync section |

---

## Blast Radius

**Highest-risk file: `src/app/api/orders/route.ts`** (POST checkout).
Adding enqueue-after-commit in P2 touches the most sensitive file in the repo (money + stock).
The enqueue MUST be fire-and-enqueue only, never awaited in the transaction, never able to throw
and roll back the checkout. Any exception from the enqueue path must be caught and swallowed
(logged, not propagated). Run the `pricing-tester` agent after every P2 touch of this file.

**P1 Prisma migration** adds `KrsConnectionSettings` as a new model. No existing tables altered.
Additive-only; no risk to existing seed data.

**P2 Prisma migration** extends SyncJob with nullable fields (outbox). Must be non-destructive
(all new fields nullable or with defaults). Existing seed data remains valid.

**`src/lib/krs/crypto.ts`** is a new high-sensitivity module. Encrypt/decrypt failure or
incorrect IV handling would corrupt stored passwords. The module must be unit-testable and
reviewed before P1 VERIFIED is declared.

**Cross-engine invariant:** every phase must preserve the separation between `src/lib/prisma.ts`
(Postgres) and `src/lib/krs/client.ts` (SQL Server). A code reviewer must verify this boundary
has not been blurred before any phase is marked VERIFIED.

**Password masking invariant:** every GET response handler that touches `KrsConnectionSettings`
must explicitly omit or replace the `encryptedPassword` field. A code reviewer must verify
this before P1 VERIFIED is declared.

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Plaintext password stored in DB (crypto bug) | CRITICAL | Unit-test crypto.ts; verify ciphertext in DB at P1 gate |
| Enc key absent in deployment | HIGH | Fail-fast with clear error in env.ts validation; document in runbook |
| Password returned in API response | HIGH | Explicit mask in GET handler; code reviewer checks before P1 VERIFIED |
| Checkout regression from enqueue code | HIGH | Fire-and-enqueue only; all exceptions caught; pricing-tester after P2 |
| Duplicate KRS rows on retry | HIGH | Idempotency key dedup before every INSERT (P0 design, P2 implementation) |
| KRS creds committed to git | CRITICAL | Hard constraint; .env.example placeholder only; creds in DB not env |
| mssql pooling exhaustion under load | MEDIUM | Pool size configurable via KrsConnectionSettings fields; P1 tests pool |
| SyncJob outbox migration breaks seed data | MEDIUM | All new fields nullable/default; migration is additive only |
| Introspection returns wrong columns (table name mismatch) | MEDIUM | P0 spec documents expected table names; P1 validates against real instance |
| Cross-engine transaction attempted by future developer | MEDIUM | src/lib/krs/ is isolated; documented invariant in runbook (P4) |

---

## Money / Stock Safety Notes

These apply to every phase that touches order or stock routes.

- `src/app/api/orders/route.ts` is the highest-risk file. Changes in P2 must be minimal and
  additive (enqueue after commit only).
- Stock decrement and payment line creation remain inside the existing Prisma `$transaction`.
  KRS enqueue happens AFTER the transaction commits, outside it.
- All enqueue exceptions must be caught and logged — never propagated to the checkout caller.
- The `pricing-tester` agent must be run after any P2 change to the orders route.

---

## Verification Strategy

| Phase | Gate type | Evidence |
|---|---|---|
| P0 | Spec review | Owner approves conceptual mapping + KrsConnectionSettings model + AES-256-GCM scheme + SyncJob extension in spec doc |
| P1 | Runtime | Save settings → Test Connection returns `{connected:true, latencyMs:<N>}` from owner's test SQL Server (or dev Docker); GET settings returns password masked; DB shows ciphertext not plaintext; introspection returns column metadata; type-check + build pass |
| P2 | Runtime | POS checkout → real KRS.sales + KRS.sale_items rows verified via SQL query on test instance; SyncJob FAILED → retry → SYNCED cycle tested; type-check + build pass |
| P3 | Runtime | `POST /api/sync-jobs` action=pull → KRS.products SELECT → POS products upserted; repeat pull = no duplicates; type-check + build pass |
| P4 | Runtime + audit | Full P0–P3 regression on test instance; no KRS creds in git; DB encryptedPassword is ciphertext; type-check + build pass |

---

## Test ENV Note

- Owner has a real KRS test SQL Server channel (to be supplied at P1 verification).
- Dev verification (P1 gate) can also use an ephemeral Docker container:
  `mcr.microsoft.com/mssql/server` + a mock KRS schema (separate from the project's
  own postgres docker-compose stack). This is sufficient for P1 type-check + connection tests.
- P2–P4 gates require the real owner instance (not just a Docker mock).

---

## Phase Status Tracker

| Phase | Status | Description |
|---|---|---|
| P0 | ⏳ PLANNED (UNBLOCKED) | Contracts/Spec — IMMEDIATELY ACTIONABLE; DDL dependency removed |
| P1 | ⏳ PLANNED | Connection Layer + Config UI — blocked until P0 approved |
| P2 | ⏳ PLANNED | Outbound Transport — blocked until P1 green |
| P3 | ⏳ PLANNED | Inbound Pulls — blocked until P2 green |
| P4 | ⏳ PLANNED | Ops Hardening — blocked until P3 green |

---

## Artifacts

| Artifact | Phase | Path |
|---|---|---|
| Grounding research | (pre-program) | `process/features/krs-sync/references/krs-sync-grounding_22-06-26.md` |
| P0 spec/contract doc | P0 | `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md` |
| P4 runbook (ops) | P4 | `process/features/krs-sync/references/krs-sync-runbook_P4_22-06-26.md` |
| P0 phase plan | P0 | `process/features/krs-sync/active/krs-sync-phase00-contracts_PLAN_22-06-26.md` |
| P0 phase report | P0 (post-exec) | `process/features/krs-sync/reports/krs-sync-phase00-contracts_REPORT_22-06-26.md` |
| P1 phase plan | P1 | `process/features/krs-sync/active/krs-sync-phase01-connection_PLAN_22-06-26.md` |
| P2 phase plan | P2 | `process/features/krs-sync/active/krs-sync-phase02-outbound_PLAN_22-06-26.md` |
| P3 phase plan | P3 | `process/features/krs-sync/active/krs-sync-phase03-inbound_PLAN_22-06-26.md` |
| P4 phase plan | P4 | `process/features/krs-sync/active/krs-sync-phase04-ops_PLAN_22-06-26.md` |

Note: P1–P4 phase plans are created at phase entry (after prior phase is VERIFIED) to avoid
stale specs. Only the P0 plan is written now alongside this umbrella. P1–P4 plans will be
written at each phase's research subagent step, after the prior phase delivers its evidence.

---

## Resume and Execution Handoff

**Current state at plan update (2026-06-22 owner decision applied):** Program at P0 start.
No code changes have been made. P0 is UNBLOCKED — DDL dependency removed; schema introspection
replaces it. New scope in P0: KrsConnectionSettings model design + AES-256-GCM scheme +
revised env contract (KRS_CONFIG_ENC_KEY only).

**Next valid action:** Execute P0 by passing the exact plan path to a research+plan subagent:
`process/features/krs-sync/active/krs-sync-phase00-contracts_PLAN_22-06-26.md`

**P0 is spec-only (no code).** The execute subagent for P0 is a research/writing subagent,
not a code execution subagent. Output is a spec doc in `references/`.

**Before P1:** P0 spec doc must be reviewed and approved by owner.
Owner's test SQL Server channel to be supplied at P1 verification (dev can use Docker mssql).
P1 plan is written at P0 closeout.

**Orchestrator must:** select exactly one phase plan at a time; never mix phase scopes;
confirm P0 gate (owner approval) before routing to P1.

**Validate before VERIFIED:** each phase requires both its own gate evidence AND a regression
check against any previously verified phases that overlap with this phase's blast radius.

---

## Dependencies and Blockers

| Dependency | Required by | Status |
|---|---|---|
| ~~KRS DDL from owner~~ (REMOVED — introspection replaces DDL) | ~~P0~~ | RESOLVED — schema discovered at P1 runtime |
| `KRS_CONFIG_ENC_KEY` (32-byte base64) in owner's local `.env` | P1 | OPEN — generated at P1 setup |
| Owner's test SQL Server channel (host/port/db/creds via Admin UI) | P1 verification | OPEN — owner supplies at P1 |
| npm mssql package version decision | P0 spec / P1 | Resolved in P0 spec doc |
| P0 spec approved by owner | P1 | Gates P1 start |
| P1 real connection verified | P2 | Gates P2 start |
| P2 outbound transport verified | P3 | Gates P3 start |
| P3 inbound pulls verified | P4 | Gates P4 start |

---

## Acceptance Criteria (Program Level)

All of the following must be true for the program to be complete:

1. Admin UI Connection tab: Save KRS SQL Server settings (including password) and have
   `GET /api/krs/settings` return them with password masked.
2. `GET /api/krs/test-connection` returns `{connected:true}` against the owner's real test SQL Server.
3. A POS checkout produces real rows in KRS.sales and KRS.sale_items on the test instance.
4. A stock receipt produces a real row in KRS.stock_movements on the test instance.
5. A refund/void produces a real negative-amount row in KRS.sales on the test instance.
6. The KRS pull populates POS Product catalog from real KRS.products data.
7. Checkout completes successfully when the KRS connection is offline (fail-open verified).
8. Replaying the same job idempotency key produces no duplicate row in KRS.
9. No real KRS credentials appear in any committed file (`git grep KRS_PASS` returns clean).
10. `KrsConnectionSettings.encryptedPassword` stores ciphertext (not plaintext) in the DB.
11. `npm run type-check` and `npm run build` pass with zero errors.
12. The NavRail failed-job badge count reflects real FAILED rows from P2 dispatches.

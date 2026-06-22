# KRS Sync — Grounding Research (pre-program)

- Date: 2026-06-22 · Produced by a 3-agent parallel investigation before scoping the "real KRS SQL Server transport" program. Owner decision: build **real** transport (not a demo refresh). Approved program shape = P0–P4 (see the umbrella plan).

## Ground truth: today everything KRS is SIMULATED
- **Connection screen exists but is demo-only.** `/data` route (`src/app/(shell)/data/page.tsx`) → Connection tab (`src/components/data/ConnectionTab.tsx`). Host/Port/**Engine**/Database/Username/SSL/connection-string come from hardcoded client constants `INITIAL_DB_STATE` in `src/components/data/connectionTypes.ts` (engine=`"MySQL"`, host `203.0.113.45` [RFC5737 placeholder], port `3306`). **Never persisted, never used.** "Connected · 18ms" + test-connection + insert-test-row are pure React state. **No password field in the Connection form; no Save action.**
- **KRS sync = canned state machine (Phase 6b), no transport.** `SyncJob` model (`prisma/schema.prisma` ~L43-56; comment L38: "SIMULATED state machine — there is NO real KRS transport in P6"). Routes `src/app/api/sync-jobs/route.ts` (GET list 200; POST `action=pull` → SYNCED canned; POST `action=insert-all` → drains PENDING→SYNCED canned) + `[id]/route.ts` (PATCH retry→SYNCED random TAX-no; skip→SKIPPED). TODO L25: "production-readiness: real KRS transport, idempotency on insert-all". Zero real network/DB calls.
- **/data tabs:** (1) Connection [client state], (2) Field Mapping [static diagram: 7-row outbound sales/items/stock + 6-row inbound + sync-mode daily/realtime/manual + stock-method perpetual/periodic], (3) Data Flow [live SyncJob table wired to the simulated API], (4) Live Data [synthetic KRS browser: sales/sale_items/products/stock_movements/sync_jobs/users].

## Design intent (source of truth)
- Screen is in `design/Simple POS.dc.html` ("ตั้งค่าการเชื่อมต่อ KRS · Connection"); **Engine is a read-only display** (`{{ dbEngine }}`), set at install/config time — NOT a user dropdown. Connection-string is `{{ dbConnString }}`. NOT present in the Taste redesign (checkout-only).
- **Real-time stock sync:** "ซิงค์สต็อกเรียลไทม์ — ขาย/รับเข้า → ส่งขึ้น KRS ทันที" = on sale/receipt, map field-for-field and insert into `KRS.stock_movements` immediately. Inbound: pull products.
- **Password field gap:** the original Connection form in `design/Simple POS.dc.html` has Host, Port, Database, Username, SSL — but **no password field and no Save action**. The owner's 2026-06-22 decision requires adding both.

## Feasibility (constraints that shape the build)
- POS own DB = **Prisma 5 + PostgreSQL 16, provider-locked** (`prisma/schema.prisma` datasource). Prisma cannot be both postgres + sqlserver → KRS needs a **separate client** (npm `mssql`/`tedious`), NOT the app's Prisma singleton.
- **No real transport today** — fully stubbed.
- **MySQL vs SQL Server discrepancy:** the demo string is `mysql://…:3306` (MySQL) but the owner wants **MS SQL Server** (`sqlserver://`/`mssql`, default port **1433**, SQL auth). Engine/port/driver/conn-string all change.
- Cannot enlist KRS writes in the POS Prisma `$transaction` (cross-engine) → must be **eventual-consistency + idempotency**, **fail-open** (a cash POS sale must never block on KRS).

## Approved decisions (owner, 2026-06-22)
- Build **real** SQL Server transport. · **Bidirectional** per design. · **Real-time + daily configurable** (design selector). · **Fail-open** (queue + retry; never block a sale). · **Idempotency** keyed on `orderNumber + jobType`.
- **Config from Admin UI (NOT from `.env`):** KRS connection parameters (host, port, database, username, password, ssl, syncMode) are configured via the `/data` Connection tab in the Admin UI and stored in a new Prisma model **`KrsConnectionSettings`** (singleton, `id @default("singleton")`). Mirrors the `ShopSettings` pattern.
- **Password encrypted at rest:** the password field is stored AES-256-GCM encrypted in `KrsConnectionSettings.encryptedPassword`. Encryption key = `KRS_CONFIG_ENC_KEY` (32-byte base64), in git-ignored `.env` only. Plaintext password is never stored, never logged, never returned in any API response.
- **Functional Connection screen additions:** password input (currently missing from design), Save action (requireAdmin, validated), real server-side Test Connection (returns actual latency — not React-state fake), SQL Server defaults (engine fixed "SQL Server", port 1433, `sqlserver://` hint).
- **Schema introspection replaces DDL hand-over:** the app introspects the KRS schema via `INFORMATION_SCHEMA.COLUMNS` at runtime (P1 `GET /api/krs/schema`). The Field Mapping tab is driven by this live introspection. Owner does NOT need to hand over DDL.
- **Only one new env var:** `KRS_CONFIG_ENC_KEY`. All KRS connection credentials live in the DB, not in `.env`.
- Owner **has a real test SQL Server channel** (supplies host/port/db/creds via Admin UI at P1 verification; dev can use Docker `mcr.microsoft.com/mssql/server`).

## Hard dependency for P0 — STATUS: REMOVED (2026-06-22)
~~The **KRS SQL Server target schema** (table + column definitions + keys) — without it the field mapping can only be guessed.~~

**RESOLVED:** Schema introspection via `INFORMATION_SCHEMA` at runtime (P1) replaces the DDL hand-over. P0 is **UNBLOCKED** — no DDL required before starting. P0 defines the CONCEPTUAL event→table mapping only; exact column names are discovered at P1 runtime.

Conceptual target tables (minimum, to be confirmed by introspection at P1):
`sales` · `sale_items` · `stock_movements` · `products` · optionally: `price_list` · `stock_balance` · `customers`

## Key files (entry points for the build)
`src/components/data/connectionTypes.ts` · `ConnectionTab.tsx` · `DataFlowTab.tsx` · `src/app/api/sync-jobs/route.ts` + `[id]/route.ts` · `src/lib/schemas/syncJob.ts` · `prisma/schema.prisma` (SyncJob L43-56) · `src/types/index.ts` (SyncJobDTO) · `src/lib/env.ts` (env contract — now only `KRS_CONFIG_ENC_KEY`) · `src/lib/prisma.ts` (singleton — NOT reused for KRS).

New files to be created in P1: `src/lib/krs/crypto.ts` · `src/lib/krs/client.ts` · `src/lib/krs/index.ts` · `src/app/api/krs/settings/route.ts` · `src/app/api/krs/test-connection/route.ts` · `src/app/api/krs/schema/route.ts`.

# Phase 6b Research — KRS Data Link UI (2nd sub-phase of P6)

- Date: 2026-06-20
- Parent: `pos-redesign-phase-6_RESEARCH_20-06-26.md` (P6 split 6a/6b/6c). 6a done & committed.
- Scope: the admin `/data` screen — 4 tabs (Connection / Field Mapping / Data Flow / Live Data) + sync-detail drawer + the LATENT mapping cards + the NavRail failed-job badge. **KRS transport is SIMULATED** (real integration = production-readiness).
- **Exact count: ~45 plan-table entries** assigned to 6b (parent's "~38" undercounted; the 3 LATENT rows overlap conceptually with the 3 display rows). Effective ~38–42 distinct behaviors. Nothing dropped.

## 1. Current state
- **`SyncJob` model exists (6a)**: `{id, type SyncJobType, direction SyncDirection@default(INSERT), ref, amount Decimal(12,2)@default(0), status SyncJobStatus@default(PENDING), provider@default("KRS"), error?, response?, branchId@default("BR-01"), createdAt, updatedAt}`. Enums: `SyncJobType{SALE REFUND STOCK PULL TAX_INVOICE STOCK_ADJ RECEIVE}`, `SyncDirection{INSERT PULL}`, `SyncJobStatus{PENDING SYNCED FAILED RETRYING SKIPPED}`. (Order has a SEPARATE `syncStatus SyncStatus{PENDING DAILY SYNCED FAILED SKIPPED}`.)
- **SyncJob creation pattern** (reuse): `orders/[id]/route.ts` request-tax does `tx.syncJob.create({ type:TAX_INVOICE, direction:INSERT, ref:orderNumber, amount:total, status:PENDING })`.
- `/data` = placeholder. **`NavRail.tsx` line 61**: `const failedJobCount = 0;` (badge fully wired, only the count is hardcoded; `data` item has `badge:true`).
- **Reusable**: `SaleDetailDrawer` (440px slideIn drawer, focus-trap → mirror for SyncDetailDrawer), `Modal`, `money`/`datetime`, `saleMeta.syncMeta()` (need a parallel `syncJobMeta()` for SyncJobStatus). `SyncJobDTO` already declared in `types/index.ts`. `AdminOnly` guard (P4) wraps `/data`.

## 2. Target behavior (Simple POS source-of-truth)
- **Connection tab**: dark status card tri-state (testing amber / connected green+pulse / disconnected amber), host/port/engine(MySQL ro)/db/user fields, SSL toggle, connection-string display, latency/last-check/session-INSERT stats, "ทดสอบการเชื่อมต่อ" + "ทดลอง INSERT" buttons, realtime stock-sync toggle. Init `db = {host:203.0.113.45, port:3306, name:krs_pos, user:krs_app, ssl:true, status:connected, latency:18}`.
- **Field Mapping tab**: POS↔KRS flow diagram; **outbound** table 7 rows (pos_no→sales.ref_no … qty→stock_movements.qty_delta; **vat_code→sales.tax_code = ❌ FIELD_MAP_MISMATCH** → `mapOutIncomplete:true`); **inbound** table 6 rows (products.item_code→sku … customers.tax_id→customer.taxId). Badges จับคู่แล้ว(green)/ยังไม่จับคู่(red).
- **LATENT (no prototype HTML — build real, ~6 sections)**: `productMap`(4 rows SKU/name/category/account/VAT/status; DS-001 ❌ ยังไม่ผูก), `paymentMap`(5; e-Wallet ❌), `taxMap`(3 VAT→GL), `inventoryMap`(4 Inventory/COGS/adjust/GRN→GL), `syncModes`(3 cards realtime/**daily default**/manual), `stockMethods`(2 cards **perpetual default**/periodic). `mappingIncomplete = productMap.some(!ok)||paymentMap.some(!ok)` → true.
- **Data Flow tab**: "ดึงข้อมูลจาก KRS"(pull) + "ส่งทั้งหมดเข้า KRS · {pending}"(insertAll); 5 KPI filter cards (pending blue/synced green/retrying amber/failed red/skipped purple — toggle filters); jobs table (Job ID·type/ref·direction badge·amount·time·status, row→drawer); empty state "ไม่มีรายการในสถานะนี้".
- **Live Data tab**: 6-table selector (sales/sale_items/products/stock_movements/sync_jobs/users + row counts), SQL preview `SELECT * FROM {table} LIMIT 50`, synthetic per-table rows, green highlight for just-inserted, row-count footer. Read-only.
- **SyncDetail drawer**: Job ID/type/status/ref/amount/provider/updated; error panel (red); response panel (dark teal mono); retry (canRetry=FAILED||RETRYING||PENDING) / skip (canSkip=!SYNCED&&!SKIPPED).
- **Shared live pill** (`state-live-status-fields-extra`): tri-state from `db.status`, shared with /pos + /products headers (testing/connecting amber, connected "เรียลไทม์·Live" green+pulse, disconnected "ออฟไลน์" amber).

## 3. The 8 seed jobs (exact — nav badge = 2 FAILED)
| ID | type | dir | ref | amount | status | updated | error |
|---|---|---|---|---|---|---|---|
| J-1042 | sale | insert | POS-20260616-0039 | 240.00 | **FAILED** | 13:21 | FIELD_MAP_MISMATCH vat_code→KRS.sales.tax_code |
| J-1041 | sale | insert | POS-20260616-0041 | 962.30 | SYNCED | 13:59 | — |
| J-1040 | refund | insert | POS-20260616-0038 | -65.00 | SYNCED | 12:51 | — |
| J-1039 | sale | insert | POS-20260616-0035 | 540.00 | **RETRYING** | 13:25 | NETWORK_TIMEOUT (2/5) |
| J-1038 | sale | insert | POS-20260616-0034 | 88.00 | PENDING | — | — |
| J-1037 | pull | pull | KRS.products | 0 | SYNCED | 13:05 | — |
| J-1036 | stock | insert | POS-20260616-0041 | 411.00 | SYNCED | 13:59 | — |
| J-1035 | stock | insert | GRN-20260616-007 | 8750.00 | **FAILED** | 10:42 | FIELD_MAP_MISMATCH DS-001 sku |
+ responses per Simple POS (HTTP 200/422/504 + KRS ids). Seed with explicit `id:'J-10xx'` (Prisma `@id String` accepts non-CUID); upsert `where:{id}`. Badge source = `count(status=FAILED)`.

## 4. Simulated state machines (precise)
- **testConnection**: status→testing (amber) immediately + toast; after **1100ms** → connected, latency random(9–31), lastCheck now + toast. (Pure client.)
- **insertTestRow**: client counter `inserted+1` + `lastInsert` ts + toast; green row in Live Data sales; **no DB SyncJob**.
- **pullFromKRS**: create a SYNCED PULL job ref=KRS.products amount 0 + toast (server write).
- **insertAllPending**: bulk PENDING→SYNCED + resp + toast; if 0 → "ไม่มีรายการรอ insert". FAILED jobs stay FAILED (not drained).
- **retrySync(id)**: → SYNCED, error=null, resp canned (doc_no), close drawer + toast.
- **skipSync(id, reason)**: → SKIPPED, resp "ข้ามโดยผู้ใช้ · เหตุผล: {reason}", close + toast. (Replace `window.prompt` with an inline reason panel in the drawer.)
- **toggleStockSync / setSyncMode / setStockMethod**: React-state flips + toast.
- **domain-mapping-blocks-sync**: represented by the 2 FAILED seed jobs (vat_code, DS-001); NOT a runtime gate on insertAllPending; outbound row shows the incomplete badge.

## 5. ⚠️ Decisions (recommendations)
| # | Gap | Recommendation |
|---|---|---|
| **A** | 8-job seed | add to `seed.ts`, `upsert where:{id}` with static `J-10xx` ids/errors/responses; idempotent |
| **B** | connection sim: client vs server | **pure CLIENT React state** for connection/test/insert-test/config; server only for SyncJob CRUD (pull/insertAll/retry/skip) — confirm |
| **C** | KRSConfig persistence | **React state only** (defaults 203.0.113.45/3306/krs_pos/krs_app/ssl); real config = production-readiness |
| **D** | field-map + LATENT data | **static hardcoded** UI constants |
| **E** | NavRail badge | add `GET /api/sync-jobs/failed-count` (single `count where FAILED`); NavRail `useEffect` fetch, init 0 (no layout shift) |
| **F** | checkout auto-create SALE jobs? | **NO** — do not touch POST /api/orders (`domain-sell-first-accounting-async`); insertAllPending simulates draining — confirm (protects /pos) |
| **G** | retry/skip API | `PATCH /api/sync-jobs/[id] {action:retry|skip, reason?}`, server-enforced gates (retry: FAILED/RETRYING/PENDING; skip: !SYNCED&&!SKIPPED) |
| **H** | mapping-incomplete block | UI warning only (FAILED seed jobs represent it); insertAllPending drains PENDING only |
| **I** | skip reason input | **inline reason panel** in drawer (no `window.prompt`) — confirm |

## 6. Cross-program boundaries
**In scope (6b):** /data 4 tabs + drawer (Taste); connection/test/insert simulation (client); static field-map + LATENT data; `GET /api/sync-jobs` (list+filter), `GET /api/sync-jobs/failed-count`, `PATCH /api/sync-jobs/[id]` (retry/skip), `POST /api/sync-jobs` (pull + insertAll bulk); 8-job seed; NavRail badge; shared live pill.
**Deferred (production-readiness):** real KRS TCP/MySQL/SSL transport; IndexedDB offline queue + backoff + idempotency; real accountingDocNo issuance; encrypted KRSConfig storage; retry idempotency guard.

## 7. Files
- **New**: `(shell)/data/page.tsx` (replace placeholder, AdminOnly-wrapped); `components/data/{ConnectionTab,FieldMappingTab,AccountMappingSection,SyncModeSection,StockMethodSection,DataFlowTab,LiveDataTab,SyncDetailDrawer,SyncKpiCards,syncMeta}.tsx`; `api/sync-jobs/route.ts` (GET+POST), `api/sync-jobs/[id]/route.ts` (PATCH), `api/sync-jobs/failed-count/route.ts` (GET).
- **Modified**: `NavRail.tsx` (line 61 → fetched count), `seed.ts` (8 jobs), `types/index.ts` (optional SyncCountsDTO). **No migration** (SyncJob exists).

## 8. Risks
1. **LATENT 6 sections = highest drop-risk** (no prototype HTML — build from data defs + Taste). 2. **NavRail badge global** — new fetch on every page; init 0, async update, no layout shift; must not regress P4 role-filter. 3. **skip reason** — inline panel (no window.prompt). 4. **seed non-CUID ids** (J-10xx) — display-only, fine. 5. **shared live pill** must initialize sensibly (start disconnected/amber; don't break /pos /products). 6. **must NOT touch /pos or POST /api/orders** (verify via build). 7. **/data admin-only** (AdminOnly guard). 8. largest single screen — completeness risk.

## 9. Verdict + order
**Mixed (UI-heavy + thin API).** Order: (1) seed 8 jobs → (2) APIs (list/counts/failed-count/retry-skip/pull-insertAll) → (3) NavRail badge → (4) Data Flow tab + SyncDetailDrawer → (5) Connection tab → (6) Field Mapping + LATENT sections (most care) → (7) Live Data tab → (8) shared live pill → (9) verify /pos + POST orders untouched → type-check + build + live smoke.

## 10. Readiness
**Ready for EXECUTE.** SyncJob model + DTO + drawer/API patterns all exist; only novel work = the 6 LATENT sections (build from data defs). Confirm decisions **B** (client-state connection sim), **F** (no SALE jobs from checkout), **I** (inline skip-reason). A/C/D/E/G/H follow recommendations. No migration needed.

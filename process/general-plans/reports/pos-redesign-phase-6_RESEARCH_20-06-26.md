# Phase 6 Research — KRS Data Link + Customer/member + Tax Invoice + Design Spec Docs

- Date: 2026-06-20
- Plan: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (Phase 6, **67 functions — the largest phase**)
- Depends on: Phases 1–5 (done). P5 left the entry-point stubs: `Order.syncStatus`/`accountingDocNo`/`taxRequested`, the disabled "ขอใบกำกับ" button in SaleDetailDrawer, the NavRail `data` badge wired but hardcoded `0`.
- **Top deliverable: a sub-phase decomposition** (P6 is too large/heterogeneous for one PLAN→EXECUTE).

## 1. Current state
- **P5 stub fields on Order**: `syncStatus SyncStatus@default(PENDING)`, `accountingDocNo String?` (seed has TAX-…/CN-…), `taxRequested Boolean@default(false)`.
- **No `Customer` model, no `SyncJob` model.** `Order` has no `customerId`.
- **SaleDetailDrawer**: "ขอใบกำกับภาษี" button is `disabled` (`title="… Phase 6"`); walk-in warning hardcoded.
- **NavRail**: `data` item `badge:true` but `failedJobCount=0` hardcoded (comment: P6 sources real failed-sync count).
- **/data + /docs**: placeholders.
- **Reusable**: `Modal`, `SaleDetailDrawer` (drawer pattern → SyncDetail drawer), `money`/`datetime`/`pricing`, `paymentMeta`/`saleMeta`.

## 2. Target (Simple POS source-of-truth, Taste-ported — no Taste mock for /data,/docs)
- **Customer + tax invoice**: customer-picker modal (search by name/taxId, walk-in + list w/ "มีข้อมูลภาษี" badge), pick/walk-in; payment-modal **tax toggle** + validation `taxRequested && !customer.hasTax → payError "ต้องเลือกลูกค้าที่มีเลขผู้เสียภาษี…"`; request-tax-invoice from /sales drawer → creates a PENDING `tax_invoice` SyncJob ("ส่งคำขอ…เข้าคิวแล้ว"). 3 seed customers ({id,name,sub,initials,hasTax,taxId}).
- **KRS Data Link (4 tabs)**: Connection (status dot connected/testing/disconnected, editable host/port/db/user, SSL toggle, test-connection, insert-test-row, stock-sync toggle); Field Mapping (POS↔KRS flow + outbound[7]/inbound[6] tables, `vat_code` = FIELD_MAP_MISMATCH; **LATENT** account-mapping tables productMap/paymentMap/taxMap/inventoryMap + syncMode[3]/stockMethod[2] cards — computed but never rendered in prototype → build real); Data Flow (pull-from-KRS, insert-all-pending, 5 sync-count KPI filter cards, jobs table, empty state); Live Data (table selector ×6, SQL preview, synthetic row grid, green last-insert row). SyncDetail drawer (status/ref/amount/provider, error+response panels, retry/skip gated). 8 seed jobs (2 FAILED → nav badge=2, 1 RETRYING, 1 PENDING, 4 SYNCED). DB-connection tri-state drives shared `live*` status pills.
- **Design Spec hub (10 panels)**: overview/IA-matrix/flows/screen-list/component-inventory/tokens/copy/rules/visual-directions/impl-notes; pill tab switcher; static, admin-only.
- **Domain rules**: `domain-sell-first-accounting-async` (POS always sells PENDING→queue; /pos + POST /api/orders sell behavior UNCHANGED), `domain-tax-invoice-requires-tax-customer`, `domain-mapping-blocks-sync` (vat_code mismatch blocks), `domain-realtime-stock-sync`, `domain-accounting-providers`.

## 3. ★ Sub-phase decomposition (KEY)

| Sub-phase | Functions | New schema | New APIs | Blast radius | Risk | Order |
|---|---|---|---|---|---|---|
| **6a — Customer + Tax Invoice** | 16 | `Customer`, `SyncJob`(+enums), `Order.customerId?` | `GET /api/customers`, `POST /api/sync-jobs` | **/pos checkout + PaymentModal + SaleDetailDrawer + POST /api/orders** (sensitive) | MEDIUM | **1st** |
| **6b — KRS Data Link UI** | ~38 | (SyncJob from 6a; KRSConfig optional) | `/sync-jobs` GET+PATCH, test-connection, insert-all-pending, failed-count | /data (isolated) + NavRail badge (global, replace `0`) | MED-HIGH | 2nd |
| **6c — Design Spec Docs** | 13 | none | none | /docs only | LOW | 3rd |

Total 16+38+13 = **67** (complete, nothing dropped). Sequence **6a→6b→6c**: 6a unlocks the most product value w/ defined scope; 6b depends on SyncJob + is the biggest/most-complex (simulated connection contains the risk); 6c is independent/static/lowest-risk → last.

**6a function group:** overlay-customer-picker, action-open/search/pick-customer, pick-walkin, close-customer-picker, action-tax-toggle, domain-tax-invoice-requires-tax-customer, state-customer-has-tax, action-request-tax-invoice, (partial seed-sync-jobs).
**6b function group:** screen-krs-data-link + 4 tab screens, action-set-data-tab, all action-db-* (test/insert/edit/ssl/table), pull-from-krs, insert-all-pending, sync-card-filter, open/close-sync-detail, retry/skip-sync, toggle-stock-sync, set-stock-method, set-sync-mode, outbound/inbound field-map, account-mappings, sync-mode/stock-method options, the 3 LATENT card sets, overlay-sync-detail-drawer, states (live-stock/sync-status/sync-queue/sync-empty/db-connection/mapping-incomplete/live-status-extra), flow-sync-to-krs, domain-{sell-first,mapping-blocks-sync,realtime-stock-sync,accounting-providers}, db-preview-row-builders, seed-sync-jobs(8), sidebar-failed-badge-source.
**6c function group:** screen-design-spec-hub, action-docs-tab, display-docs-{overview,ia,flows,screens,components,tokens,copy,rules,visual,impl}.

## 4. Major decisions (need go-ahead before 6a)

| # | Gap | Options | Recommendation |
|---|---|---|---|
| **A** | Customer model fields + Order linkage | minimal `{id,name,taxId?,phone?,address?,branchId}` + `Order.customerId?` vs full member (memberCode/points/email) | **minimal + `address?`** (tax invoice legally needs customer address per Simple POS IA "ที่อยู่ออกใบกำกับ"); full-member screen is NOT in the 67 |
| **B** | SyncJob + KRS contract UNDEFINED | full provider abstraction vs `provider="KRS"` + **simulated** (no real TCP; actions mutate `SyncJob.status` + canned responses) | **simulated state-machine** w/ open `provider` string field; real transport = production-readiness |
| **C** | Tax-invoice issuance timing | (1) request → PENDING `TAX_INVOICE` SyncJob, `accountingDocNo` issued async on sync · (2) issue doc no immediately | **Option 1** (exact Simple POS `requestTax` behavior — doc no returns from KRS on sync success) |
| **D** | Docs content source | static JSX authored from design files vs DB-driven | **static JSX** (prototype computes inline; no API) |
| **E** | LATENT cards (account-mapping/sync-mode/stock-method) | build real vs defer | **build real** in 6b Mapping tab (plan mandates; ~7 new UI sections) |
| **F** | KRSConfig (host/port/ssl) persistence | DB row vs React state only | **React state only** for P6 (matches prototype; avoids credential-storage risk; real config = production-readiness) |

**Schema sketch (6a):** `Customer{id,name,taxId?@unique,phone?,address?,branchId,orders Order[]}` · `SyncJob{id,type SyncJobType,direction SyncDirection,ref,amount Decimal(12,2),status SyncJobStatus,provider@default("KRS"),error?,response?,branchId,createdAt,updatedAt}` · enums `SyncJobType{SALE REFUND STOCK PULL TAX_INVOICE STOCK_ADJ RECEIVE}` `SyncDirection{INSERT PULL}` `SyncJobStatus{PENDING SYNCED FAILED RETRYING SKIPPED}` · `Order.customerId? + customer Customer?`.

## 5. Cross-program boundaries
**In scope (P6):** Customer + SyncJob models + seed (3 customers, 8 jobs); CustomerPickerModal wired into /pos; tax toggle + validation; requestTax → PENDING SyncJob; `/api/customers` + `/api/sync-jobs` CRUD; **simulated** test-connection/insert-all-pending (mutate DB status, canned responses); field-map tables (static UI data); sync-mode/stock-method (React state or light KRSConfig); nav badge from real failed count; /docs 10 static panels; `Order.customerId`.
**Deferred (production-readiness / real-KRS):** real external KRS TCP/SSL connection + transport; IndexedDB offline queue + backoff + idempotency; real `accountingDocNo` issuance (Thai Revenue sequential numbering); auth-gated admin routes (RBAC still client stub); encrypted KRSConfig secret storage.

## 6. Files per sub-phase
- **6a:** new — migration #4 (Customer/SyncJob/Order.customerId), `api/customers/route.ts`, `components/pos/CustomerPickerModal.tsx`; modified — schema, seed (3 customers + 8 jobs), `api/orders/route.ts` (accept+persist customerId), `api/orders/[id]/route.ts` (include customer), `(shell)/pos/page.tsx` + `PaymentModal.tsx` (picker+toggle+validation), `SaleDetailDrawer.tsx` (enable tax button), `types/index.ts`.
- **6b:** new — `(shell)/data/page.tsx` (4 tabs), `components/data/{ConnectionTab,FieldMappingTab,DataFlowTab,LiveDataTab,SyncDetailDrawer,...}`, `api/sync-jobs/route.ts` (GET/POST), `api/sync-jobs/[id]/route.ts` (PATCH retry/skip), failed-count; modified — `NavRail.tsx` (real failed count), seed (8 jobs if not in 6a), `types`.
- **6c:** new — `components/docs/*` (10 panels); modified — `(shell)/docs/page.tsx`.

## 7. Risks
1. **KRS contract undefined** → simulate transport; keep `provider` open. 2. **6a touches /api/orders (most sensitive)** — `customerId` additive/nullable, but checkout + payment validation change → mandatory regression smoke. 3. **sell-first offline queue** — P6 simulates with DB PENDING rows; real IndexedDB/backoff = production-readiness (don't conflate). 4. **No function dropped** — highest drop-risk in 6b LATENT sections (no prototype HTML template → build from computed data defs; ~7 new sections). 5. **Nav badge** = live count query on every load → keep lightweight. 6. **Docs accuracy** — authoring risk (static, no live query). 7. **4th migration** (6a) tracked + docker-verified.

## 8. Readiness + recommendation
**Ready for sub-phased EXECUTE.** Recommended: **6a → 6b → 6c**, start **6a (Customer + tax invoice)** first. Decisions A–F have clear recommendations (minimal Customer +address; simulated SyncJob; Option-1 tax queue; static docs; build LATENT; React-state config). Go-ahead needed on: the **3-sub-phase split**, **start 6a**, and confirm **A/B/C** (the rest follow). Then PLAN/EXECUTE 6a only.

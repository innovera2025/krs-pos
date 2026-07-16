# KRS Realtime Inbound Sync (Change Tracking) — Program Plan

**Created:** 16-07-26 · **Type:** multi-phase program (single-file plan, branch-warehouse-style —
see "Program fit" below) · **Status:** P0.1 discovery PASSED 16-07-26 (all 3 tables have PKs; server
is actually SQL Server 2019 **Enterprise**, not Express — Express caps moot, CT choice unchanged; CT
not yet enabled by anyone; DB 72MB. Results + ready-to-send letter:
`references/krs-ct-vendor-request_P0_16-07-26.md`) · **VARIANT SWITCH (owner, 16-07-26): vendor-free
watermark detector** — no KRS-side DDL required; P0.2 CT letter is now OPTIONAL (future upgrade, still
worth bundling with Q1-Q9). Watermark discovery PASSED: `InventoryFlowHdr.EntryDate` + `ApprovedDate`
both live and recent (see `references/krs-watermark-discovery_16-07-26.md` — that doc's "Detector
contract" REPLACES the CHANGETABLE mechanics in P1.1; everything else in P1-P3 — shared reconcile
engine, cursor storage, endpoint+sidecar shape, SSE, autoSync demotion, 667-item regression gate —
applies unchanged; read `KrsCtCursor` as the watermark cursor row). **P1 UNBLOCKED — in progress.**

**Feature:** krs-sync · **Scope:** ERP(KRS) → POS inbound stock/product sync, realtime (target 1–5s
end-to-end). **Outbound POS → KRS is explicitly OUT OF SCOPE** — it is already event-driven realtime
via the existing `SyncJob` outbox + `krs-dispatch-cron` (see `src/lib/krs/dispatcher.ts`,
`POST /api/krs/dispatch`). This plan does not touch outbound code.

---

## Program fit

This is a genuinely multi-phase, multi-session effort (4 phases, a hard external vendor gate, and a
major refactor of the highest-risk KRS file in the repo). Per `process/development-protocols/
phase-programs.md` this would normally warrant a full umbrella-plan + per-phase-file split. The
orchestrator explicitly requested a **single direct plan file** formatted like
`process/features/branch-warehouse/active/branch-warehouse-program_PLAN_28-06-26.md` (phases table +
inline per-phase touchpoints in one file), which is itself a precedent for exactly this shape
(4 phases, vendor-blocked, low→high risk, independently shippable). This plan follows that shape,
while still carrying the stronger direct-plan contract required by `plan-lifecycle.md` (Touchpoints,
Public Contracts, Blast Radius, Verification Evidence, Resume and Execution Handoff — all present
below). If a future phase reveals the effort needs true multi-file phase-program treatment (e.g. P1
turns out to need its own multi-session sub-loop), split it out at that point rather than up front.

---

## Goal (owner)

Replace the current 60–80s-cadence inbound delta engine with **true-realtime (1–5s) inbound sync**
from KRS (ERP) into POS: a stock movement or approval flip in KRS should be visible on the `/pos`
product grid within a few seconds, without a manual refresh — using **SQL Server Change Tracking
(CT)**, which (unlike Change Data Capture) works on **SQL Server Express** without a SQL Agent.
Outbound (POS → KRS) is already realtime/event-driven and is untouched by this plan.

---

## Locked decisions (this plan)

| # | Decision | Rationale |
|---|---|---|
| D1 | Use **SQL Server Change Tracking (CT)**, not CDC. | CDC requires SQL Agent (Standard+ edition); KRS is Express (`43.229.134.162\SQLEXPRESS`, db `db_ACC_SNP`). CT has been supported on every edition, including Express, since SQL Server 2008 R2. |
| D2 | CT tracks exactly 3 tables: `dbo.InventoryFlowDtl`, `dbo.InventoryFlowHdr`, `dbo.InventoryItem`. | Dtl = the stock-movement rows `sp_Onhand` sums; Hdr = the approval/close flags that gate whether a movement counts (`Approved=1 AND IsClosed<>1`) — an approval flip changes on-hand with **no Dtl row edit**, so Hdr must be tracked too; InventoryItem = product master (price/name/active). |
| D3 | Every KRS read stays **warehouse-scoped** (`@Warehouse='WHxx'`), **never** the global `@Warehouse=NULL` call. | Per `krs-onhand-global-discrepancy_REPORT_15-07-26.md` (Q9), the global aggregate is internally inconsistent/broken on the KRS side (667/972 items wrong). This plan never calls it. |
| D4 | **Redefine** the global stock baseline: `Product.stock` (and the global `KrsStockSnapshot` sentinel) are no longer derived from the broken global `sp_Onhand` call — they become **Σ of per-warehouse scoped `sp_Onhand` calls**, tracked via the existing per-warehouse `KrsStockSnapshot(itemCode, warehouseCode)` rows (already written today, display-only, by Branch/Warehouse Phase 5). | This is the load-bearing architectural decision of the whole program — see §P1.3 "Baseline redefinition" below for the full proof and the exact mechanism that keeps this consistent with the 15-07 incident's hard lesson (baseline must always mirror what we now define as KRS-reported truth, never a wished-for value). |
| D5 | The **existing legacy `runAutoSync` global pass is retired** (its calls to `fetchKrsStockBalances(config, null)` — the broken global call — are deleted), and the legacy 60s auto-sync cron is **demoted to a full-reconcile safety net** that runs the SAME shared delta-apply engine as the new realtime poller, just scoped to "ALL warehouses" instead of "only the warehouses CT flagged as changed." | This eliminates "two engines fighting" by construction: there is only ONE piece of delta-apply logic (`src/lib/krs/stockReconcile.ts`), called with a narrow scope (realtime path) or a wide scope (safety-net path). They cannot disagree because they share the same math and the same run-lock. |
| D6 | New realtime engine polls every **2 seconds** (configurable), each cycle: query CT deltas → collect touched warehouses → scoped `sp_Onhand` per touched warehouse only → atomic delta-apply → advance cursor. | Matches the owner's 1–5s target; see the latency budget table below. |
| D7 | SSE (`GET /api/events`), **single-instance in-memory pub/sub** (Node `EventEmitter`), session-authed. **No Redis** — this app is a single Lightsail VPS deploy; multi-instance fan-out is explicitly out of scope and flagged for a future program if the deploy topology ever changes. | Matches current deploy reality (`docker-compose.prod.yml` runs one `app` container). Do not over-build for a scale-out scenario that does not exist. |
| D8 | New CT cursor storage = a **dedicated new singleton model `KrsCtCursor`** (mirrors the `ShopSettings`/`KrsConnectionSettings` singleton pattern), not an overload of the `KrsStockSnapshot` sentinel row. | `KrsStockSnapshot`'s sentinel row is semantically a stock-snapshot lock; a CT version cursor is a different concern (DB-wide CT version number, not itemCode/warehouseCode-keyed). Mixing them would be confusing and coupling two unrelated lifecycles. |
| D9 | Retention = **3 days** (`CHANGE_RETENTION = 3 DAYS, AUTO_CLEANUP = ON`), vendor-configured. | Generous vs. any expected deploy/restart downtime; if exceeded, the poller safely falls back to a full reconcile (D5's shared engine, scope=ALL) rather than silently missing changes. |
| D10 | Fail-open, read-only-on-KRS invariant carried forward unchanged from the existing inbound program: the CT `ALTER TABLE ... ENABLE CHANGE_TRACKING` DDL is executed **by the vendor**, never by our app; our app only ever *reads* `CHANGETABLE(...)`/`sp_Onhand`; a KRS-side fault skips the cycle and never touches checkout. | Same invariant as `autoSync.ts`'s existing header comment; this program must preserve it, not weaken it. |

---

## Latency budget (target: 1–5s end-to-end, owner-approved ≈ 2–4s typical)

| Step | Est. time | Notes |
|---|---|---|
| CT poll interval (sidecar loop cadence) | 2,000 ms | `KRS_CT_POLL_INTERVAL_SECONDS` (default 2, tunable) |
| `CHANGETABLE(CHANGES ..., @cursor)` × 3 tables | 10–100 ms | index-seek against the CT internal side-table, bounded by rows-changed-since-cursor, not table size |
| Derive changed warehouse set (in-process) | <5 ms | negligible in-memory set-build |
| Scoped `sp_Onhand` call per touched warehouse | 100–300 ms per warehouse | reuses existing `fetchKrsStockBalances(config, warehouseCode)`; see §P1.2 pool-reuse note |
| Postgres writes (WarehouseStock upsert + atomic `Product.stock` delta + snapshot upsert) | 10–50 ms | small, PK-indexed upserts, mirrors existing `autoSync.ts` write pattern |
| SSE broadcast to connected `/pos` clients | <10 ms | in-memory `EventEmitter`, no network hop |
| **End-to-end (typical, 1 warehouse touched)** | **≈ 2.2–2.6 s** | dominated by the 2s poll interval |
| **End-to-end (worst case, multiple warehouses touched same cycle, cold pool)** | **≈ 3.5–4 s** | still inside the owner's 1–5s target |

---

## Architecture overview

```
KRS SQL Server (db_ACC_SNP, Express, host/db only — see P0; never write credentials into docs)
  dbo.InventoryFlowDtl  (CT ON)  ── stock-movement rows sp_Onhand sums
  dbo.InventoryFlowHdr  (CT ON)  ── Approved/IsClosed — approval flips affect on-hand w/ no Dtl edit
  dbo.InventoryItem     (CT ON)  ── product master (price/name/active)
        │  poll every ~2s (bearer-authed, read-only)
        ▼
POST /api/krs/ct-poll  ── mirrors POST /api/krs/auto-sync's bearer-auth pattern exactly
        │  1. CHANGETABLE(CHANGES ..., @cursor) × 3 → changed warehouse set (+ InventoryItem flag)
        │  2. per touched warehouse: scoped sp_Onhand(@Warehouse='WHxx') — NEVER global
        │  3. reconcileWarehouses(config, scope) — shared engine (src/lib/krs/stockReconcile.ts)
        │  4. atomic delta-apply → WarehouseStock + Product.stock + per-warehouse KrsStockSnapshot
        │  5. advance KrsCtCursor.lastVersion
        ▼
Postgres (WarehouseStock, Product.stock, KrsStockSnapshot, KrsCtCursor)
        │  in-memory pub/sub broadcast (src/lib/krs/events.ts)
        ▼
GET /api/events  (SSE, session-authed, single-instance)
        │
        ▼
/pos product grid — patches the existing `products` state by sku (React.memo-safe)

Safety net (unchanged cadence, refactored internals):
krs-cron sidecar ──2 min/60s──▶ POST /api/krs/auto-sync ──▶ reconcileWarehouses(config, {kind:"ALL"})
  (same shared engine as ct-poll, just scope=ALL instead of scope=touched-only)
```

---

## Phases (low→high risk; each independently shippable; P1 gates P2/P3)

| # | Phase | Risk | Status |
|---|---|---|---|
| P0 | Vendor/discovery gate — CT enablement request + read-only PK/edition/size checks | blocking (no code) | ⏳ PLANNED — not yet sent |
| P1 | CT poller + shared reconcile engine + legacy autoSync refactor (baseline redefinition) | **high** (touches the file responsible for the 15-07-26 incident) | ⏳ PLANNED — blocked on P0 |
| P2 | SSE live push to `/pos` | medium | ⏳ PLANNED — blocked on P1 |
| P3 | Cutover + ops (status pill, monitoring, runbook, vendor load statement) | low | ⏳ PLANNED — blocked on P2 |

---

## P0 — Vendor/discovery gate (BLOCKING, no code)

**Goal:** get vendor sign-off + confirm every fact this program's design currently assumes, before
writing any CT SQL.

### P0.1 — Read-only checks we can run ourselves first (no vendor needed)

Run against the existing read-only KRS connection (host `43.229.134.162\SQLEXPRESS`, db
`db_ACC_SNP` — never write the actual credentials into any file; they load from
`KrsConnectionSettings`/`.env` at runtime only, per the existing crypto/connection-settings pattern):

```sql
-- Confirm edition (Change Tracking is supported on every edition incl. Express; CDC is NOT)
SELECT SERVERPROPERTY('Edition') AS Edition, SERVERPROPERTY('EngineEdition') AS EngineEdition;

-- Confirm CT is not already enabled/configured by someone else (must not silently override)
SELECT DATABASEPROPERTYEX('db_ACC_SNP', 'IsChangeTrackingEnabled') AS DbCtEnabled;
SELECT * FROM sys.change_tracking_databases WHERE database_id = DB_ID('db_ACC_SNP');
SELECT * FROM sys.change_tracking_tables;

-- Confirm each target table HAS a primary key (Change Tracking requires one)
SELECT tc.TABLE_SCHEMA, tc.TABLE_NAME, kcu.COLUMN_NAME, kcu.ORDINAL_POSITION
FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
  ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
 AND kcu.TABLE_SCHEMA   = tc.TABLE_SCHEMA
WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
  AND tc.TABLE_NAME IN ('InventoryFlowDtl', 'InventoryFlowHdr', 'InventoryItem')
ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION;

-- Express 10GB cap headroom (advisory, not a hard blocker unless already near the cap)
EXEC sp_spaceused;
```

Findings from these queries feed directly into the vendor letter (§P0.2) and into P1's exact
`CHANGETABLE ... JOIN` predicate (the join column list depends on the real PK — see the honesty note
in §P1.1).

**If any of the 3 tables has NO primary key**, CT cannot be enabled on it as-is. That is a hard
blocker requiring a different design (e.g. asking the vendor to add a surrogate PK, or falling back
to a coarser polling granularity) — **do not proceed to P1 until this is confirmed false** (i.e. all
3 tables do have a PK).

### P0.2 — Vendor request (Thai-first, mirrors the existing Q1-Q9 / writeback-spec-request precedent)

Deliverable: `process/features/krs-sync/references/krs-ct-vendor-request_P0_16-07-26.md` (to be
created at P0 execution time; drafted here so the owner can review/forward it without waiting for a
separate write pass).

```
เอกสารขอเปิดใช้ Change Tracking (CT) — ซิงค์สต็อกแบบเรียลไทม์จาก KRS เข้า POS

ถึง: ทีมผู้พัฒนา/ผู้ดูแลระบบ KRS (db_ACC_SNP)
จาก: ทีมพัฒนา KRS POS (ระบบขายหน้าร้าน)
เรื่อง: ขอเปิดใช้ SQL Server Change Tracking (อ่านอย่างเดียว ไม่กระทบข้อมูล/แอปฝั่งบัญชี)

บริบท: ปัจจุบัน POS ดึงสต็อกจาก KRS ทุก 60-80 วินาทีผ่าน sp_Onhand (แบบ warehouse-scoped เท่านั้น
ตามที่ตกลงไว้ก่อนหน้า — ไม่ใช้ค่ารวมทุกคลัง @Warehouse=NULL ซึ่งพบว่าให้ผลผิดพลาดใน 667 รายการ).
เราต้องการลดเวลานี้ลงเหลือ 1-5 วินาที โดยใช้ฟีเจอร์ "Change Tracking" ของ SQL Server ซึ่ง:
  - เป็นฟีเจอร์มาตรฐานที่รองรับทุกรุ่นรวมถึง Express (ไม่ต้องใช้ SQL Agent)
  - เป็นการอ่านอย่างเดียวฝั่งเรา — สิ่งที่ต้องทำฝั่ง KRS คือเปิดใช้งาน (ALTER DATABASE/ALTER TABLE)
    ไม่มีการเปลี่ยนโครงสร้างตารางเดิม ไม่มีคอลัมน์ใหม่ ไม่กระทบแอปบัญชีที่ใช้อยู่

คำขอ (โปรดตอบ/ดำเนินการเป็นข้อ):

1. เปิด Change Tracking ระดับฐานข้อมูล (รันครั้งเดียว):
   ALTER DATABASE db_ACC_SNP
     SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 3 DAYS, AUTO_CLEANUP = ON);
   - หาก db_ACC_SNP มีระบบอื่นใช้ Change Tracking อยู่แล้วด้วยค่า retention อื่น โปรดแจ้งก่อน
     (การตั้งค่านี้เป็นระดับฐานข้อมูล ใช้ร่วมกับผู้ใช้อื่นได้ แต่ retention เป็นค่าเดียวทั้ง DB)

2. เปิด Change Tracking ระดับตาราง บน 3 ตาราง:
   ALTER TABLE dbo.InventoryFlowDtl ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF);
   ALTER TABLE dbo.InventoryFlowHdr ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = ON);
   ALTER TABLE dbo.InventoryItem    ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF);
   (Hdr ใช้ TRACK_COLUMNS_UPDATED = ON เผื่อในอนาคตเราต้องกรองเฉพาะการเปลี่ยนที่ Approved/IsClosed
   จริงๆ — ไม่บังคับสำหรับเวอร์ชันแรก)

3. สิทธิ์อ่าน Change Tracking ให้บัญชีที่ POS ใช้เชื่อมต่อ:
   GRANT VIEW CHANGE TRACKING ON dbo.InventoryFlowDtl TO <บัญชีที่ POS ใช้เชื่อมต่อ>;
   GRANT VIEW CHANGE TRACKING ON dbo.InventoryFlowHdr TO <บัญชีที่ POS ใช้เชื่อมต่อ>;
   GRANT VIEW CHANGE TRACKING ON dbo.InventoryItem    TO <บัญชีที่ POS ใช้เชื่อมต่อ>;
   - โปรดยืนยัน username ของบัญชีที่ใช้เชื่อมต่อจริงในปัจจุบัน (ถ้าเป็นบัญชีสิทธิ์สูงอยู่แล้ว
     อาจไม่จำเป็นต้อง GRANT เพิ่ม แต่ขอให้ยืนยันเพื่อความชัดเจน)

4. ข้อมูลเพื่อประเมินผลกระทบ (ไม่บังคับ แต่ช่วยให้เราวางแผนได้ดีขึ้น):
   - ขนาดฐานข้อมูล db_ACC_SNP ปัจจุบัน เทียบกับ ceiling 10GB ของ SQL Server Express
     (EXEC sp_spaceused) — Change Tracking จะเพิ่มตารางภายในเล็กน้อยตามจำนวนแถวที่เปลี่ยนแปลง
   - ตาราง dbo.InventoryFlowDtl / dbo.InventoryFlowHdr เคยมีการ DELETE แถวจริงหรือไม่ หรือการ
     "กลับรายการ" ทำผ่านเอกสารใหม่เสมอ (ไม่ลบของเดิม)? — มีผลต่อวิธีที่เราตรวจจับการเปลี่ยนแปลง
   - ทั้ง 3 ตารางมี PRIMARY KEY หรือไม่ (Change Tracking บังคับต้องมี PK) — เราจะตรวจสอบเองด้วย
     INFORMATION_SCHEMA ก่อนส่งคำขอนี้ และจะแนบผลลัพธ์ที่เราตรวจพบมาด้วย

5. ยืนยันว่าไม่มีผลกระทบต่อแอปบัญชี/ผู้ใช้ปัจจุบันของ KRS — Change Tracking ไม่เปลี่ยนพฤติกรรมการ
   query/insert/update ปกติของตารางเดิมแต่อย่างใด เป็นเพียงตารางบันทึกการเปลี่ยนแปลงเสริมภายใน
   SQL Server engine เอง

ความปลอดภัย: ฝั่ง POS จะอ่านอย่างเดียว (CHANGETABLE(CHANGES ...) + sp_Onhand แบบ warehouse-scoped
เดิม) ไม่มีการ INSERT/UPDATE/DELETE ใดๆ เข้าตารางของ KRS จากคำขอนี้
```

**Gate:** vendor confirms (a) CT enabled at DB + 3-table level with the given/adjusted retention, (b)
our connection login has `VIEW CHANGE TRACKING` (or already has sufficient rights), (c) all 3 tables
have a PK (P0.1's own INFORMATION_SCHEMA check should already have proven this before sending the
letter — the letter's item 4 is a courtesy double-check, not our only source of truth). Only after
this gate does P1 begin.

### P0 — Verification Evidence

- P0.1 (our own read-only queries): recorded query output for edition, `IsChangeTrackingEnabled`,
  the PK-existence check (must show a PK row for all 3 tables), and `sp_spaceused` — captured into
  `process/features/krs-sync/references/krs-ct-vendor-request_P0_16-07-26.md` alongside the letter.
- P0.2 (vendor gate): vendor confirmation (written, e.g. email/chat quoted into the reference doc)
  that CT is enabled at DB + table level, retention accepted, and permission granted. **No code is
  produced in P0** — this phase's "done" is a fact-confirmation artifact, not a build.

---

## P1 — CT poller + shared reconcile engine + legacy `autoSync.ts` refactor

**Depends on:** P0 vendor gate confirmed (CT enabled, PK columns known, login permission granted).

### P1.1 — CT read helpers (new module)

**New file:** `src/lib/krs/changeTracking.ts` (NODE-ONLY, mirrors the header-comment discipline of
`stock.ts`/`products.ts` — imported only by server route code, never client/edge).

Exports:

```ts
export type CtChangeSummary = {
  changedWarehouseCodes: string[];   // distinct KRS WarehouseCode values touched this cycle
  inventoryItemChanged: boolean;     // true if ANY InventoryItem row changed this cycle
  newVersion: bigint;                // the CT version to advance the cursor to on success
};

export async function checkCursorValidity(
  config: sql.config,
  storedVersion: bigint | null
): Promise<{ valid: boolean; minValidVersion: bigint | null }>;

export async function fetchChangesSince(
  config: sql.config,
  sinceVersion: bigint
): Promise<CtChangeSummary>;
```

**Honesty note (do not over-specify before P0 delivers facts):** the exact `JOIN` predicate inside
`fetchChangesSince` depends on the REAL primary key columns of `InventoryFlowDtl`/`InventoryFlowHdr`/
`InventoryItem`, which P0.1 discovers. The **conceptual** algorithm (finalize the literal SQL once the
PK is known):

```sql
-- (A) Direct Dtl changes → changed (ItemCode, Warehouse) pairs for surviving rows.
-- CHANGETABLE returns the tracked table's PK columns + SYS_CHANGE_OPERATION/VERSION/CONTEXT.
-- LEFT JOIN back to the base table (bound @sinceVersion as sql.BigInt; table name is a FIXED
-- literal — no injection surface, unlike the schema-browser's user-supplied table name).
SELECT ct.SYS_CHANGE_OPERATION, d.ItemCode, d.Warehouse
FROM CHANGETABLE(CHANGES dbo.InventoryFlowDtl, @sinceVersion) AS ct
LEFT JOIN dbo.InventoryFlowDtl d ON d.<PK columns> = ct.<PK columns>;
-- DELETE rows: the LEFT JOIN yields NULL Warehouse/ItemCode (the row is gone). See the
-- delete-edge-case fallback below.

-- (B) Hdr changes (approval/close flips with NO Dtl row edit) → resolve which Dtl rows they gate.
SELECT ct.SYS_CHANGE_OPERATION, h.Transactionno, h.VoucherNo
FROM CHANGETABLE(CHANGES dbo.InventoryFlowHdr, @sinceVersion) AS ct
LEFT JOIN dbo.InventoryFlowHdr h ON h.<PK columns> = ct.<PK columns>;

-- For each changed (Transactionno, VoucherNo) pair, resolve affected (ItemCode, Warehouse):
-- built as a bound-parameter OR-chain (NOT string-concatenated VALUES; mirrors the existing
-- bound-parameter-loop pattern in src/lib/krs/products.ts's projection builder), chunked at
-- e.g. 200 pairs per query to bound statement size:
SELECT DISTINCT d.ItemCode, d.Warehouse
FROM dbo.InventoryFlowDtl d
WHERE (d.Transactionno = @t0 AND d.VoucherNo = @v0)
   OR (d.Transactionno = @t1 AND d.VoucherNo = @v1)
   OR ...;

-- (C) InventoryItem changes → just a boolean flag (see "reuse existing product import" below).
SELECT ct.SYS_CHANGE_OPERATION, i.ItemCode
FROM CHANGETABLE(CHANGES dbo.InventoryItem, @sinceVersion) AS ct
LEFT JOIN dbo.InventoryItem i ON i.<PK columns> = ct.<PK columns>;
```

**Delete-edge-case fallback:** if a Dtl/Hdr CHANGETABLE row's operation is `D` (delete) and the LEFT
JOIN cannot resolve `Warehouse`/`ItemCode` (the row is gone), the cycle cannot know precisely which
warehouse was affected. Fallback: treat an unresolvable delete as "reconcile ALL known warehouses this
cycle" (falls back to the safety-net scope for just that one cycle) rather than silently dropping the
change. Ask the vendor (P0.2 item 4) whether these tables are ever truly hard-deleted; if the answer
is "never, only reversed via a new document," this fallback path should never actually fire in
practice and can be treated as defensive-only.

**Cursor validity / retention-expired handling:**

```ts
// CHANGE_TRACKING_MIN_VALID_VERSION is PER TABLE; CHANGE_TRACKING_CURRENT_VERSION() is PER DATABASE
// (one shared version number for all 3 tables). checkCursorValidity queries the per-table min-valid
// version for each of the 3 tables and compares against the single stored cursor; if storedVersion
// is null (first run) OR any table's min-valid-version exceeds it, `valid: false` → the caller must
// run a full reconcile (scope=ALL) before trusting incremental CHANGETABLE reads again.
SELECT CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('dbo.InventoryFlowDtl'));
SELECT CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('dbo.InventoryFlowHdr'));
SELECT CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID('dbo.InventoryItem'));
SELECT CHANGE_TRACKING_CURRENT_VERSION();  -- DB-scoped "as of now" version; becomes the new cursor
```

**Implementation gotcha to flag in code:** `bigint` columns/return values from `mssql`/tedious should
be verified at P1 build time for precision handling (CT version numbers are unlikely to approach
`2^53` for a very long time in a single-store deployment, but confirm the driver's default BIGINT
mapping before trusting it blindly). Any `BigInt` Prisma field must be manually stringified before it
crosses a `NextResponse.json(...)` boundary (BigInt is not natively JSON-serializable) — mirrors the
existing `Decimal.toString()` discipline already documented in this repo's conventions.

### P1.2 — Shared reconcile engine (new module, absorbs + extends `autoSync.ts` Step 8c)

**New file:** `src/lib/krs/stockReconcile.ts`.

```ts
export type ReconcileScope =
  | { kind: "ALL" }
  | { kind: "WAREHOUSES"; warehouseCodes: string[] };

export type ReconcileResult = {
  status:
    | "OK" | "PARTIAL"
    | "SKIPPED_LOCKED" | "SKIPPED_MANUAL_MODE"
    | "FAILED_PRODUCT_UPSERT" | "FAILED_KRS_FETCH";
  warehousesProcessed: string[];
  itemsUpdated: number;
  totalDelta: number;
  newProducts: number;
  errors: string[];
};

export async function reconcileWarehouses(
  config: sql.config,
  scope: ReconcileScope,
  opts?: { branchId?: string; runId?: string; refreshProducts?: boolean }
): Promise<ReconcileResult>;
```

**This module is called by BOTH `POST /api/krs/ct-poll` (scope = only the warehouses CT flagged) and
the refactored `runAutoSync` (scope = `{kind:"ALL"}`, the safety net).** They share the SAME run-lock
(moved from `autoSync.ts` into this module — one lock, one code path, cannot double-apply).

Per-run algorithm (absorbs and generalizes the existing `autoSync.ts` Step 8c per-warehouse pass):

1. Acquire the run-lock (same atomic conditional-UPDATE pattern as today's `acquireRunLock` — moved
   here verbatim). `SKIPPED_LOCKED` if another run (ct-poll OR the 5-min safety net) already holds it
   — this is the mechanism that makes the two callers mutually safe.
2. `syncMode` gate (unchanged — `KrsConnectionSettings.syncMode === "manual"` → `SKIPPED_MANUAL_MODE`).
3. **Optional product refresh** (`opts.refreshProducts`, or always when `scope.kind === "ALL"`, or
   when `changedInventoryItem` was true for the CT-triggered call): reuse the EXISTING, UNCHANGED
   `fetchKrsProducts` + `importKrsProducts` (unfiltered — pulls the whole active catalog). This is the
   simplest safe way to satisfy "reuse existing product import for just those items" without adding
   new config-supplied-identifier SQL surface; a future optimization could filter `fetchKrsProducts`
   to an explicit `ItemCode IN (...)` list, but that is NOT required for this phase's gate.
4. Resolve the warehouse set to process: `scope.kind === "ALL"` → `prisma.warehouse.findMany()` (all
   known warehouses, same as today's Step 8c loop); `scope.kind === "WAREHOUSES"` → exactly the given
   list (never includes the `""` global sentinel).
5. For each warehouse in scope: scoped `fetchKrsStockBalances(config, warehouseCode)` (existing,
   UNCHANGED helper — this plan reuses `stock.ts` as-is). For each returned `{ itemCode, balance }`:
   - `lastQty = per-warehouse KrsStockSnapshot(itemCode, warehouseCode).lastQty ?? 0` (first sighting
     → baseline 0, same convention as the existing engine).
   - `delta = toIntDelta(balance - lastQty)` (existing rounding/cap helper, reused).
   - if `delta === 0`: upsert `WarehouseStock.qty` + the snapshot's `lastQty` (keep them current) and
     count a skip — no `Product.stock` write.
   - if `delta !== 0`: **atomic** `UPDATE "Product" SET "stock" = LEAST(cap, GREATEST(0, "stock" +
     ${delta})) WHERE "sku" = ${sku}` (same `LEAST/GREATEST` atomic-on-current-row-value pattern as
     today's Step 8/8b — a concurrent checkout decrement between the read and this write is preserved,
     never clobbered), plus a `StockMovement(type: KRS_SYNC)` row, plus upsert `WarehouseStock.qty` and
     the per-warehouse `KrsStockSnapshot.lastQty = balance`, all inside ONE `prisma.$transaction` per
     item (mirrors today's transaction shape exactly).
   - No POS product for the sku → same handling as today (snapshot advances so the drift is not
     re-detected forever; error collected; no stock write).
6. **Baseline redefinition mechanism (D4 in Locked Decisions) — the load-bearing detail:** the global
   `KrsStockSnapshot("", "")` sentinel row is **retired from delta math entirely**. It is no longer
   read as "the" baseline. `Product.stock` is, from this phase forward, the accumulated result of
   independently-tracked PER-WAREHOUSE deltas (step 5 above) — there is no synthetic "Σ mirror" to
   keep in lock-step, because nothing reads a global baseline anymore. The sentinel row's ONLY
   remaining job is the run-lock (`lockedAt`), which stays exactly where it is today (same key,
   same acquire/release helpers, just relocated into this module). This is deliberately SIMPLER than
   trying to keep a derived global number synchronized — one baseline definition, per warehouse,
   already existing since Branch/Warehouse Phase 5, now finally load-bearing instead of display-only.
7. Record a `SyncJob(PULL)` row (best-effort, unchanged pattern) with `{ warehousesProcessed,
   itemsUpdated, totalDelta, newProducts }` in the response payload.
8. Release the run-lock in `finally` (unchanged).
9. **After every successful (or partial) run, broadcast SSE events** (see P2) for every sku whose
   stock actually changed this run, plus a product-update event if step 3 ran.

### P1.3 — Legacy `autoSync.ts` refactor (highest-risk touchpoint of this program)

**Changed file:** `src/lib/krs/autoSync.ts`.

- **Deleted:** the entire "global pass" (today's Steps 4, 5, 7, 8, 8b) that calls
  `fetchKrsStockBalances(config, options.warehouse ?? null)` — i.e. the call that, per
  `krs-onhand-global-discrepancy_REPORT_15-07-26.md`, is fed by KRS's internally-broken global
  aggregate. This is the exact code path responsible for the 15-07-26 incident's "Attempt 1" failure
  mode (global baseline chasing a broken global read). It is retired, not patched further.
- **Kept, generalized, and MOVED into `stockReconcile.ts`:** today's Step 8c per-warehouse pass (the
  lock, the warehouse loop, the `WarehouseStock`/per-warehouse-snapshot upserts) — this becomes the
  shared engine's core (see P1.2 step 5), now ALSO writing `Product.stock` atomically (today it is
  display-only; from P1 onward it is authoritative).
- **`runAutoSync` becomes a thin wrapper:**

  ```ts
  export async function runAutoSync(
    config: sql.config,
    options: AutoSyncOptions
  ): Promise<AutoSyncResult> {
    const result = await reconcileWarehouses(config, { kind: "ALL" }, {
      branchId: options.branchId,
      runId: options.runId,
      refreshProducts: true,
    });
    // Map ReconcileResult -> the EXISTING AutoSyncResult shape so
    // POST /api/krs/auto-sync's external response contract is UNCHANGED.
    return mapReconcileResultToAutoSyncResult(result);
  }
  ```

  `AutoSyncOptions`/`AutoSyncResult` **types are kept** (external contract stability — see Public
  Contracts below); only the internals change. `options.warehouse` (the old `KRS_AUTO_SYNC_WAREHOUSE`
  filter) becomes moot for the global-pass concept (there is no more global pass) — document this
  explicitly in a code comment; the env var itself can stay defined but its runtime effect on this
  path is now a no-op (flag as a P3 cleanup candidate: consider deprecating
  `KRS_AUTO_SYNC_WAREHOUSE` in a later pass rather than silently repurposing it here).
- **Cadence unchanged:** the existing `krs-cron` sidecar (`docker-compose.prod.yml`,
  `KRS_AUTO_SYNC_INTERVAL_SECONDS`, default 60s per `.env.example`) keeps polling
  `POST /api/krs/auto-sync` at its current interval — now serving as the **full-reconcile safety net**
  (catches drift CT might miss: a not-yet-imported warehouse, a permission hiccup, a retention-expired
  reinit that the realtime path already handled but is worth double-checking, etc.), not the primary
  realtime path.

**Mandatory regression check before P1 is called done:** re-verify against the exact 667-item
discrepancy scenario from `krs-onhand-global-discrepancy_REPORT_15-07-26.md` (or a synthetic
equivalent on a dev/test KRS instance) — confirm the refactored engine does **not** reproduce
"Attempt 1"'s failure mode (a good per-warehouse-derived stock value getting zeroed by a stale/broken
global comparison). This is not optional; a regression here has the exact same user-visible blast
radius as the original incident (checkout `INSUFFICIENT_STOCK` on sellable items).

### P1.4 — New cursor storage (Prisma migration)

**New Prisma model** (additive-only migration, e.g. `krs_ct_cursor`):

```prisma
// KRS Change Tracking cursor (krs-realtime-inbound P1). Singleton — mirrors ShopSettings/
// KrsConnectionSettings (id @default("singleton")). CHANGE_TRACKING_CURRENT_VERSION() is
// DATABASE-scoped (one version number for the whole db_ACC_SNP, not per-table), so ONE bigint
// cursor covers all 3 tracked tables. `reinitCount` is incremented every time
// checkCursorValidity() finds the stored version has fallen below a table's
// CHANGE_TRACKING_MIN_VALID_VERSION (retention exceeded) and a full reconcile is triggered instead
// of an incremental read — surfaced on the /data status pill (P3) for ops visibility.
model KrsCtCursor {
  id           String    @id @default("singleton")
  lastVersion  BigInt?
  lastPolledAt DateTime?
  lastCycleMs  Int?
  lastError    String?
  reinitCount  Int       @default(0)
  updatedAt    DateTime  @updatedAt
}
```

### P1.5 — Trigger endpoint

**New file:** `src/app/api/krs/ct-poll/route.ts`. Mirrors `POST /api/krs/auto-sync` EXACTLY (same
`bearerMatches` constant-time-compare helper — extract/share it rather than re-implement, e.g. move it
to a small shared `src/lib/krs/bearerAuth.ts` helper used by auto-sync/dispatch/ct-poll alike, OR
duplicate the ~15-line helper as the existing 3 routes already independently do — prefer extracting
since this is now the 3rd copy):

1. Bearer check against `KRS_CT_POLL_TRIGGER_SECRET` (constant-time, generic 401, never logged).
2. Kill-switch gate: `KRS_CT_POLL_ENABLED !== "true"` → 422.
3. Build KRS config (`buildConnectionConfig()`, unchanged).
4. Load `KrsCtCursor` singleton; if absent or `checkCursorValidity` says invalid → full reconcile
   (`reconcileWarehouses(config, {kind:"ALL"})`), then set `lastVersion =
   CHANGE_TRACKING_CURRENT_VERSION()`, `reinitCount += 1`.
5. Else → `fetchChangesSince(config, cursor.lastVersion)` → `reconcileWarehouses(config,
   {kind:"WAREHOUSES", warehouseCodes: summary.changedWarehouseCodes}, {refreshProducts:
   summary.inventoryItemChanged})` (skip entirely, cheaply, if `changedWarehouseCodes.length === 0 &&
   !inventoryItemChanged` — no-op cycle, just advance the cursor and update `lastPolledAt`/
   `lastCycleMs`).
6. Update `KrsCtCursor` (`lastVersion`, `lastPolledAt`, `lastCycleMs`; `lastError` cleared on success).
7. On any failure at any step: catch, sanitize (never raw mssql error/config), set
   `KrsCtCursor.lastError` best-effort, log, return a structured non-2xx response — **never throw
   further, never touch checkout**. The next cycle simply retries from the last successfully-advanced
   cursor.

**Pool-reuse deviation (explicit, justified):** every existing KRS query helper (`stock.ts`,
`products.ts`, `client.ts`) opens a throwaway per-call `sql.ConnectionPool` (open → query → close).
That is correct for admin-triggered, infrequent calls. At a 2-second cadence, paying a fresh
TCP+TLS+auth handshake every cycle would eat a meaningful slice of the latency budget. **Decision:**
`changeTracking.ts`/the ct-poll route should hold a **module-level, longer-lived connection pool**
(opened once per process, reused across polls, closed only on graceful shutdown) as a deliberate,
documented exception to the rest of the codebase's throwaway-pool convention — call out this
divergence in a code comment so a future reader does not "fix" it back to match the other files.

### P1 — Touchpoints

| File | Change |
|---|---|
| `prisma/schema.prisma` | + `KrsCtCursor` singleton model |
| `prisma/migrations/` | + new additive migration (e.g. `krs_ct_cursor`) |
| `src/lib/krs/changeTracking.ts` | NEW — CT read helpers, cursor validity check |
| `src/lib/krs/stockReconcile.ts` | NEW — shared delta-apply engine (absorbs autoSync.ts Step 8c + adds authoritative Product.stock writes + the run-lock) |
| `src/lib/krs/autoSync.ts` | MAJOR refactor — retire the broken global-call pass; `runAutoSync` becomes a thin wrapper over `reconcileWarehouses(config, {kind:"ALL"})` |
| `src/lib/krs/bearerAuth.ts` | NEW (optional but recommended) — extract the constant-time bearer helper shared by auto-sync/dispatch/ct-poll |
| `src/app/api/krs/ct-poll/route.ts` | NEW — bearer-authed poll-trigger endpoint |
| `src/app/api/krs/auto-sync/route.ts` | Minimal internal update only — still calls `runAutoSync`, response shape unchanged |
| `src/lib/env.ts` | + `KRS_CT_POLL_ENABLED` (enum true/false, default false), `KRS_CT_POLL_TRIGGER_SECRET` (min 32 chars, optional) |
| `.env.example` | document the two new vars + `KRS_CT_POLL_INTERVAL_SECONDS` (sidecar-only, not in env.ts, mirrors `KRS_AUTO_SYNC_INTERVAL_SECONDS`/`KRS_DISPATCH_INTERVAL_SECONDS`) |
| `docker-compose.prod.yml` | + `krs-ct-poll-cron` sidecar service (twin of `krs-cron`/`krs-dispatch-cron`) |

---

## P2 — Live push to `/pos`

**Depends on:** P1 verified (stock actually updates realtime server-side; P2 only adds client push).

### P2.1 — In-memory pub/sub

**New file:** `src/lib/krs/events.ts` — a thin wrapper over Node's built-in `EventEmitter`
(`node:events`), NODE-ONLY, module-level singleton. Typed emit helpers:

```ts
export function emitStockUpdate(payload: { sku: string; warehouseCode: string; qty: number; globalStock: number }): void;
export function emitProductUpdate(payload: { sku: string; name: string; price: string; isActive: boolean; imageUrl: string | null }): void;
export function emitCtQueueStatus(payload: { lastPolledAt: string; lastCycleMs: number | null; cursorAgeMs: number; reinitCount: number }): void;
export function subscribe(handler: (event: KrsSseEvent) => void): () => void; // returns an unsubscribe fn
```

`reconcileWarehouses` (P1.2 step 9) calls `emitStockUpdate` for every sku whose stock actually
changed, and `emitProductUpdate` when the product-refresh step ran. **Single-instance only** — this
is an in-process `EventEmitter`; a future multi-instance deploy would need a shared bus (Redis pub/sub
or equivalent) — explicitly out of scope, documented in the module header so nobody assumes it
fans out across containers.

### P2.2 — SSE endpoint

**New file:** `src/app/api/events/route.ts`:

- `requireUser()` gate (session-authed — every signed-in role, mirrors `GET /api/products`'s own
  auth level since this is a read-only, non-sensitive live-update feed for the same audience).
- Returns a `ReadableStream` response with `Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `Connection: keep-alive`.
- On connect: `subscribe()` to the in-memory emitter; on each event, write an SSE-framed
  `event: <type>\ndata: <json>\n\n` chunk to the stream controller.
- On client disconnect (`req.signal.abort`): call the returned unsubscribe function and close the
  controller — no leaked listeners.
- Named events: `stock-update`, `product-update`, `krs-queue-status`. `promo-update` is an OPTIONAL
  stretch (existing `/api/promotions` POST/PATCH could also emit through the same bus) — **not
  required for this phase's gate**; promotions already refetch on `PAYMENT_MISMATCH`, so SSE here is a
  UX nicety, not a correctness fix. Flag it as a documented, cheap follow-on rather than building it
  now.

### P2.3 — `/pos` client integration

**Changed file:** `src/app/(shell)/pos/page.tsx`.

- New `useEffect` opens `new EventSource("/api/events")` on mount (browser sends the NextAuth session
  cookie automatically for a same-origin request — no extra credentials wiring needed).
- On `stock-update`: patch the existing `products` state **by sku**, replacing only the matched
  product's object (`setProducts(prev => prev.map(p => p.sku === payload.sku ? { ...p, stock:
  payload.globalStock } : p))`) — untouched products keep their existing object reference, so the
  `React.memo`'d `ProductCard` (per the existing stable-prop discipline documented at
  `src/components/pos/ProductCard.tsx`) only re-renders the cards that actually changed.
- On `product-update`: same targeted-patch approach for name/price/isActive/imageUrl.
- Native `EventSource` auto-reconnects with backoff by default; no extra reconnect logic required
  beyond letting the browser do its job. On mount/reconnect, the **existing** `fetch("/api/products")`
  effect (unchanged) still runs and remains the source of truth for the initial/fallback load — SSE is
  purely an incremental push on top of it, never a replacement for the first paint.
- Cleanup: `eventSource.close()` in the effect's return function.

### P2 — Touchpoints

| File | Change |
|---|---|
| `src/lib/krs/events.ts` | NEW — in-memory pub/sub |
| `src/app/api/events/route.ts` | NEW — SSE endpoint, session-authed |
| `src/app/(shell)/pos/page.tsx` | + `EventSource` subscription effect, targeted sku-keyed state patch |
| `src/lib/krs/stockReconcile.ts` | (from P1) now also calls `emitStockUpdate`/`emitProductUpdate` after a successful run |

---

## P3 — Cutover + ops

**Depends on:** P2 verified end-to-end.

### P3.1 — Status pill / admin visibility

**New file:** `src/app/api/krs/ct-status/route.ts` — admin-only (`requireAdmin`), returns
`{ enabled, lastPolledAt, cursorAgeMs, lastCycleMs, reinitCount }` read from the `KrsCtCursor`
singleton (`enabled` = whether `KRS_CT_POLL_ENABLED === "true"` server-side).

**Changed/new UI:** extend `src/components/data/LiveStatusPill.tsx` (or add a small sibling component,
e.g. `src/components/data/CtStatusPill.tsx`) rendered on the `/data` screen's tab bar, polled via a
simple periodic `GET /api/krs/ct-status` (every 5–10s) rather than SSE — `/data` is an admin
diagnostics surface, not the latency-critical path; SSE is reserved for `/pos` where realtime actually
matters to a cashier.

### P3.2 — Monitoring + logging

Structured log lines each ct-poll cycle (mirrors existing `autoSync.ts` conventions):
`logger.info({ krsCtPoll: { cycleMs, warehousesTouched, itemsUpdated, cursorVersion, reinit } }, "KRS
ct-poll completed")`. Same sanitization discipline as every other KRS log line (never raw mssql
errors/config).

### P3.3 — Runbook additions

Append to (or create, if not already covering this) a KRS ops runbook in
`process/features/krs-sync/references/`:

- **Re-init procedure:** if `CHANGE_TRACKING_MIN_VALID_VERSION` exceeds the stored cursor (poller was
  down longer than the 3-day retention), the NEXT poll cycle automatically performs a full reconcile
  (`reconcileWarehouses(config, {kind:"ALL"})`) — no manual action required. Check `reinitCount` /
  logs afterward to understand why the poller was down that long (deploy restart, container crash,
  KRS connectivity loss).
- **Retention expiry:** document the 3-day window and what "expired" means operationally (a full
  reconcile is a fallback, not a data-loss event — it just re-derives the same Σ-per-warehouse truth
  from scratch, which is safe and idempotent).
- **Troubleshooting checklist:** check the `krs-ct-poll-cron` sidecar container logs; check
  `KRS_CT_POLL_ENABLED`; check the bearer secret is set; if numbers look wrong, verify CT is still
  enabled KRS-side via `sys.change_tracking_tables`/`sys.change_tracking_databases` (a vendor-side
  change could have disabled it without our knowledge).

### P3.4 — Vendor load statement

A short note (for the vendor, part of the runbook or a closing note on the P0 request doc): a
`CHANGETABLE(CHANGES ...)` poll is an index-seek against the CT internal side-table, bounded by the
**number of rows changed since the last poll** (typically a small, single-digit count per 2-second
window in a single-store deployment) — it does **not** scan the underlying ledger. This is a lighter
query, run more often, than the OLD approach (a full `sp_Onhand` aggregate SCAN + GROUP BY over the
entire `InventoryFlowHdr ⋈ InventoryFlowDtl` join, run every 5 minutes). In aggregate, polling every
2 seconds with CT is expected to place **less**, not more, total load on the KRS server than the
previous 5-minute full-scan cadence, despite running roughly 150× more often — because each poll's
cost scales with the tiny delta, not the whole ledger.

### P3 — Touchpoints

| File | Change |
|---|---|
| `src/app/api/krs/ct-status/route.ts` | NEW — admin-only status readout |
| `src/components/data/CtStatusPill.tsx` (or extend `LiveStatusPill.tsx`) | NEW/extended UI on `/data` |
| `process/features/krs-sync/references/` | + runbook additions (re-init, retention, troubleshooting, vendor load note) |
| `process/context/all-context.md` | update the KRS inbound sync section once P1–P3 ship (durable-knowledge step, per plan-lifecycle) |

---

## Public Contracts

| Endpoint / surface | Auth | Contract |
|---|---|---|
| `POST /api/krs/ct-poll` | Bearer (`KRS_CT_POLL_TRIGGER_SECRET`, constant-time compare) | Mirrors `POST /api/krs/auto-sync`'s auth exactly (503 if secret unset, 401 generic on mismatch, 422 if `KRS_CT_POLL_ENABLED!=="true"`). Response: `{ ok, cursorVersion: string, warehousesTouched: string[], itemsUpdated: number, reinit: boolean, cycleMs: number }` (`cursorVersion` is a stringified BigInt). |
| `GET /api/events` | Session (`requireUser`) | SSE stream, `Content-Type: text/event-stream`. Named events: `stock-update`, `product-update`, `krs-queue-status` (optional `promo-update`). Never blocks/awaited by any write path. |
| `GET /api/krs/ct-status` | Admin (`requireAdmin`) | `{ enabled: boolean, lastPolledAt: string | null, cursorAgeMs: number | null, lastCycleMs: number | null, reinitCount: number }`. |
| `POST /api/krs/auto-sync` | Bearer (unchanged) | **External contract UNCHANGED** — same `AutoSyncResult`-shaped JSON response. **Internal behavior changes**: now a full-reconcile safety net via the shared engine; no longer trusts the broken global `sp_Onhand` call. |
| `GET /api/products` | Session (unchanged) | Untouched by this plan — still the per-warehouse-scoped display read from Branch/Warehouse Phase 5. Now benefits from `Product.stock` finally being realtime-authoritative underneath it. |

---

## Constraints carried forward (do not relitigate)

- **Fail-open:** the ct-poll cycle skips on any KRS-side fault; POS selling is never blocked or
  delayed by this program under any failure mode.
- **Read-only on KRS for this whole program:** every SQL statement this plan's app code issues against
  KRS is a `SELECT`/`EXEC` (CHANGETABLE reads, scoped `sp_Onhand`, product master reads). The
  `ENABLE CHANGE_TRACKING`/`ALTER DATABASE` DDL is executed by the **vendor**, never by our app or by
  any migration/script in this repo.
- **No secrets in code/docs:** `KRS_CT_POLL_TRIGGER_SECRET` is a new bearer-secret env var, documented
  in `.env.example` as a placeholder only, generated the same way as the existing `KRS_SYNC_TRIGGER_
  SECRET`/`KRS_DISPATCH_SECRET` (`openssl rand -hex 32`). No real host/port/credential values are
  written into this plan or any reference doc — only the (non-secret) host/db name already public in
  `krs-real-schema_discovery_22-06-26.md`.
- **Cross-engine separation:** no mssql call is ever made inside a Prisma `$transaction`; no
  distributed transaction is attempted. All writes remain idempotent (upserts, atomic delta SQL).
- **Blast radius discipline:** `src/app/api/orders/route.ts` (checkout) is untouched by this entire
  program. `process/features/promotions/*` is untouched (aside from the OPTIONAL, not-required
  `promo-update` SSE stretch noted in P2.2, which — if built — only ADDS an emit call to the existing
  promotions route, never changes its logic).
- **Phases independently shippable:** P1 alone (no P2/P3) already delivers the realtime *server-side*
  correctness improvement (stock is realtime-accurate in the DB) even before any UI push exists; P2
  alone (without P3's polish) already delivers the user-visible "no refresh needed" experience.
- **Verify gates** every phase: `npm run type-check` + `npm run build`. P1 additionally needs a
  `vitest` pure-logic suite (see Verification Evidence below) since `changeTracking.ts`'s cursor/delta
  logic and `stockReconcile.ts`'s delta math are cleanly unit-testable without a live SQL Server.

---

## Blast Radius

- **Highest risk: `src/lib/krs/autoSync.ts` refactor (P1.3).** This is the exact file responsible for
  the 15-07-26 incident. Any regression here can zero out real, sellable stock again with the SAME
  user-visible symptom (checkout `INSUFFICIENT_STOCK` on items that should be sellable). Mandatory:
  the P1.3 regression check against the 667-item discrepancy scenario, run BEFORE this phase is called
  done — not optional, not deferred.
- **`prisma/schema.prisma` migration (P1.4):** additive-only new model (`KrsCtCursor`). Zero risk to
  existing tables/rows.
- **New `src/lib/krs/stockReconcile.ts` (P1.2):** shares the SAME sensitive `Product.stock` column as
  the retired code, now touched at up to 30× the frequency (2s vs. 60s). A subtle delta-sign or
  rounding bug would compound faster than the old cadence. Mandatory: dry-run against a non-prod/dev
  KRS connection profile (or the owner's existing test channel, per the krs-sync-program P1 precedent)
  BEFORE flipping `KRS_CT_POLL_ENABLED=true` on prod — mirrors exactly how `KRS_AUTO_SYNC_ENABLED` was
  originally rolled out as an opt-in kill switch.
- **`src/app/api/orders/route.ts` (checkout):** explicitly UNTOUCHED and out of scope for this entire
  program. Any PR under this plan that touches it is scope creep and should be rejected/split out.
- **New SSE endpoint (P2):** read-only broadcast; cannot corrupt data. Worst case is a stale/missed UI
  update, which the existing `fetch("/api/products")` on-mount behavior already covers as a fallback.
- **New ct-poll endpoint (P1.5):** mirrors the existing fail-open philosophy exactly (never
  absolute-overwrites; every write is an atomic delta against the current row value) — the risk is
  concentrated in the shared engine (see above), not the endpoint's auth/gating shell, which is a
  direct copy of the already-reviewed `auto-sync` pattern.
- **Cross-engine invariant:** preserved identically — verify before any phase is marked done that no
  mssql call has been accidentally nested inside a Prisma `$transaction`.

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Vendor cannot/will not enable CT (P0 blocked indefinitely) | HIGH | P0 is a hard external dependency; no fallback design is proposed here — if CT is refused, this program stops at P0 and a slower polling cadence (e.g. tightening the existing 60s auto-sync) would need a separate plan |
| One of the 3 tables has no PK | HIGH | P0.1's own INFORMATION_SCHEMA check catches this BEFORE the vendor letter is even sent; if found, do not send the letter as written — revisit design first |
| Baseline-redefinition bug reproduces the 15-07-26 incident | CRITICAL | Mandatory regression check (P1.3) against the exact 667-item scenario before P1 is called done; the shared single-engine design (D5) removes the "two engines disagree" failure class by construction |
| Delta-sign/rounding bug compounds faster at 2s cadence than the old 60s cadence | HIGH | Dry-run on a non-prod KRS profile before flipping `KRS_CT_POLL_ENABLED=true`; keep the 60s safety-net reconcile running in parallel as a drift-corrector even after cutover |
| Retention exceeded (poller down >3 days) silently misses changes | MEDIUM | `checkCursorValidity` explicitly detects this and triggers a full reconcile; `reinitCount` surfaced on the admin status pill (P3) so an operator notices it happened |
| Delete-edge-case (Dtl/Hdr row hard-deleted) loses the affected warehouse identity | MEDIUM | Conservative fallback: treat as "reconcile ALL warehouses this cycle"; vendor letter (P0.2 item 4) asks whether hard-deletes ever actually occur |
| mssql/tedious BIGINT precision handling for CT version numbers | LOW | Flagged as a P1 build-time verification step; CT version numbers are far from the JS safe-integer ceiling for a long time in a single-store deployment |
| SSE single-instance in-memory bus misses events if the app restarts mid-broadcast | LOW | Fail-safe by design — a missed SSE event just means the UI is stale until the next event OR the existing fetch-on-mount fallback; never a data-correctness issue (Postgres is always the source of truth) |
| Express 10GB storage cap headroom unknown | LOW | P0.1's `sp_spaceused` check + the vendor letter's advisory item 4; CT's internal side-table overhead scales with rows-changed, not row-count, so growth should be modest for a single-store deployment |
| `KRS_AUTO_SYNC_WAREHOUSE` env var becomes a no-op after P1.3 | LOW | Documented explicitly in code; flagged as a P3+ cleanup candidate (deprecate/remove in a later, separate pass — not required for this program's gate) |

---

## Verification Evidence (per phase)

| Phase | Gate type | Evidence |
|---|---|---|
| P0 | Fact-confirmation (no code) | Recorded output of the P0.1 read-only queries (edition, `IsChangeTrackingEnabled`, PK-existence for all 3 tables, `sp_spaceused`) + vendor's written confirmation that CT is enabled at DB+table level with accepted retention and the connection login has `VIEW CHANGE TRACKING` (or already sufficient rights) — captured in `process/features/krs-sync/references/krs-ct-vendor-request_P0_16-07-26.md` |
| P1 | Runtime + unit | `npm run type-check` + `npm run build` pass; NEW vitest suite for `changeTracking.ts` (mocked CHANGETABLE rows/versions → correct changed-warehouse-set extraction + correct retention-expired detection) and `stockReconcile.ts` (mocked before/after per-warehouse snapshots → correct atomic delta + no reliance on any global-sentinel read); manual runtime evidence on a dev/test KRS connection: a poll cycle updates `WarehouseStock`/`Product.stock` within the target latency; **mandatory regression evidence** — the refactored engine does NOT reproduce the 667-item 15-07-26 discrepancy scenario |
| P2 | Runtime | `npm run type-check` + `npm run build` pass; manual evidence: trigger a KRS-side (or dev-DB CT-eligible) stock change, observe the `/pos` product grid update within ~2–5s without a manual refresh; confirm `EventSource` reconnects cleanly after a dev-server restart mid-session |
| P3 | Runtime + regression | Full P0–P2 regression re-check; `/data` status pill shows real `lastPolledAt`/`cursorAgeMs`/`reinitCount`; runbook doc exists and is accurate; `npm run type-check` + `npm run build` pass |

---

## Resume and Execution Handoff

**Current state at plan creation (16-07-26):** plan-only, zero code changes. P0 is the immediate next
action and requires NO code — it is a research/discovery + vendor-letter task (the P0.1 read-only
queries can be run by a research/execute subagent against the existing KRS connection today; the
vendor letter in §P0.2 is ready to send/forward as drafted, pending owner review).

**Next valid action:** execute P0 — (a) run the P0.1 read-only INFORMATION_SCHEMA/edition/size checks
against the live KRS connection and record the output, (b) have the owner review and forward the
§P0.2 vendor letter (or the equivalent, adjusted per (a)'s findings). **P1 is BLOCKED** until the
vendor confirms CT is enabled + the real PK columns of the 3 tables are known (needed to finalize the
`CHANGETABLE ... JOIN` predicate in `changeTracking.ts` — see the honesty note in P1.1).

**Orchestrator must:** select exactly this plan file
(`process/features/krs-sync/active/krs-realtime-inbound_PLAN_16-07-26.md`) before EXECUTE; do not
conflate it with the other, unrelated active plans already in this feature folder
(`krs-outbound-writeback_PLAN_25-06-26.md`, `krs-sync-phase00-contracts_PLAN_22-06-26.md`,
`krs-sync-phase01-connection_PLAN_22-06-26.md`, `krs-sync-program_PLAN_22-06-26.md` — all different,
already-mostly-resolved scope; this new plan does not supersede or touch any of them).

**Validate before "done":** each phase requires both its own gate evidence AND (for P1 specifically)
the mandatory 15-07-26-incident regression check. Do not mark P1 `✅ VERIFIED` on type-check/build
alone — the regression evidence is a hard requirement given this file's history.

**Commit discipline:** commit P0 (docs/queries only) separately from P1 (the `autoSync.ts` refactor +
new modules + migration) separately from P2 (SSE + client) separately from P3 (ops/polish) — do not
bundle the high-risk P1.3 refactor into the same commit as lower-risk UI work.

---

## Open questions for vendor / owner

**Vendor (blocks P0 → P1):**
1. Confirm CT can be enabled at the DB level (`CHANGE_RETENTION = 3 DAYS, AUTO_CLEANUP = ON`) and on
   the 3 named tables — any conflict with an existing CT consumer on `db_ACC_SNP`?
2. Confirm/grant `VIEW CHANGE TRACKING` for the login our `KrsConnectionSettings` row actually uses
   today (confirm the exact username — do not assume it is still `sa` from the original discovery
   probe; check the live `KrsConnectionSettings.username` value before drafting the final GRANT list).
3. Do `InventoryFlowDtl`/`InventoryFlowHdr` rows ever get physically `DELETE`d, or are reversals always
   a new document? (Determines whether the delete-edge-case fallback in P1.1 is a real path or purely
   defensive.)
4. Roughly how large is `db_ACC_SNP` today vs. the Express 10GB cap? (Advisory only — informs whether
   CT's internal side-table overhead is a concern.)

**Owner (does not block P0, but should be confirmed before P1/P2 execute):**
5. Is the 2-second default poll interval acceptable, or should it start more conservative (e.g. 5s)
   and be tuned down after P1 proves stable?
6. Is the 3-day retention window acceptable given expected restart/deploy/downtime patterns for this
   deploy (single Lightsail VPS)?
7. Is the single-instance, no-Redis SSE approach (D7) acceptable given the current one-container
   deploy topology, or is a future multi-instance deploy already planned (which would change this
   phase's design)?
8. Should the optional `promo-update` SSE stretch (P2.2) be included in this program's P2 gate, or
   deferred entirely to a separate, later pass?

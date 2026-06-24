Status: COMPLETE — deployed (commits c8f4afd, 989d88c, 054f291; live on prod 2026-06-23/24)

# KRS Phase 1: Inbound Auto-Pull (ERP → POS) — Implementation Plan

- Feature: krs-sync
- Phase: Inbound Auto-Pull (a.k.a. "Phase 1 Auto" — distinct from the earlier krs-sync P1 Connection plan)
- Date: 2026-06-23
- Complexity: COMPLEX
- Status: READY TO PLAN — grounded on krs-writeback-spec-request_23-06-26.md + real KRS schema + existing codebase
- Umbrella: `process/features/krs-sync/active/krs-sync-program_PLAN_22-06-26.md`
- Spec authority: `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md`
- Report destination: `process/features/krs-sync/reports/`
- Plan artifact: `process/features/krs-sync/active/krs-inbound-auto-pull_PLAN_23-06-26.md`

---

## ★ LOCKED DECISIONS (owner-approved 2026-06-23 — these OVERRIDE the defaults written in §3.1, §9, §15)

The executor MUST follow these locked choices wherever they conflict with the "default" wording later in this plan:

1. **Scheduler = Docker Compose cron sidecar (§9.2), NOT host cron (§9.1).** Implement the `krs-cron` sidecar. Place it in `docker-compose.prod.yml` (the production overlay, alongside `caddy`) — NOT the base `docker-compose.yml` — so a local base-only `docker compose up` does not run the scheduler; it activates only in the prod overlay. The sidecar reaches the app at `http://app:3000/api/krs/auto-sync` on the internal compose network. Use `curlimages/curl` + busybox `crond` per §9.2.
2. **Interval = every 5 minutes** → `KRS_AUTO_SYNC_CRON_SCHEDULE` default = `*/5 * * * *`. This env var IS in scope now (it was conditional in §9.4). Document it in `.env.example` (placeholder/default only).
3. **Warehouse = ALL warehouses** → `KRS_AUTO_SYNC_WAREHOUSE` stays empty/unset (passes `@Warehouse = NULL` to `sp_Onhand`). Keep the env var + validation as planned, just defaulted empty.

Adopted-as-planned defaults (no change): `KRS_AUTO_SYNC_ENABLED=false` (opt-in kill switch), empty-`sp_Onhand` fail-safe abort (§7.2 / §11.8), mandatory security-reviewer pass on the new bearer-auth endpoint before any prod deploy.

**Added touchpoint (decision 1):** `docker-compose.prod.yml` — add the `krs-cron` service (reads `KRS_SYNC_TRIGGER_SECRET` + `KRS_AUTO_SYNC_CRON_SCHEDULE` from env). **Added env var (decision 2):** `KRS_AUTO_SYNC_CRON_SCHEDULE` (optional, default `*/5 * * * *`) — add to `.env.example` only. Keep it OUT of the app `EnvSchema`/`env.ts` (it is consumed by the sidecar shell, not the Next app — no app coupling).

> NOTE (load at 5-min cadence): each run re-runs the full product upsert (`fetchKrsProducts` → ~2,020 upserts) every 5 minutes in addition to the stock delta. Acceptable for a single store; if it becomes heavy, the product-upsert step can later be decoupled to a slower cadence than the stock delta. Not a blocker.

---

## 0. Framing and Naming Clarification

The krs-sync program previously planned phases P0–P4 around the original connection→outbound→inbound scope. This plan is a NEW parallel deliverable: **inbound auto-pull (ERP → POS)** that is explicitly separate from and does NOT depend on the outbound (POS → KRS) work. The outbound write-back spec request (`krs-writeback-spec-request_23-06-26.md`) was sent to the KRS team and is BLOCKED pending their response. This plan proceeds on the inbound side only, which is already unblocked (we have a working read path via `dbo.sp_Onhand`).

Throughout this plan, references to code that "already exists" from P1 mean the krs-sync Phase 1 connection work, which is already committed (migrations `krs_connection_settings` + `krs_field_mapping` present; `src/lib/krs/` has `client.ts`, `crypto.ts`, `stock.ts`, `products.ts`, `importProducts.ts`, `mapping.ts`, `index.ts`; API routes `settings`, `test-connection`, `schema`, `sync-stock`, `pull-products`, `reconcile`, `mappings` all exist).

---

## 1. Problem Statement and Ownership Model

### 1.1 The gap this plan closes

The existing `POST /api/krs/sync-stock` route performs an **absolute baseline** overwrite: it reads `sp_Onhand` and sets every `Product.stock = KRS on-hand`. This is correct for a **store-closed full-reset** scenario (e.g., overnight close, first import). It is **wrong for continuous/scheduled auto-sync** because:

- POS sells product A: stock 10 → 7 (−3 deducted at checkout)
- KRS has not received the sale yet (Phase 2 outbound is not built)
- KRS `sp_Onhand` still reports 10 for product A
- An auto absolute-overwrite would SET stock back to 10 — the 3 units sold disappear

### 1.2 Ownership model (Model C — split by movement type)

This is already decided (krs-writeback-spec-request §2):

- **KRS owns:** receipts / adjustments / purchases → POS should PULL these
- **POS owns:** sales (stock-out) → to be PUSHED in Phase 2 (BLOCKED pending KRS spec)

The auto-pull must apply only the delta attributable to KRS-side movements (receipts/adjustments/purchases), **not** reset POS-owned sale deductions.

### 1.3 Solution: Delta-based incremental pull

**Algorithm:**

```
For each run of auto-pull:
  1. Call sp_Onhand → get current KRS on-hand per item (Map<sku, krsCurrentQty>)
  2. Load KrsStockSnapshot per item (Map<sku, lastSeenKrsQty>)
  3. For each item in krsCurrentQty:
       delta = krsCurrentQty - lastSeenKrsQty  (if no snapshot: delta = krsCurrentQty, seed = 0)
       if delta == 0: skip (idempotent — no change in KRS)
       if delta > 0: ERP received goods → apply +delta to POS stock
       if delta < 0: ERP adjustment (return/write-down) → apply delta (clamped: pos_stock + delta >= 0)
     Record StockMovement(type=KRS_SYNC, qty=|delta|, reference=<run_ref>) for audit
     Update KrsStockSnapshot to krsCurrentQty
  4. For items that were in last snapshot but NOT in this run's sp_Onhand result:
       (item was removed from KRS or zeroed out — no delta applied; snapshot updated to 0)
  5. For new POS products added by auto product-upsert (new sku, no prior snapshot):
       First run: snapshot was 0 → delta = krsCurrentQty → apply full KRS qty as initial stock
  6. Log run summary; record SyncJob(PULL) for audit/UI visibility
```

**Why this is correct (Model C proof):**

- `krsCurrentQty` includes: all KRS-posted receipts + adjustments + purchases (all of which `sp_Onhand` counts)
- `krsCurrentQty` does NOT include: POS sales (not sent to KRS yet)
- Therefore `delta = krsCurrentQty - lastSeenKrsQty` = new ERP-originated movements only
- Applying `+delta` to POS stock = exactly the ERP-side changes, leaving POS-side sale deductions intact

---

## 2. Scope

### 2.1 In scope

1. **`KrsStockSnapshot` Prisma model** — stores the last-seen KRS on-hand per item. New model, new additive migration.
2. **`StockMovementType` enum extension** — add `KRS_SYNC` value for delta-applied movements. Additive migration.
3. **`src/lib/krs/autoSync.ts`** — delta-computation engine (`runAutoSync`). Pure logic, testable.
4. **`POST /api/krs/auto-sync`** — secret-protected trigger endpoint (bearer secret, NOT session auth). The scheduler calls this.
5. **Scheduler mechanism** — a host-side cron command (or Docker compose cron sidecar) that hits the endpoint on a schedule.
6. **Auto product upsert** — on each auto-sync run, re-run the product-upsert step first (reuses `fetchKrsProducts` + `importKrsProducts`). New KRS items arrive with delta = full KRS on-hand (snapshot seeded at 0).
7. **New env vars** — `KRS_SYNC_TRIGGER_SECRET`, `KRS_AUTO_SYNC_ENABLED`, `KRS_AUTO_SYNC_WAREHOUSE`. Document in `.env.example` (placeholders only). Validate in `src/lib/env.ts`.
8. **`KrsConnectionSettings.syncMode` gating** — when `syncMode = "manual"`, the auto-sync endpoint returns 422 (not disabled, but refuses to run). When `syncMode = "realtime"` or `"daily"`, it runs.
9. **Snapshot seeding on manual baseline** — when `POST /api/krs/sync-stock` (absolute baseline) runs, it ALSO seeds/updates `KrsStockSnapshot` so the next auto-sync delta is computed correctly.
10. **Concurrency lock** — a run-lock row in `KrsStockSnapshot` (or a dedicated `KrsAutoSyncLock` table) prevents two overlapping runs from double-applying deltas.
11. **`SyncJob(PULL)` record** — each auto-sync run records a `SyncJob` row for UI/badge visibility and audit.

### 2.2 Explicitly out of scope

- Outbound (POS → KRS) — blocked, separate plan
- KRS schema changes of any kind
- Per-warehouse filtering beyond a single configured warehouse value
- UI for scheduling (cron interval is host-level config, not in-app UI)
- Automatic rollback of past delta applications
- Customer or tax-invoice inbound sync

---

## 3. Architecture Decisions

### 3.1 Scheduler: external trigger via secret-protected endpoint (Approach A — CHOSEN)

Two options were evaluated:

**Option A: External trigger endpoint + host cron / sidecar cron**
- A new `POST /api/krs/auto-sync` endpoint protected by a **bearer secret** (`Authorization: Bearer <KRS_SYNC_TRIGGER_SECRET>`) — NOT session auth (no user session in a cron context)
- Called by: (a) `crontab` on the VPS host, or (b) a lightweight `docker compose` cron sidecar using `mcr.microsoft.com/powershell` or `curlimages/curl`
- Survives app restarts (the scheduler is external; the app is stateless)
- Fully controllable (pause by disabling the cron entry)
- Each trigger is a clean HTTP request with its own error handling
- The endpoint is a NEW machine-auth path — flags a security-reviewer pass at execute time

**Option B: In-app node-cron / setInterval**
- A background timer in the Next.js server process
- Problems: Next.js App Router route handlers are stateless per-request; a background timer in a Next.js server module is unreliable (cold starts, serverless deployments, process restarts reset the timer); harder to observe and control
- Only viable if the app is guaranteed to be a single long-running process — which Docker compose single-instance IS, but the coupling is fragile

**Decision: Option A.** Decoupled, controllable, survives restarts. The security-reviewer pass at execute time is mandatory (new machine-auth path).

### 3.2 Run-lock: advisory lock on a dedicated DB row (CHOSEN)

To prevent two overlapping scheduler triggers from double-applying deltas, the auto-sync run acquires an exclusive advisory lock before computing deltas. Mechanism:

A dedicated singleton row in `KrsStockSnapshot` at `itemCode = "__LOCK__"` (a magic key that can never be a real KRS ItemCode because KRS item codes follow a product-code format). At run start: attempt an atomic `UPDATE KrsStockSnapshot SET lockedAt = NOW() WHERE itemCode = '__LOCK__' AND (lockedAt IS NULL OR lockedAt < NOW() - INTERVAL '5 minutes') RETURNING *`. Zero rows returned = another run is active → skip (log, 409). One row returned = lock acquired → proceed. On completion (success or error): clear `lockedAt`.

Alternative considered: `prisma.$executeRaw` advisory lock (`pg_try_advisory_lock`). Also viable but less explicit in the data model and requires careful cleanup. The row-based lock is visible in the DB and matches existing patterns (`lockedAt` already used in the SyncJob outbox design from P0 spec §8.3).

### 3.3 Warehouse parameter

`sp_Onhand` accepts a `@Warehouse` parameter. The existing `fetchKrsStockBalances` passes `null` (all warehouses). For auto-pull, a configurable warehouse filter is desired but optional. A new env var `KRS_AUTO_SYNC_WAREHOUSE` (optional, default empty = all warehouses) controls this. If set, it is passed as the `@Warehouse` parameter. Because this is an env var (not user input), it is shape-validated at boot via `env.ts` (no injection surface — it is passed as a bound mssql parameter, never concatenated).

### 3.4 StockMovementType for delta

The existing `StockMovementType` enum has `RECEIVE`, `SALE`, `ADJUST`. A new value `KRS_SYNC` is added. This is additive (Postgres ADD VALUE to an enum is safe in Prisma migrations). Each delta application writes one `StockMovement` row with `type = KRS_SYNC`, `qty = |delta|` (always positive, sign encoded in `reference`), and `reference = "KRS_AUTO:<run_id>:<+/->delta"` for audit traceability.

### 3.5 Snapshot model design

A new Prisma model `KrsStockSnapshot`:

```
model KrsStockSnapshot {
  itemCode   String   @id       // KRS ItemCode = POS Product.sku (trimmed)
  lastQty    Decimal  @db.Decimal(12,4)  // last seen sp_Onhand Balqty (fractional KRS value, not rounded)
  lockedAt   DateTime?          // run-lock sentinel (only used for itemCode = "__LOCK__")
  updatedAt  DateTime @updatedAt
}
```

Why `Decimal(12,4)` for `lastQty`: `sp_Onhand` returns `Balqty` which can be fractional (the KRS `Balqty` column is a numeric decimal). Storing the raw fractional value in the snapshot and rounding only when applying the delta to `Product.stock` (Int) preserves precision and allows detecting any change (including sub-unit adjustments).

Why `@id` on `itemCode`: each item has exactly one snapshot row. No separate PK needed. Upsert is `upsert({ where: { itemCode }, update: {...}, create: {...} })`.

### 3.6 First-run seeding

**Scenario:** no `KrsStockSnapshot` row exists for item F01-0001.
- `lastQty` is treated as `0` (the snapshot is absent = never pulled before)
- `delta = krsCurrentQty - 0 = krsCurrentQty`
- This applies the FULL KRS on-hand as the initial stock for that item
- A `StockMovement(KRS_SYNC, qty=krsCurrentQty)` is recorded

This is correct: if the POS has never seen this item's KRS state, the full KRS on-hand is the best bootstrap.

**Prerequisite:** if `POST /api/krs/sync-stock` (absolute baseline) was already run before auto-pull is activated, the snapshot must be seeded from that baseline. The plan includes updating `sync-stock` to also seed/update `KrsStockSnapshot`. This prevents the first auto-pull from incorrectly treating the full KRS on-hand as a "new" delta.

### 3.7 Product upsert ordering within a run

Auto-sync run order:
1. Product upsert (reuse `fetchKrsProducts` + `importKrsProducts`) — ensures new KRS items exist as POS `Product` rows before delta is applied. New items have `stock = 0` from the upsert (default) and `snapshot = absent → seed on delta step`.
2. Fetch sp_Onhand balances
3. Compute + apply deltas
4. Update snapshots
5. Record SyncJob

If product upsert fails: the run logs the error and skips the delta step entirely (fail-safe). If product upsert succeeds but sp_Onhand fails: the run logs and exits (fail-safe, no delta applied, no snapshot updated).

---

## 4. Schema / Migration Changes

### 4.1 New model: `KrsStockSnapshot`

```prisma
// KRS on-hand snapshot per item (krs-sync inbound auto-pull). One row per
// KRS ItemCode (= POS Product.sku). Stores the last-seen sp_Onhand Balqty
// so the auto-sync delta engine can compute ERP-originated movements only
// (delta = currentKrsQty − lastSeenKrsQty). See src/lib/krs/autoSync.ts.
//
// The magic row itemCode = "__LOCK__" is the run-lock sentinel (lockedAt field);
// it is never a real product snapshot and is never included in delta computation.
//
// ADDITIVE ONLY — no existing table altered.
model KrsStockSnapshot {
  itemCode  String    @id               // KRS ItemCode (trimmed) = POS Product.sku
  lastQty   Decimal   @db.Decimal(12, 4) // last seen sp_Onhand Balqty (raw fractional)
  lockedAt  DateTime?                   // run-lock sentinel (only itemCode="__LOCK__")
  updatedAt DateTime  @updatedAt
}
```

### 4.2 Enum extension: `StockMovementType`

Add `KRS_SYNC` to the existing enum:

```prisma
enum StockMovementType {
  RECEIVE
  SALE
  ADJUST
  KRS_SYNC   // auto-pull delta (ERP receipt/adjustment applied to POS stock)
}
```

Prisma migration uses `ALTER TYPE ... ADD VALUE` for Postgres enum extension. This is additive and safe — no existing rows are affected.

### 4.3 Migration name

Suggested: `krs_auto_sync_snapshot`

Prisma command: `npx prisma migrate dev --name krs_auto_sync_snapshot`

This is one migration containing both the new model and the enum extension.

### 4.4 No changes to existing models

- `KrsConnectionSettings` — no change
- `Product` — no schema change (`stock Int` is already the target field)
- `SyncJob` — no schema change (existing `type`, `direction`, `status` fields are sufficient; the `SyncJob.type = PULL` value is used for inbound pull records)
- `StockMovement` — no schema change (new enum value, existing fields `productId`, `type`, `qty`, `reference`, `branchId`, `createdAt` are sufficient)

---

## 5. New Env Vars

Three new env vars are added. All documented in `.env.example` with placeholders only (no real values committed).

### 5.1 `KRS_SYNC_TRIGGER_SECRET`

| Property | Value |
|---|---|
| Purpose | Shared bearer secret authenticating calls to `POST /api/krs/auto-sync` from the cron scheduler. Must match the `Authorization: Bearer <value>` header sent by the cron command. |
| Format | Min 32 characters. High-entropy random string. Generate: `openssl rand -hex 32` |
| Required | OPTIONAL at boot (app boots without it; the endpoint returns 503 if unset when called). Validated lazily at the endpoint. |
| Validation | In `src/lib/env.ts`: optional string, min 32 chars when present (shape check). Fail-fast at endpoint call time if unset. |
| `.env.example` entry | `KRS_SYNC_TRIGGER_SECRET=` with generation hint comment |
| NEVER | committed, logged, or returned in any response |

### 5.2 `KRS_AUTO_SYNC_ENABLED`

| Property | Value |
|---|---|
| Purpose | Kill switch for the auto-sync feature. When `false`, the `POST /api/krs/auto-sync` endpoint returns 422 immediately (disabled). |
| Format | `"true"` or `"false"` |
| Default | `"false"` (auto-sync is OPT-IN — must be explicitly enabled) |
| Validation | In `src/lib/env.ts`: optional boolean-string, defaults to `"false"` |
| `.env.example` entry | `KRS_AUTO_SYNC_ENABLED=false` with comment |

### 5.3 `KRS_AUTO_SYNC_WAREHOUSE`

| Property | Value |
|---|---|
| Purpose | Optional warehouse filter for `sp_Onhand`. Passed as the bound `@Warehouse` parameter. Empty string or unset = all warehouses (NULL). |
| Format | String ≤ 20 chars, conservative charset (matches KRS warehouse code format, e.g. `WHFG`). |
| Default | Empty (all warehouses) |
| Validation | In `src/lib/env.ts`: optional string, ≤20 chars, no control chars (shape check). Passed as bound parameter — never concatenated. |
| `.env.example` entry | `KRS_AUTO_SYNC_WAREHOUSE=` with comment |

### 5.4 `.env.example` additions (exact placement)

Under the existing `# KRS Sync — ...` section, add:

```
# KRS auto-sync trigger secret (bearer auth for POST /api/krs/auto-sync).
# The cron scheduler sends: Authorization: Bearer <this value>
# OPTIONAL at boot; required to use the auto-sync endpoint.
# Generate: openssl rand -hex 32  — git-ignored .env only; NEVER commit.
KRS_SYNC_TRIGGER_SECRET=

# Auto-sync kill switch. Must be explicitly "true" to enable the scheduler endpoint.
# Default false (opt-in). Set to "true" in production after verifying delta logic.
KRS_AUTO_SYNC_ENABLED=false

# Optional KRS warehouse filter for sp_Onhand (@Warehouse param). Empty = all warehouses.
# Example: KRS_AUTO_SYNC_WAREHOUSE=WHFG  (the test warehouse with 9 items F01-0001..0009)
KRS_AUTO_SYNC_WAREHOUSE=
```

---

## 6. Touchpoints (Every File Created or Modified)

### 6.1 New files

| File | Purpose |
|---|---|
| `src/lib/krs/autoSync.ts` | Delta computation engine. Pure async function `runAutoSync(config, warehouse, branchId, runId)`. Handles: product upsert, sp_Onhand fetch, delta loop, snapshot update, StockMovement write, SyncJob record. Returns `AutoSyncResult`. |
| `src/app/api/krs/auto-sync/route.ts` | `POST /api/krs/auto-sync` — machine-auth endpoint (bearer secret, NOT session). Calls `runAutoSync`. Returns structured result. Requires security-reviewer pass before deploy. |
| `prisma/migrations/<timestamp>_krs_auto_sync_snapshot/` | Generated migration for `KrsStockSnapshot` model + `KRS_SYNC` enum value. |

### 6.2 Modified files

| File | Change | Why |
|---|---|---|
| `prisma/schema.prisma` | Add `KrsStockSnapshot` model; extend `StockMovementType` with `KRS_SYNC`. | New snapshot storage + audit ledger type. |
| `src/lib/env.ts` | Add shape-check entries for `KRS_SYNC_TRIGGER_SECRET`, `KRS_AUTO_SYNC_ENABLED`, `KRS_AUTO_SYNC_WAREHOUSE`. | Boot-time shape validation of the 3 new env vars. |
| `.env.example` | Add 3 new env var entries with generation hints + comments. | Documentation for operators. Never real values. |
| `src/app/api/krs/sync-stock/route.ts` | After absolute baseline writes `Product.stock`, ALSO upsert `KrsStockSnapshot` for every item updated. | Seeds snapshots so the first auto-pull doesn't apply the full KRS on-hand as a false delta. |
| `src/lib/krs/stock.ts` | Accept an optional `warehouse: string | null` parameter in `fetchKrsStockBalances`. Thread `KRS_AUTO_SYNC_WAREHOUSE` through. | Warehouse filtering support. |
| `src/lib/krs/index.ts` | Export `runAutoSync` and `AutoSyncResult` from `autoSync.ts`. | Public surface for the new module. |
| `src/types/index.ts` | Add `AutoSyncResult` type. | Typed return shape for UI/API consumers. |

### 6.3 No changes to these files (explicitly)

- `src/app/api/orders/route.ts` — NEVER touched (highest-risk file)
- `src/lib/prisma.ts` — untouched (Prisma singleton for Postgres, not KRS)
- Any existing KRS route other than `sync-stock`
- `src/components/` — no UI changes in this plan (auto-sync is a background mechanism, not a new UI screen)

---

## 7. Delta Algorithm — Pseudocode with Edge Cases

```typescript
// src/lib/krs/autoSync.ts (pseudocode)

async function runAutoSync(config: sql.config, options: AutoSyncOptions): Promise<AutoSyncResult> {
  const runId = crypto.randomUUID();
  const runRef = `KRS_AUTO:${runId}`;

  // === STEP 1: Acquire run-lock ===
  // Atomic conditional UPDATE on the sentinel row.
  // Lock times out after 5 minutes (generous vs. expected 10-30s run).
  const lockAcquired = await acquireRunLock(runId);
  if (!lockAcquired) {
    logger.warn({ runId }, "KRS auto-sync skipped: another run is active");
    return { status: "SKIPPED_LOCKED", runId, delta: 0, updated: 0, skipped: 0, errors: [] };
  }

  try {
    // === STEP 2: KrsConnectionSettings.syncMode gate ===
    const settings = await prisma.krsConnectionSettings.findUnique({ where: { id: "singleton" }, select: { syncMode: true } });
    if (settings?.syncMode === "manual") {
      return { status: "SKIPPED_MANUAL_MODE", runId, delta: 0, updated: 0, skipped: 0, errors: [] };
    }

    // === STEP 3: Product upsert (pull new/changed KRS items first) ===
    // This ensures new KRS items have a Product row before delta is applied.
    // Fail-safe: if product upsert throws, abort the whole run (no delta applied).
    let newProductCount = 0;
    try {
      const krsProducts = await fetchKrsProducts(config);
      const importResult = await importKrsProducts(krsProducts);
      newProductCount = importResult.created;
    } catch (productErr) {
      logger.error({ krsErr: safeErrMsg(productErr), runId }, "KRS auto-sync: product upsert failed — aborting run");
      await recordSyncJob(runId, "FAILED", `Product upsert failed: ${safeErrMsg(productErr)}`);
      return { status: "FAILED_PRODUCT_UPSERT", runId, delta: 0, updated: 0, skipped: 0, errors: [safeErrMsg(productErr)] };
    }

    // === STEP 4: Fetch current KRS on-hand ===
    // Fail-safe: if sp_Onhand throws, abort — no stock change.
    let krsBalances: KrsStockBalance[];
    try {
      krsBalances = await fetchKrsStockBalances(config, options.warehouse ?? null);
    } catch (stockErr) {
      logger.error({ krsErr: safeErrMsg(stockErr), runId }, "KRS auto-sync: sp_Onhand failed — aborting run");
      await recordSyncJob(runId, "FAILED", `sp_Onhand failed: ${safeErrMsg(stockErr)}`);
      return { status: "FAILED_KRS_FETCH", runId, delta: 0, updated: 0, skipped: 0, errors: [safeErrMsg(stockErr)] };
    }

    // === STEP 5: Load existing snapshots (all at once) ===
    const snapshots = await prisma.krsStockSnapshot.findMany({
      where: { itemCode: { not: "__LOCK__" } },  // exclude sentinel
      select: { itemCode: true, lastQty: true }
    });
    const snapshotMap = new Map<string, Decimal>(
      snapshots.map(s => [s.itemCode, s.lastQty])
    );

    // === STEP 6: Load POS products (for the product sku → id mapping) ===
    const posProducts = await prisma.product.findMany({
      select: { id: true, sku: true, stock: true }
    });
    const productMap = new Map<string, { id: string; stock: number }>(
      posProducts.map(p => [p.sku, { id: p.id, stock: p.stock }])
    );

    // === STEP 7: Build the delta map ===
    // krsCurrentMap: Map<sku, currentKrsQty (raw Decimal-precision number)>
    const krsCurrentMap = new Map<string, number>();
    for (const b of krsBalances) {
      krsCurrentMap.set(b.itemCode, b.balance); // balance is already a finite JS number (see stock.ts toNum())
    }

    // === STEP 8: Apply deltas + write movements + update snapshots ===
    let totalDelta = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    for (const [sku, krsCurrentQty] of krsCurrentMap.entries()) {
      const lastQty = snapshotMap.has(sku) ? Number(snapshotMap.get(sku)!) : 0;
      const rawDelta = krsCurrentQty - lastQty;

      // EDGE CASE A: delta == 0 — KRS unchanged, POS unchanged → skip (idempotent)
      if (Math.abs(rawDelta) < 0.0001) {
        skippedCount++;
        continue;
      }

      // EDGE CASE B: item is in KRS but not in POS → new item should have been created
      // in step 3 product upsert. If still missing (upsert failed silently), skip with error.
      const posProduct = productMap.get(sku);
      if (!posProduct) {
        logger.warn({ sku, runId }, "KRS auto-sync: KRS item has no matching POS product — skipping delta");
        errors.push(`No POS product for KRS sku ${sku}`);
        // Still update snapshot so next run doesn't treat this as a perpetual delta
        await prisma.krsStockSnapshot.upsert({
          where: { itemCode: sku },
          update: { lastQty: new Prisma.Decimal(krsCurrentQty) },
          create: { itemCode: sku, lastQty: new Prisma.Decimal(krsCurrentQty) }
        });
        continue;
      }

      // EDGE CASE C: negative delta (ERP adjustment / return) — apply, but clamp POS stock >= 0
      // Do NOT simply zero POS stock on any ERP downward adjustment; only reduce by the delta.
      const intDelta = Math.round(rawDelta); // round fractional KRS qty to integer for POS Int column
      const newPosStock = Math.max(0, posProduct.stock + intDelta);
      const appliedDelta = newPosStock - posProduct.stock; // actual applied (may differ from intDelta if clamped)

      // EDGE CASE D: manual POS stock edits between runs — irrelevant to this algorithm.
      // We apply the ERP delta ON TOP of whatever POS stock currently is.
      // Example: POS stock was manually set to 5; KRS delta is +3; new stock = 8.
      // This is correct — manual POS edits are POS-owned changes; we only layer the ERP delta.

      // === Write Product.stock update + StockMovement + Snapshot in a transaction ===
      try {
        await prisma.$transaction(async (tx) => {
          // Update POS stock
          await tx.product.update({
            where: { id: posProduct.id },
            data: { stock: newPosStock },
            select: { id: true }
          });

          // Write StockMovement for audit (sign encoded in reference string)
          const sign = intDelta >= 0 ? "+" : "-";
          await tx.stockMovement.create({
            data: {
              productId: posProduct.id,
              type: "KRS_SYNC",
              qty: Math.abs(intDelta),           // always positive per existing schema convention
              reference: `${runRef}:${sign}${Math.abs(intDelta)}`,
              branchId: options.branchId ?? "BR-01"
            }
          });

          // Update snapshot to current KRS value
          await tx.krsStockSnapshot.upsert({
            where: { itemCode: sku },
            update: { lastQty: new Prisma.Decimal(krsCurrentQty) },
            create: { itemCode: sku, lastQty: new Prisma.Decimal(krsCurrentQty) }
          });
        });

        totalDelta += appliedDelta;
        updatedCount++;
      } catch (txErr) {
        // Postgres error — does not contain KRS secrets. Log + continue to next item.
        // Non-fatal: one item failure doesn't abort the whole run.
        logger.error({ err: txErr, sku, runId }, "KRS auto-sync: POS write failed for sku");
        errors.push(`POS write failed for ${sku}: ${txErr instanceof Error ? txErr.message : String(txErr)}`);
      }
    }

    // EDGE CASE E: items that disappeared from sp_Onhand (sku in last snapshot but not in this run)
    // Apply delta to 0 (the item's KRS balance is effectively 0 or the item was removed).
    // Update snapshot to 0 (not delete — we want to track "last seen 0").
    for (const [sku, lastQty] of snapshotMap.entries()) {
      if (krsCurrentMap.has(sku)) continue; // handled above
      const lastQtyNum = Number(lastQty);
      if (lastQtyNum === 0) continue; // already 0, no change
      // delta = 0 - lastQty = negative
      const intDelta = -Math.round(lastQtyNum);
      const posProduct = productMap.get(sku);
      if (!posProduct) {
        await prisma.krsStockSnapshot.update({ where: { itemCode: sku }, data: { lastQty: new Prisma.Decimal(0) } });
        continue;
      }
      const newPosStock = Math.max(0, posProduct.stock + intDelta);
      try {
        await prisma.$transaction(async (tx) => {
          await tx.product.update({ where: { id: posProduct.id }, data: { stock: newPosStock }, select: { id: true } });
          if (intDelta !== 0) {
            await tx.stockMovement.create({
              data: {
                productId: posProduct.id,
                type: "KRS_SYNC",
                qty: Math.abs(intDelta),
                reference: `${runRef}:-${Math.abs(intDelta)}:REMOVED_FROM_KRS`,
                branchId: options.branchId ?? "BR-01"
              }
            });
          }
          await tx.krsStockSnapshot.update({ where: { itemCode: sku }, data: { lastQty: new Prisma.Decimal(0) } });
        });
        updatedCount++;
      } catch (txErr) {
        logger.error({ err: txErr, sku, runId }, "KRS auto-sync: POS write failed for disappeared sku");
        errors.push(`POS write failed for disappeared ${sku}`);
      }
    }

    // === STEP 9: Record SyncJob for UI/audit ===
    const jobStatus = errors.length > 0 ? "FAILED" : "SYNCED";
    await recordSyncJob(runId, jobStatus, errors.length > 0 ? errors.join("; ") : null, {
      updated: updatedCount, skipped: skippedCount, totalDelta, newProducts: newProductCount
    });

    logger.info(
      { krsAutoSync: { runId, updated: updatedCount, skipped: skippedCount, totalDelta, newProducts: newProductCount, errors: errors.length } },
      "KRS auto-sync completed"
    );

    return {
      status: errors.length > 0 ? "PARTIAL" : "OK",
      runId,
      delta: totalDelta,
      updated: updatedCount,
      skipped: skippedCount,
      newProducts: newProductCount,
      errors
    };
  } finally {
    // Always release lock — even on uncaught exceptions
    await releaseRunLock();
  }
}
```

### 7.1 Edge case matrix

| Edge case | Description | Behavior |
|---|---|---|
| A | Delta == 0 (KRS unchanged) | Skip item — no write. Fully idempotent. |
| B | KRS item exists, no POS product | Log warning, update snapshot (track for next run), skip delta. Shouldn't happen if product upsert ran first. |
| C | Negative delta (ERP adjustment/return) | Apply delta clamped to `max(0, posStock + delta)`. Write StockMovement with negative-reference. |
| D | Manual POS stock edit between runs | Irrelevant — we add the ERP delta ON TOP of current POS stock. Manual edits are POS-owned. |
| E | Item disappears from sp_Onhand | Treat as delta to 0. Apply negative delta (clamped). Update snapshot to 0. |
| F | First run — no snapshot | `lastQty = 0 → delta = krsCurrentQty`. Full KRS on-hand becomes initial POS stock. |
| G | First run after manual baseline | `sync-stock` already seeded snapshots. delta = 0 for unchanged items. |
| H | New KRS item (appeared in sp_Onhand, not in POS) | Product upsert (step 3) creates it. stock = 0. Snapshot = absent. delta = krsCurrentQty. |
| I | KRS item fractional qty (e.g. 2.5 kg) | Raw stored in snapshot as Decimal(12,4). Rounded to nearest Int for POS. |
| J | KRS item qty < 0 (over-issued opening balance) | delta may be positive or negative. Clamped. Snapshot stores the raw negative KRS value. |
| K | Concurrent trigger (two schedulers fire) | Run-lock prevents double-apply. Second trigger returns 409 SKIPPED_LOCKED. |
| L | sp_Onhand returns 0 rows (no approved inventory docs) | Valid empty result. All items treated as "disappeared from KRS" (edge case E). Snapshot updated to 0 for all. CAUTION: this is a potentially destructive edge case — see §11.3 for the protection. |
| M | KRS unreachable / network timeout | `fetchKrsStockBalances` throws (sanitized). Run aborts. No stock change. SyncJob(FAILED) recorded. |
| N | Partial POS write failure (one item tx fails) | Error logged, run continues for other items. Returns PARTIAL status. SyncJob(FAILED). |
| O | Rerun with unchanged KRS state | All deltas == 0 (edge case A). Zero writes. Fully idempotent. |

### 7.2 Special protection for edge case L (sp_Onhand returns 0 rows)

When `sp_Onhand` returns an empty result, it may mean: (a) no approved inventory documents in KRS, (b) the warehouse parameter yielded no match, or (c) a real KRS data problem. Treating an empty result as "all items gone from KRS" and zeroing all POS stock would be catastrophic. Protection:

- A minimum-items check: if `krsBalances.length === 0` AND the snapshot table has items (i.e., this is NOT a first-run on a freshly provisioned system), the run ABORTS with `status: "ABORTED_EMPTY_KRS"` and records a FAILED SyncJob. It logs a high-severity warning.
- The threshold is: if `snapshotCount > 0` AND `krsBalances.length === 0` → abort.
- An operator can force-run with an override flag (future extension) or simply re-run the manual baseline to reset.

---

## 8. Endpoint Specification: `POST /api/krs/auto-sync`

### 8.1 Auth model

This endpoint uses **machine-to-machine bearer token auth**, NOT the NextAuth session. The reason: no browser session exists when a cron job calls it.

Auth check (in order):
1. Read `Authorization` header. If absent or not `Bearer <token>`: return 401 `{ error: "Unauthorized", code: "UNAUTHENTICATED" }`.
2. Read `env.KRS_SYNC_TRIGGER_SECRET`. If unset: return 503 `{ error: "Auto-sync trigger secret not configured", code: "AUTO_SYNC_NOT_CONFIGURED" }`.
3. Constant-time compare (use `crypto.timingSafeEqual`) the provided token against the configured secret. If mismatch: return 401.

**Security note:** a timing-safe comparison is required to prevent timing-oracle attacks on the secret. `crypto.timingSafeEqual` works on `Buffer`; both values must be encoded to the same length before comparison. If lengths differ, return 401 immediately (no comparison needed; the length itself is not secret since secrets must be min 32 chars).

**No `requireAdmin` call.** This is intentional: there is no user session. The bearer secret IS the authentication. The security-reviewer pass at execute time must specifically verify this auth path.

### 8.2 Request

```
POST /api/krs/auto-sync
Authorization: Bearer <KRS_SYNC_TRIGGER_SECRET>
Content-Type: application/json
Body: {} (empty or omit)
```

### 8.3 Response shapes

**200 OK — run completed:**
```json
{
  "ok": true,
  "runId": "uuid",
  "status": "OK" | "PARTIAL",
  "updated": 7,
  "skipped": 2,
  "delta": 15,
  "newProducts": 0,
  "errors": []
}
```

**200 OK — run skipped (lock or manual mode):**
```json
{
  "ok": true,
  "runId": "uuid",
  "status": "SKIPPED_LOCKED" | "SKIPPED_MANUAL_MODE" | "ABORTED_EMPTY_KRS",
  "updated": 0,
  "skipped": 0,
  "delta": 0
}
```

**401 Unauthorized:**
```json
{ "error": "Unauthorized", "code": "UNAUTHENTICATED" }
```

**422 Unprocessable:**
```json
{ "error": "KRS auto-sync is disabled (KRS_AUTO_SYNC_ENABLED=false)", "code": "AUTO_SYNC_DISABLED" }
```

**422 Unprocessable (KRS not configured):**
```json
{ "error": "KRS connection not configured", "code": "KRS_NOT_CONFIGURED" }
```

**500 / 502 — internal errors:**
```json
{ "error": "...", "code": "KRS_KEY_MISSING" | "KRS_FETCH_FAILED" | "INTERNAL" }
```

### 8.4 Internal flow

```
1. Validate Authorization header (bearer secret, timing-safe)
2. Check KRS_AUTO_SYNC_ENABLED env → 422 if "false"
3. buildConnectionConfig() → null = 422 KRS_NOT_CONFIGURED; KrsKeyError = 500 KRS_KEY_MISSING
4. runAutoSync(config, { warehouse: env.KRS_AUTO_SYNC_WAREHOUSE || null, branchId: "BR-01", runId: uuid() })
5. Return structured AutoSyncResult
6. All errors: sanitized (never raw mssql driver objects/config)
7. Wrap in runWithRequestId for consistent request-scoped logging
```

---

## 9. Scheduler Specification

### 9.1 Host cron approach (recommended for the existing Lightsail + Docker Compose setup)

Add a crontab entry on the Lightsail host (or inside a cron sidecar container):

```bash
# Run KRS auto-sync every 30 minutes
# Adjust frequency as agreed with the store owner
# KRS_AUTO_SYNC_ENDPOINT and KRS_SYNC_TRIGGER_SECRET come from a secure env source (not shown)
*/30 * * * * curl -s -o /var/log/krs-auto-sync.log -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer ${KRS_SYNC_TRIGGER_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://127.0.0.1:3000/api/krs/auto-sync \
  >> /var/log/krs-auto-sync-status.log 2>&1
```

Notes:
- `127.0.0.1:3000` — the app is bound to localhost (from docker-compose.yml: `"127.0.0.1:3000:3000"`). The cron on the host can reach it directly.
- The secret is sourced from a secure location on the host (e.g., a `.env` file readable only by the cron user, or a secrets manager).
- Log output goes to `/var/log/krs-auto-sync.log` for debugging.
- The HTTP status code is appended to a separate status log for quick health-checks.

### 9.2 Docker Compose cron sidecar approach (alternative)

For a fully containerized approach, add a sidecar to `docker-compose.yml`:

```yaml
  krs-cron:
    image: curlimages/curl:latest
    container_name: krs-pos-cron
    restart: unless-stopped
    depends_on:
      app:
        condition: service_healthy
    environment:
      KRS_SYNC_TRIGGER_SECRET: ${KRS_SYNC_TRIGGER_SECRET}
      CRON_SCHEDULE: ${KRS_AUTO_SYNC_CRON_SCHEDULE:-*/30 * * * *}
    # The sidecar runs crond (busybox cron) with a generated crontab
    entrypoint: |
      sh -c '
        echo "$${CRON_SCHEDULE} curl -s -X POST -H \"Authorization: Bearer $${KRS_SYNC_TRIGGER_SECRET}\" -H \"Content-Type: application/json\" -d \"{}\" http://app:3000/api/krs/auto-sync" > /var/spool/cron/crontabs/root
        crond -f -l 6
      '
```

Note: `app:3000` is the internal compose service hostname. The sidecar reaches the app on the internal Docker network.

### 9.3 Decision for this plan

**Default:** host cron (Option 9.1). Simpler, no new compose service, no additional image to maintain. The `docker-compose.yml` change in 9.2 is documented here as an OPTIONAL enhancement — the user must explicitly approve adding the sidecar before it is implemented.

**Interval:** 30 minutes is a safe starting point. The store owner can adjust the crontab entry. The plan does not hard-code the interval in application code.

### 9.4 New env var for sidecar (if sidecar approach is chosen)

`KRS_AUTO_SYNC_CRON_SCHEDULE` — optional, defaults to `*/30 * * * *`. Only relevant for the Docker sidecar approach.

---

## 10. Sync-Stock Route Update (Snapshot Seeding)

The existing `POST /api/krs/sync-stock` (absolute baseline) sets `Product.stock = krsOnHand` for all matching items. After this plan is implemented, it MUST also seed `KrsStockSnapshot` for each updated item.

**Change to `src/app/api/krs/sync-stock/route.ts`:**

After the `prisma.product.update` call for each item:

```typescript
// Seed KrsStockSnapshot so auto-pull delta starts from this baseline
await prisma.krsStockSnapshot.upsert({
  where: { itemCode: p.sku },
  update: { lastQty: new Prisma.Decimal(balance) },
  create: { itemCode: p.sku, lastQty: new Prisma.Decimal(balance) }
});
```

This must be inside or just after each product update. Because `sync-stock` currently loops per-item (no transaction), the snapshot upsert is added in the same loop iteration.

**Why this matters:** if an operator runs `sync-stock` (absolute baseline) then later enables auto-sync, without the snapshot seed the first auto-pull would compute `delta = krsCurrentQty - 0 = krsCurrentQty` for every item and incorrectly add the full KRS on-hand to already-correct POS stock.

---

## 11. Invariants (Non-Negotiable)

### 11.1 Fail-safe on KRS errors

If `buildConnectionConfig()` returns null, `KrsKeyError` is thrown, or `fetchKrsStockBalances()` throws: the run aborts with NO stock changes. A `SyncJob(FAILED)` is recorded. POS stock is NEVER zeroed or corrupted by a KRS fault.

### 11.2 Concurrency: single-run lock

Only one auto-sync run at a time. The lock row `itemCode = "__LOCK__"` in `KrsStockSnapshot` is acquired via atomic conditional UPDATE. A lock older than 5 minutes is treated as stale (reclaimed). The second concurrent trigger returns 409/SKIPPED_LOCKED immediately.

### 11.3 Idempotency: re-run with unchanged KRS

If KRS state is unchanged between runs, all deltas == 0, all items are skipped, no writes occur. The return value shows `updated: 0, delta: 0`. This is always safe to call repeatedly.

### 11.4 No absolute overwrites in auto path

The `POST /api/krs/auto-sync` endpoint NEVER calls the absolute-overwrite logic of `sync-stock`. The delta engine is the ONLY stock-update path in auto mode. The manual `POST /api/krs/sync-stock` is the ONLY path that does absolute overwrites — and it now also seeds snapshots.

### 11.5 Cross-engine separation

`src/lib/krs/autoSync.ts` uses `fetchKrsStockBalances(config)` (mssql path) for reading and `prisma` for all POS writes. The two are never mixed. No KRS mssql call is inside a Prisma `$transaction`.

### 11.6 Secret hygiene

- `KRS_SYNC_TRIGGER_SECRET` never appears in logs, responses, or error messages.
- The bearer comparison uses `crypto.timingSafeEqual`.
- The auth failure response is generic (no "wrong secret" vs "missing header" distinction beyond 401).
- `KRS_CONFIG_ENC_KEY` and the decrypted password: existing rules from P0 spec §2.5 remain in force.

### 11.7 Checkout path isolation

`src/app/api/orders/route.ts` is NOT modified by this plan. Auto-sync is a background path that never touches checkout.

### 11.8 Empty sp_Onhand protection

If `krsBalances.length === 0` AND `snapshotCount > 0`: abort the run (`ABORTED_EMPTY_KRS`). Never apply mass-zero-out on an empty KRS result when we have known prior state.

---

## 12. Implementation Steps (Ordered Checklist)

Each step is atomic and independently verifiable. The executor follows this exact sequence.

### Phase A: Schema + Migration

**Step 1.** In `prisma/schema.prisma`:
- Add `KRS_SYNC` to the `StockMovementType` enum (after `ADJUST`).
- Add the `KrsStockSnapshot` model (see §4.1 for exact definition).

**Step 2.** Run `npx prisma migrate dev --name krs_auto_sync_snapshot`. Verify the migration file is created in `prisma/migrations/`. Verify `prisma generate` runs without errors.

**Step 3.** Verify `npm run type-check` passes after schema + client generation.

### Phase B: Env Vars

**Step 4.** In `src/lib/env.ts`:
- Add `KRS_SYNC_TRIGGER_SECRET: z.string().min(32).optional()` to `EnvSchema`.
- Add `KRS_AUTO_SYNC_ENABLED: z.enum(["true","false"]).default("false")` to `EnvSchema`.
- Add `KRS_AUTO_SYNC_WAREHOUSE: z.string().max(20).optional()` to `EnvSchema`.
- In the `NEXT_PHASE === "phase-production-build"` bypass block, pass all three through unvalidated.
- Export them from `env`.

**Step 5.** In `.env.example`, add the 3 new entries under the `# KRS Sync` section (exact text from §5.4).

**Step 6.** Run `npm run type-check`. Verify `env.ts` compiles.

### Phase C: Core Logic

**Step 7.** In `src/lib/krs/stock.ts`:
- Add an optional `warehouse: string | null = null` parameter to `fetchKrsStockBalances`.
- Use it in the `request.input("Warehouse", ...)` call: pass `warehouse` instead of the hardcoded `null`.
- Preserve backward compatibility: existing callers pass no second argument → defaults to `null` (all warehouses).

**Step 8.** Create `src/lib/krs/autoSync.ts` implementing:
- `acquireRunLock(runId: string): Promise<boolean>` — atomic conditional UPDATE on `itemCode = "__LOCK__"`. Creates the sentinel row if absent (initial seeding on first call).
- `releaseRunLock(): Promise<void>` — sets `lockedAt = null` on the sentinel row.
- `recordSyncJob(runId, status, error, meta): Promise<void>` — creates a `SyncJob` row with `type = PULL`, `direction = PULL`, `ref = runId`, status, error.
- `runAutoSync(config, options): Promise<AutoSyncResult>` — full delta engine (see §7 pseudocode).
- `AutoSyncOptions` type: `{ warehouse: string | null; branchId: string; runId?: string }`.
- `AutoSyncResult` type: `{ status: string; runId: string; delta: number; updated: number; skipped: number; newProducts?: number; errors: string[] }`.
- All Prisma calls use `prisma` (the singleton from `@/lib/prisma`). No `new PrismaClient()`.
- All KRS mssql calls use the passed `config` object (already built by the caller). No `buildConnectionConfig` inside this module.
- Empty sp_Onhand protection: abort if `krsBalances.length === 0 && snapshotCount > 0`.
- Decimal handling: use `new Prisma.Decimal(value)` for snapshot writes (import `Prisma` from `@prisma/client`).

**Step 9.** In `src/types/index.ts`: add `AutoSyncResult` type export (mirrors the return shape from autoSync.ts).

**Step 10.** In `src/lib/krs/index.ts`: export `runAutoSync` and `AutoSyncResult`.

**Step 11.** Run `npm run type-check`. Fix any type errors.

### Phase D: API Endpoint

**Step 12.** Create `src/app/api/krs/auto-sync/route.ts`:
- Export `POST` handler only (no GET/PATCH).
- Auth: extract `Authorization` header, parse `Bearer <token>`, timing-safe compare against `env.KRS_SYNC_TRIGGER_SECRET`. Return 401 on any mismatch or missing header.
- Check `env.KRS_AUTO_SYNC_ENABLED !== "true"` → return 422 AUTO_SYNC_DISABLED.
- Build connection config via `buildConnectionConfig()` (handle null → 422, KrsKeyError → 500).
- Call `runAutoSync(config, { warehouse: env.KRS_AUTO_SYNC_WAREHOUSE || null, branchId: "BR-01" })`.
- Return `NextResponse.json({ ok: true, ...result })`.
- Wrap the whole handler in `runWithRequestId`.
- Import only from `@/lib/krs/autoSync`, `@/lib/krs/client`, `@/lib/krs/crypto`, `@/lib/env`, `@/lib/requestContext`, `@/lib/logger`. Do NOT import `requireAdmin` (machine auth only).
- NEVER log `KRS_SYNC_TRIGGER_SECRET` at any level.

**Step 13.** Run `npm run type-check`. Fix any type errors.

### Phase E: Sync-Stock Snapshot Seeding

**Step 14.** In `src/app/api/krs/sync-stock/route.ts`:
- In the item-update loop, after `prisma.product.update(...)`, add a `prisma.krsStockSnapshot.upsert(...)` call that seeds/updates the snapshot for `p.sku` with `lastQty = balance` (the raw balance from `krsByCode.get(p.sku)`).
- Do NOT change the absolute-overwrite logic itself.
- Import `Prisma` from `@prisma/client` for `new Prisma.Decimal(balance)`.
- The `skipped` path (stock already at KRS baseline) ALSO updates the snapshot — because even if POS stock didn't change, the snapshot should reflect the current KRS value.

**Step 15.** Run `npm run type-check`.

### Phase F: Build Verification

**Step 16.** Run `npm run build`. Verify it passes with zero errors. (The new route and lib files must compile in the Next.js build.)

**Step 17.** Run `npm run type-check` one final time after the build to confirm no latent type errors.

### Phase G: Integration Verification

**Step 18.** Manual verification against the live KRS test instance (9 WHFG items F01-0001..F01-0009):

**Pre-condition check:**
```bash
# Confirm KRS on-hand is non-zero for the 9 test items
curl -s -X GET http://localhost:3000/api/krs/reconcile \
  -H "Authorization: Bearer <admin-session-cookie>"
# Expect: rows with krsStock > 0 for the WHFG items
```

**Baseline seeding test:**
```bash
# Run manual baseline to seed snapshots
curl -s -X POST http://localhost:3000/api/krs/sync-stock \
  -H "Authorization: Bearer <admin-session-cookie>"
# Expect: { ok: true, updated: N, skipped: M }

# Verify snapshots were seeded (Prisma Studio or direct DB query):
# SELECT * FROM "KrsStockSnapshot" WHERE "itemCode" != '__LOCK__';
# Expect: rows for the items that were updated by sync-stock
```

**Idempotency test (most important):**
```bash
# Set KRS_SYNC_TRIGGER_SECRET in local .env
export KRS_SYNC_TRIGGER_SECRET=<test-secret>

# First auto-sync run (after baseline seeding)
curl -s -X POST http://localhost:3000/api/krs/auto-sync \
  -H "Authorization: Bearer ${KRS_SYNC_TRIGGER_SECRET}" \
  -H "Content-Type: application/json" -d '{}'
# MUST return: { ok: true, status: "OK", updated: 0, delta: 0, skipped: N }
# (All deltas should be 0 because baseline seeding just set snapshots to KRS on-hand)
```

**Delta detection test (simulated):**
```bash
# Manually update a snapshot to simulate "last seen was lower"
# (simulates KRS receiving a delivery since last snapshot)
# UPDATE "KrsStockSnapshot" SET "lastQty" = "lastQty" - 3 WHERE "itemCode" = 'F01-0001';

# Run auto-sync — should detect delta = +3 and apply it
curl -s -X POST http://localhost:3000/api/krs/auto-sync \
  -H "Authorization: Bearer ${KRS_SYNC_TRIGGER_SECRET}" \
  -H "Content-Type: application/json" -d '{}'
# Expect: { ok: true, status: "OK", updated: 1, delta: 3 }

# Verify StockMovement was written:
# SELECT * FROM "StockMovement" WHERE type = 'KRS_SYNC' ORDER BY "createdAt" DESC LIMIT 5;

# Run again immediately — delta should be 0 (idempotent)
curl -s -X POST http://localhost:3000/api/krs/auto-sync \
  -H "Authorization: Bearer ${KRS_SYNC_TRIGGER_SECRET}" \
  -H "Content-Type: application/json" -d '{}'
# Expect: { ok: true, status: "OK", updated: 0, delta: 0 }
```

**Auth rejection test:**
```bash
curl -s -X POST http://localhost:3000/api/krs/auto-sync \
  -H "Authorization: Bearer wrong-secret" \
  -H "Content-Type: application/json" -d '{}'
# Expect: 401 { error: "Unauthorized", code: "UNAUTHENTICATED" }

curl -s -X POST http://localhost:3000/api/krs/auto-sync \
  -H "Content-Type: application/json" -d '{}'
# Expect: 401 { error: "Unauthorized", code: "UNAUTHENTICATED" }
```

**Kill switch test:**
```bash
# Set KRS_AUTO_SYNC_ENABLED=false in .env (or env) and restart app
curl -s -X POST http://localhost:3000/api/krs/auto-sync \
  -H "Authorization: Bearer ${KRS_SYNC_TRIGGER_SECRET}" \
  -H "Content-Type: application/json" -d '{}'
# Expect: 422 { code: "AUTO_SYNC_DISABLED" }
```

**Concurrency lock test:**
```bash
# Manually set lockedAt to NOW() on the __LOCK__ row (simulates a stale run)
# UPDATE "KrsStockSnapshot" SET "lockedAt" = NOW() WHERE "itemCode" = '__LOCK__';

# Trigger auto-sync — should see lock is held (< 5 minutes old) → SKIPPED
curl -s -X POST http://localhost:3000/api/krs/auto-sync \
  -H "Authorization: Bearer ${KRS_SYNC_TRIGGER_SECRET}" \
  -H "Content-Type: application/json" -d '{}'
# Expect: { ok: true, status: "SKIPPED_LOCKED" }

# Manually set lockedAt to 10 minutes ago (simulates stale lock)
# UPDATE "KrsStockSnapshot" SET "lockedAt" = NOW() - INTERVAL '10 minutes' WHERE "itemCode" = '__LOCK__';

# Trigger auto-sync — should reclaim lock and run
curl -s -X POST http://localhost:3000/api/krs/auto-sync \
  -H "Authorization: Bearer ${KRS_SYNC_TRIGGER_SECRET}" \
  -H "Content-Type: application/json" -d '{}'
# Expect: normal run result (not SKIPPED_LOCKED)
```

---

## 13. Dependencies

| Dependency | Status | Notes |
|---|---|---|
| krs-sync P1 connection layer | DONE (committed) | `KrsConnectionSettings`, `src/lib/krs/client.ts`, `src/lib/krs/stock.ts`, etc. are already in place |
| KRS on-hand source (`sp_Onhand`) | VERIFIED | Live connection 43.229.134.162\SQLEXPRESS:1433, 9 WHFG items confirmed |
| Real KRS test SQL Server available for Step 18 | OPEN | Owner must have KRS running and credentials configured in Admin UI |
| `KRS_CONFIG_ENC_KEY` in local `.env` | OPEN | Required to call `buildConnectionConfig()` |
| `KRS_SYNC_TRIGGER_SECRET` (32+ chars) | OPEN — needs generation | Generate: `openssl rand -hex 32` |
| Prisma migration tooling | DONE | Migrations have been running successfully through the series |
| `npm run type-check` + `npm run build` passing | OPEN — must verify at gate | Run after each phase |

---

## 14. Risk Assessment and Blast Radius

### 14.1 Risk matrix

| Risk | Severity | Mitigation |
|---|---|---|
| Wrong delta applied (math error) | CRITICAL | Pseudocode in §7 reviewed + idempotency tests in §12 Step 18 |
| First-run without baseline seeding → full KRS on-hand added on top of existing POS stock | HIGH | Step 14 seeds snapshot in sync-stock. Auto-sync is OPT-IN (disabled by default). Instructions in runbook. |
| Empty sp_Onhand result zeroes all POS stock | HIGH | §11.8 protection: abort if empty result AND snapshots exist |
| Bearer secret leaks via logs or response | HIGH | §11.6 invariants + security-reviewer pass before deploy |
| Concurrent auto-sync runs double-apply delta | HIGH | §11.2 run-lock; §12 Step 18 concurrency test |
| `sync-stock` route modified incorrectly breaks baseline | MEDIUM | Step 14 is additive (no change to existing write logic, only adds snapshot upsert) |
| Stale lock (crashed run) blocks future runs | MEDIUM | 5-minute stale-lock reclaim in `acquireRunLock` |
| `StockMovementType.KRS_SYNC` enum migration fails | LOW | Prisma ADD VALUE is safe; additive migration tested against existing data |
| Negative delta clamp wrong → incorrect POS stock | MEDIUM | `Math.max(0, posStock + delta)` — explicit test in Step 18 delta detection test |
| New machine-auth path exploitable | MEDIUM | Security-reviewer pass mandatory at execute time; timing-safe comparison; no admin-session bypass |

### 14.2 Blast radius

**Directly modified files (risk ordered):**
1. `prisma/schema.prisma` — additive changes only (new model, new enum value). Low risk.
2. `src/app/api/krs/sync-stock/route.ts` — adds snapshot seeding after existing logic. Low risk (no logic change to existing write path).
3. `src/lib/krs/stock.ts` — adds optional `warehouse` parameter with default `null` (backward compatible). Low risk.
4. `src/lib/env.ts` — adds optional shape-checks. No existing var touched. Low risk.
5. `.env.example` — adds documentation. No risk.

**New files (no existing code affected):**
- `src/lib/krs/autoSync.ts` — new module, no existing imports
- `src/app/api/krs/auto-sync/route.ts` — new endpoint, no existing routes affected
- `src/types/index.ts` — additive type additions only

**NOT touched:**
- `src/app/api/orders/route.ts` — explicitly excluded
- `src/lib/prisma.ts` — not touched
- All checkout/payment/order logic
- All existing KRS routes other than `sync-stock`

---

## 15. Decisions the User Must Approve Before EXECUTE

The following items require explicit owner approval before the execute-agent begins:

### Decision 1 — Scheduler approach (REQUIRED)

This plan defaults to **host cron** (Option 9.1: crontab entry on the Lightsail host). The Docker compose cron sidecar (Option 9.2) is documented as an alternative.

**User must choose:** (A) host cron (no compose changes) or (B) Docker sidecar (adds `krs-cron` service to `docker-compose.yml`).

The execute-agent will only implement the chosen option. If neither is confirmed, the execute-agent implements the endpoint only and leaves the scheduling mechanism to the operator.

### Decision 2 — Cron interval (REQUIRED if scheduler is implemented)

This plan uses 30 minutes as the default. User must confirm the desired interval (or explicitly say "30 minutes is fine").

### Decision 3 — Auto-sync enabled by default (REQUIRED)

`KRS_AUTO_SYNC_ENABLED` defaults to `"false"` in `.env.example`. The auto-sync endpoint is opt-in. User must confirm this is acceptable, or say "enable by default in production `.env`" (not in `.env.example` — that file is public placeholder-only).

### Decision 4 — Empty sp_Onhand protection behavior (REQUIRED)

When `sp_Onhand` returns 0 rows AND prior snapshots exist, this plan ABORTS the run and records a FAILED SyncJob. The alternative would be to apply mass-zero-out (treat all items as "zero in KRS"). User must confirm the abort-on-empty behavior is correct for their KRS setup.

### Decision 5 — Warehouse filter (CONFIRM or DEFAULT)

This plan adds `KRS_AUTO_SYNC_WAREHOUSE` (default empty = all warehouses). The test KRS has 9 items in warehouse `WHFG`. User should confirm: (A) default all-warehouses (empty var) is correct for production, or (B) set `KRS_AUTO_SYNC_WAREHOUSE=WHFG` for the test and production deploy.

### Decision 6 — Docker sidecar env var `KRS_AUTO_SYNC_CRON_SCHEDULE` (ONLY if Decision 1 = Option B)

If the Docker sidecar is chosen, user must confirm whether `KRS_AUTO_SYNC_CRON_SCHEDULE` should be added to `docker-compose.yml` and `.env.example`.

### Decision 7 — Security reviewer pass timing (ACKNOWLEDGE)

The new `POST /api/krs/auto-sync` introduces a machine-auth path (bearer secret, no session). This is a new auth pattern in the codebase. User must acknowledge that the execute-agent will flag this for a security-reviewer pass before the endpoint is deployed to production.

---

## 16. Verification Evidence (Definition of Done)

The following evidence must exist before this plan is marked VERIFIED:

1. `npm run type-check` passes (zero errors) after all changes.
2. `npm run build` passes (zero errors).
3. Migration `krs_auto_sync_snapshot` is present in `prisma/migrations/` and applies cleanly.
4. DB inspection: `KrsStockSnapshot` table exists; after a `sync-stock` call, rows exist for matching items.
5. `POST /api/krs/auto-sync` with correct bearer token returns `{ ok: true }`.
6. `POST /api/krs/auto-sync` with wrong bearer token returns 401.
7. `POST /api/krs/auto-sync` with no bearer token returns 401.
8. After baseline seeding, first auto-sync run returns `updated: 0, delta: 0` (idempotency confirmed).
9. After manually lowering a snapshot value, auto-sync run returns `updated: 1, delta: N > 0`.
10. Repeat run after (9) returns `updated: 0, delta: 0` (idempotency after delta).
11. `StockMovement` table has a row with `type = "KRS_SYNC"` for each applied delta.
12. With `KRS_AUTO_SYNC_ENABLED=false`, endpoint returns 422.
13. Concurrency lock test: stale lock (>5 min) is reclaimed; fresh lock returns SKIPPED_LOCKED.
14. `git grep -nE "KRS_SYNC_TRIGGER_SECRET" -- "*.ts" "*.tsx"` finds zero plaintext appearances in log statements or response bodies.
15. Reconcile endpoint (`GET /api/krs/reconcile`) still returns correct results after auto-sync run (no regression).

---

## 17. Resume and Execution Handoff

**Plan file path (exact):** `process/features/krs-sync/active/krs-inbound-auto-pull_PLAN_23-06-26.md`

**Report destination:** `process/features/krs-sync/reports/krs-inbound-auto-pull_REPORT_23-06-26.md`

**Preconditions before execute-agent starts:**
1. User has approved Decisions 1–7 (§15).
2. The krs-sync P1 connection layer is confirmed working (real KRS credentials configured in Admin UI; `GET /api/krs/test-connection` returns `{ connected: true }`).
3. `KRS_SYNC_TRIGGER_SECRET` has been generated (`openssl rand -hex 32`) and is ready for `.env`.
4. The execute-agent receives the EXACT plan file path above.

**Phase execution order:** A → B → C → D → E → F → G. Do not skip phases. Run type-check after each phase.

**Sensitive files:** `src/app/api/krs/auto-sync/route.ts` (new machine-auth path) — flag for security-reviewer pass after Step 12.

**Do not touch:** `src/app/api/orders/route.ts`, `src/lib/prisma.ts`, any existing checkout/payment routes.

**After EXECUTE:** the orchestrator should offer:
- Security-reviewer agent pass on `src/app/api/krs/auto-sync/route.ts` (new auth path).
- vc-git-manager for clean commit with `feat(krs-sync): inbound auto-pull delta engine` message.
- UPDATE PROCESS to archive this plan and update `process/context/all-context.md`.

---

## 18. Context Update Required After Completion

After the plan is verified, update `process/context/all-context.md` to reflect:
- `KrsStockSnapshot` model added to the schema
- `StockMovementType.KRS_SYNC` enum value added
- New env vars: `KRS_SYNC_TRIGGER_SECRET`, `KRS_AUTO_SYNC_ENABLED`, `KRS_AUTO_SYNC_WAREHOUSE`
- New route: `POST /api/krs/auto-sync` (machine-auth, bearer secret)
- New lib: `src/lib/krs/autoSync.ts`
- Migration: `krs_auto_sync_snapshot`

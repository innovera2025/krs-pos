# KRS VOID Writeback (ยกเลิกบิลที่ Sync แล้ว) + ถอด Refund + Fix Double-Count

**Plan**: `process/features/krs-sync/active/krs-void-writeback_PLAN_19-07-26.md`
**Feature**: krs-sync
**Complexity**: COMPLEX (2 phases, 1 live-prod bugfix + 1 new outbound doc type + schema migration + UI removal)
**Date**: 19-07-26
**Status**: READY FOR EXECUTE (Phase 1 first — see Rollout Gates)

---

## Vendor-Confirmed Cancel Pattern (19-07-26, verbatim)

For a synced cash sale, cancellation = **4 UPDATEs** (soft-close, no deletes, no new RunningNumber claims):

```sql
UPDATE dbo.SalesInvoiceHdr  SET IsClosed = 1                                    WHERE VoucherNo = @sc;
UPDATE dbo.SalePurchaseTax  SET IsClosed = 0                                    WHERE VoucherNo = @sc;
UPDATE dbo.TheJournal       SET IsClosed = 1                                    WHERE VoucherNo = @sc;   -- 3 rows
UPDATE dbo.InventoryFlowHdr SET IsClosed = 1, IsClosedBy = @user, IsClosedDate = GETDATE() WHERE VoucherNo = @osl;
```

`@sc` = the sale's `SC-{YYMM}-{NNNN}` voucher (`SalesInvoiceHdr.VoucherNo` /
`TheJournal.VoucherNo` / `SalePurchaseTax.VoucherNo`). `@osl` = the sale's
`OSL-{YYMM}-{NNNN}` flow voucher (`InventoryFlowHdr.VoucherNo`). The `SalePurchaseTax
IsClosed=0` (not `1`) is **asymmetric and vendor-confirm pending** — implement it
verbatim per the vendor's spec; do not "fix" it.

Owner also confirmed (19-07-26): **remove the Refund action from POS entirely** — the
shop has no refunds (memory `no-refund-no-bill-edit`). `AuditAction.ORDER_REFUNDED` and
`SaleStatus.REFUNDED`/its badge stay in the schema/UI for **historical** rows only; no
new refund can be created going forward.

---

## Critical Prerequisite Finding (new — not in the original research brief)

**`Order.syncStatus` is never written to `SYNCED` by any real code path.** It defaults to
`PENDING` at checkout (`prisma/schema.prisma:350`) and is only ever set elsewhere by
`prisma/seed.ts` (static demo rows, lines 210/246) or to `SyncStatus.SKIPPED` in the
existing void branch (`src/app/api/orders/[id]/route.ts:415`). The real KRS outbound
dispatcher (`src/lib/krs/dispatcher.ts`) only flips `SyncJob.status` to `SYNCED` — it
never touches `Order.syncStatus`. Confirmed by a repo-wide grep: the only three
`syncStatus === SyncStatus.SYNCED` reads are the void-lock checks in
`orders/[id]/route.ts:402,430,455`, and the only writer of the literal value `SYNCED` is
the seed script.

**Consequence:** today, `VOID_SYNCED_LOCKED` can never actually fire for a real sale —
the whole "void a synced bill" premise (and the `canVoid`/badge logic that depends on
it) is dead in production. **Phase 2 must close this gap** (dispatcher flips
`Order.syncStatus = SYNCED` when its `SALE` job reaches `SYNCED`) or the new VOID path
this plan builds would also never be reachable. This is folded into Phase 2 Touchpoint 6
below — it is not optional and not a separate future ticket.

---

## Overview

Two independently-deployable phases, in this order:

- **Phase 1 (urgent, standalone bugfix, no flag):** the outbound dispatcher's
  post-sale `KrsStockSnapshot` advance only decrements the GLOBAL sentinel row
  (`warehouseCode=""`), not the per-warehouse row the realtime reconcile engine
  (`stockReconcile.ts`) actually reads. Every synced sale double-decrements
  `Product.stock` once the next `≤60s` sweep observes the KRS-side cut. This matches the
  shop's reported "ERP 339 vs POS 338". Fix the snapshot advance to also decrement the
  per-warehouse row, plus a one-time Postgres-only true-up script for already-corrupted
  stock.

- **Phase 2 (new capability, ships dark behind a flag):** a new `SyncJobType.VOID`
  outbound document type that runs the vendor's 4-UPDATE cancel pattern against a
  previously-synced sale; the orders route drops the `VOID_SYNCED_LOCKED` block so a
  synced bill can be voided (enqueuing a `VOID` job instead of just zeroing locally);
  the Refund action is removed entirely; the dispatcher is widened to claim
  `SALE | VOID`; and the Phase 1 snapshot-advance machinery is reused symmetrically
  (increment instead of decrement) so a KRS-side stock restore doesn't get
  double-applied by the next reconcile sweep — the exact same class of bug Phase 1 just
  fixed, in the opposite direction.

## Goals

1. Stop the live per-sale stock double-decrement (Phase 1) and give ops a way to
   diagnose/repair already-drifted `Product.stock` rows.
2. Let an admin void a KRS-synced sale from the POS UI; on success this closes the same
   4 documents in KRS the vendor specified, restores POS stock immediately, and
   eventually (once observed) converges KRS's own on-hand back up — without
   double-restoring it.
3. Remove the Refund action end-to-end (Zod, route, UI) while preserving historical
   REFUNDED rows/badges.
4. Ship Phase 2 fully dark (`KRS_VOID_WRITE_ENABLED=false`) so the code merges safely
   before vendor/owner sign-off, mirroring the `KRS_DISCOUNT_WRITE_ENABLED` precedent.

## Scope

**In scope:**
- `src/lib/krs/dispatcher.ts` — generalize the snapshot-advance helper (Phase 1); widen
  job-type claim + branch the per-job loop for `VOID` (Phase 2); flip
  `Order.syncStatus` on `SALE`/`VOID` success (Phase 2).
- `scripts/krs-stock-trueup.cjs` — new, Phase 1.
- `prisma/schema.prisma` + one migration — add `SyncJobType.VOID` (Phase 2 only).
- `src/lib/krs/voidPayload.ts` — new (Phase 2).
- `src/lib/krs/cancelSale.ts` — new (Phase 2).
- `src/lib/krs/index.ts` — export the two new modules (Phase 2).
- `src/lib/env.ts`, `docker-compose.yml`, `.env.example` — new `KRS_VOID_WRITE_ENABLED`
  flag (Phase 2).
- `src/lib/schemas/order.ts`, `src/app/api/orders/[id]/route.ts` — drop `refund`,
  drop `VOID_SYNCED_LOCKED`, enqueue `VOID` SyncJob (Phase 2).
- `src/app/api/sync-jobs/route.ts` — exclude `SALE`/`VOID` from the simulated
  `insert-all` drain (Phase 2).
- `src/components/sales/SaleDetailDrawer.tsx`, `src/app/(shell)/sales/page.tsx`,
  `src/components/sales/saleMeta.ts`, `src/components/data/syncMeta.ts`,
  `src/types/index.ts` — remove Refund UI, add void confirm dialog, add `VOID` job-type
  label (Phase 2).
- `scripts/krs-void-proof.cjs` — new, read-only verification script (Phase 2).

**Explicitly excluded:**
- `checkout` / `src/app/api/orders/route.ts` (POST) — untouched.
- `writeback.ts` SALE write path — untouched (only its exported `KrsWriteError` class
  is reused).
- The realtime `stockReconcile.ts` engine, `watermark.ts`, `autoSync.ts` — untouched
  (Phase 1/2 fix the *producer* side of the snapshot baseline they read, not the
  reconcile engine itself).
- `STOCK_REVERSAL` for a void of an **unsynced** bill (`orders/[id]/route.ts:477-485`
  TODO comment) — stays exactly as-is; that is a different, still-deferred concern (no
  KRS documents exist yet for an unsynced bill, so there is nothing to cancel).
- The 2s realtime poller (`KRS_RT_POLL_ENABLED`) — stays dormant/unaffected; both
  phases only change what the existing `≤60s` safety-net sweep (`autoSync.ts` →
  `reconcileStock(config, "ALL")`, `KRS_AUTO_SYNC_INTERVAL_SECONDS` default **60s** per
  `.env.example:141` / `docker-compose.prod.yml:40,60` — **not** the stale "5 min" in
  `all-context.md`) will observe next.
- `UNIQUE` constraint on `SalesInvoiceHdr.TransactionNo` / the alive-but-slow
  double-write race documented in `krs-writeback-idempotency_PLAN_27-06-26.md` —
  unrelated to VOID (VOID has no burned anchor / no reclaim by design; see Invariants).
- Any new `AuditAction` enum value — `AuditAction.ORDER_VOIDED` already covers the
  Postgres-side void action; the KRS-side VOID SyncJob completion gets no dedicated
  audit row, mirroring the existing SALE SyncJob (also un-audited on completion).

---

## Acceptance Criteria

**Phase 1 (bugfix):**
- [ ] A synced sale's per-warehouse `KrsStockSnapshot` row is decremented by the sold
      qty in the SAME Postgres tx that flips the `SyncJob` to `SYNCED` (not just the
      global sentinel row).
- [ ] The next `≤60s` reconcile sweep (`autoSync.ts` → `reconcileStock(config,"ALL")`)
      computes `intDelta = 0` for that item/warehouse — no double-decrement of
      `Product.stock`.
- [ ] `scripts/krs-stock-trueup.cjs` dry-run correctly reports drift on already-
      corrupted rows and `--apply` converges `Product.stock` to `Σ` per-warehouse
      snapshot without touching any item with an in-flight `SALE`/`VOID` job.
- [ ] `npm run type-check` and `npm run build` both exit 0.

**Phase 2 (new capability):**
- [ ] `Order.syncStatus` reaches `SYNCED` via a real code path (the dispatcher) for the
      first time — verified by inspecting a real synced order's `syncStatus` after
      Phase 1+2 deploy.
- [ ] A COMPLETED, previously-SYNCED bill can be voided from the POS UI (no more
      `VOID_SYNCED_LOCKED` 409); stock restores immediately in Postgres; a `VOID`
      SyncJob is enqueued.
- [ ] With `KRS_VOID_WRITE_ENABLED=true` in a live/sandbox test, `cancelSaleInKrs`
      closes all 4 KRS documents exactly per the vendor's verbatim SQL, verified by
      `scripts/krs-void-proof.cjs`.
- [ ] The Refund action is fully removed: the Zod schema rejects `{action:"refund"}`
      with 400 `BAD_ACTION`; no Refund button renders in the Sales History drawer;
      historical REFUNDED orders still display their badge correctly.
- [ ] `POST /api/sync-jobs {action:"insert-all"}` never fake-SYNCs a `SALE` or `VOID`
      job.
- [ ] `npm run type-check` and `npm run build` both exit 0, with no TS2741 from
      `syncMeta.ts`.
- [ ] `KRS_VOID_WRITE_ENABLED` remains `false` in every environment until the owner
      explicitly flips it after Rollout Gates 3-5 complete.

---

## Touchpoints — Phase 1

### 1. `src/lib/krs/dispatcher.ts` — generalize the snapshot-advance helper

**1a. Replace `advanceGlobalSnapshotForSale` (lines 169-185) with a direction- and
warehouse-aware helper:**

```typescript
/**
 * Advance BOTH the per-warehouse KrsStockSnapshot row AND the GLOBAL sentinel row
 * (warehouseCode="") for each line, in `direction`. The realtime reconcile engine
 * (stockReconcile.ts STEP 7) computes its delta from the PER-WAREHOUSE row only — the
 * global sentinel is legacy/display. Before this fix only the sentinel was advanced, so
 * the next reconcile sweep saw the KRS-side cut (or, for VOID, the KRS-side restore) as
 * a brand-new delta and re-applied it on top of Product.stock, double-counting it
 * (backlog outbound-production-gaps_TODO_27-06-26.md §9).
 *
 * An item with no existing snapshot row (count === 0) is logged and SKIPPED for THAT
 * key — never creates a 0 row (a fabricated 0 baseline would make the next reconcile
 * treat the full KRS on-hand as a fresh delta in the wrong direction).
 */
async function applySnapshotDelta(
  tx: Prisma.TransactionClient,
  lines: SnapshotAdvanceLine[],
  warehouseCode: string,
  direction: "decrement" | "increment"
): Promise<void> {
  for (const line of lines) {
    const globalRes = await tx.krsStockSnapshot.updateMany({
      where: { itemCode: line.itemCode, warehouseCode: "" },
      data: { lastQty: { [direction]: line.qty } },
    });
    if (globalRes.count === 0) {
      logger.warn(
        { krsDispatch: { itemCode: line.itemCode, key: "global" } },
        "KRS dispatch: snapshot-advance skipped — item not baselined in global snapshot (no 0 row created)"
      );
    }
    const whRes = await tx.krsStockSnapshot.updateMany({
      where: { itemCode: line.itemCode, warehouseCode },
      data: { lastQty: { [direction]: line.qty } },
    });
    if (whRes.count === 0) {
      logger.warn(
        { krsDispatch: { itemCode: line.itemCode, key: "warehouse", warehouseCode } },
        "KRS dispatch: snapshot-advance skipped — item not baselined in per-warehouse snapshot (no 0 row created)"
      );
    }
  }
}
```

`SnapshotAdvanceLine` (line 151) is unchanged.

**1b. Update `markSyncedAndAdvance` (lines 200-237) — add `warehouseCode`, `direction`,
and `orderNumber` params; call the renamed helper; also flip `Order.syncStatus`:**

```typescript
async function markSyncedAndAdvance(
  jobId: string,
  currentAttempts: number,
  response: string,
  lines: SnapshotAdvanceLine[],
  warehouseCode: string,
  direction: "decrement" | "increment",
  orderNumber: string
): Promise<void> {
  const attempts = currentAttempts + 1;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.syncJob.updateMany({
      where: { id: jobId, snapshotAdvancedAt: null },
      data: {
        status: SyncJobStatus.SYNCED,
        lockedAt: null,
        attempts,
        response,
        lastError: null,
        snapshotAdvancedAt: new Date(),
      },
    });
    if (claimed.count === 1) {
      await applySnapshotDelta(tx, lines, warehouseCode, direction);
    } else {
      await tx.syncJob.update({
        where: { id: jobId },
        data: {
          status: SyncJobStatus.SYNCED,
          lockedAt: null,
          attempts,
          response,
          lastError: null,
        },
      });
    }
    // krs-void-writeback: close the "Order.syncStatus never reaches SYNCED" gap (see
    // plan's Critical Prerequisite Finding). Idempotent — safe to re-assert on every
    // reclaim/retry branch, unlike the snapshot delta above which must be exactly-once.
    await tx.order.updateMany({
      where: { orderNumber },
      data: { syncStatus: SyncStatus.SYNCED },
    });
  });
}
```

**1c. Update the two existing SALE call sites** to pass the 3 new args
(`payload.warehouseCode`, `"decrement"`, `job.ref`):

- Reclaim-FOUND branch (current lines 410-415):
  ```typescript
  await markSyncedAndAdvance(
    job.id,
    job.attempts,
    JSON.stringify({ transactionNo: job.krsClaimedTxnNo, recovered: true }),
    payload.items.map((it) => ({ itemCode: it.itemCode, qty: it.quantity })),
    payload.warehouseCode,
    "decrement",
    job.ref
  );
  ```
- KRS-write-success branch (current lines 526-538): add the same 3 trailing args
  (`payload.warehouseCode, "decrement", job.ref`) to the existing call.

**1d. Add `SyncStatus` to the `@prisma/client` import (line 35):**
```typescript
import { Prisma, SyncJobStatus, SyncJobType, SyncStatus } from "@prisma/client";
```

No other change to `dispatcher.ts` in Phase 1 — the claim query (`"type" = SALE`, line
104), the reclaim block, the discount gate, and the KRS-write try/catch are all
untouched here (Phase 2 touches them).

### 2. `scripts/krs-stock-trueup.cjs` — new, one-time ops diagnostic/repair

Postgres-only (no mssql connection needed — it compares `Product.stock` against the
**already-stored** `KrsStockSnapshot` rows, not a fresh KRS read). Mirrors the
migrate-image run pattern from `scripts/krs-discount-proof.cjs`.

- **Default (no flags): dry-run report only.** For every `Product` where
  `krsManaged = true`, compute `expected = clamp(Σ KrsStockSnapshot.lastQty across all
  warehouseCode != "" rows for that itemCode(=sku), 0, POS_STOCK_MAX)` (mirrors the
  clamp in `src/lib/krs/reconcileMath.ts:10,18` — reuse those exported constants/helpers
  by requiring the compiled path, or replicate the clamp inline with a comment citing
  `reconcileMath.ts:10`). Print one line per item where `Product.stock != expected`:
  `sku, current, expected, drift`. Exit 0 always (report-only).
- **`--apply`:** for each drifted item, first checks that item has **no** `SyncJob`
  row with `type IN (SALE, VOID)` and `status IN (PENDING, RETRYING)` (i.e. nothing
  in-flight that could race the rebase) — `SELECT 1 FROM "SyncJob" WHERE status IN
  ('PENDING','RETRYING') AND type IN ('SALE','VOID') AND payload::text LIKE
  '%"itemCode":"' || sku || '"%'` is acceptable given `payload` is JSON text; skip
  (log, do not apply) any item that matches. For every remaining drifted item, run
  `UPDATE "Product" SET stock = $expected WHERE sku = $sku` inside one
  `prisma.$transaction`, and print a per-item before/after line. Never touches
  `KrsStockSnapshot` (that stays whatever the last reconcile observed — the reconcile
  engine always rebases it to `observed` on its own on the next cycle regardless).
- Header comment must state: safe to run at any time in dry-run mode; `--apply` should
  only be run once, right after Phase 1 deploys (to true-up the damage the pre-fix
  dispatcher already did), and is idempotent (a second `--apply` run finds zero drift
  once the underlying data is consistent).
- Run command (documented in the script header):
  ```
  docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
    -v ~/krs-pos/scripts/krs-stock-trueup.cjs:/q.cjs:ro \
    -e DATABASE_URL="$DATABASE_URL" migrate node /q.cjs [--apply]
  ```

---

## Touchpoints — Phase 2

### 3. `prisma/schema.prisma` — add `SyncJobType.VOID`

**3a. Enum (lines 97-105):**
```prisma
enum SyncJobType {
  SALE
  REFUND
  STOCK
  PULL
  TAX_INVOICE
  STOCK_ADJ
  RECEIVE
  VOID   // krs-void-writeback: cancel a previously-synced sale (4-UPDATE close pattern)
}
```

**3b. Migration** — name `add_syncjob_type_void`, additive only, own migration (Postgres
cannot use a newly-added enum value inside the same transaction that added it — same
constraint the `NEEDS_RECONCILE` precedent documents):
```sql
-- Migration: add_syncjob_type_void (krs-sync — VOID writeback)
-- Additive only: one new SyncJobType enum value. No backfill, no constraint changes.
ALTER TYPE "SyncJobType" ADD VALUE 'VOID';
```
Command: `npx prisma migrate dev --name add_syncjob_type_void`. No-live-DB fallback:
edit schema → `npx prisma generate` → hand-write the migration SQL above for
deployment (mirrors the burned-anchor plan's fallback).

### 4. `src/lib/krs/voidPayload.ts` — new module

Mirrors `src/lib/krs/salePayload.ts` conventions exactly: type-only + a pure runtime
validator, **zero** mssql/Prisma imports (safe to import from both the orders route and
the dispatcher).

```typescript
// Shared VOID outbox payload contract (krs-void-writeback). Pure/type-only + a runtime
// validator — no mssql driver, no Prisma singleton. Mirrors salePayload.ts.

export type VoidPayloadItem = { itemCode: string; qty: number };

/** Best-effort doc numbers recovered from the original SALE SyncJob's stored
 *  `response` JSON, used as a FALLBACK when the KRS-side PosBillNo lookup in
 *  cancelSale.ts finds nothing (pre-16/17-07-26 bills lack PosBillNo in KRS). All
 *  optional — a crash-recovered SALE job's response may be `{transactionNo,
 *  recovered:true}` only (see krs-writeback-idempotency_PLAN_27-06-26.md
 *  Crash-Point Safety Table row 5), so saleVoucherNo/flowVoucherNo may be absent. */
export type VoidSaleRef = {
  transactionNo?: string;
  saleVoucherNo?: string;
  flowTxnNo?: string;
  flowVoucherNo?: string;
};

export type VoidPayload = {
  /** = the original sale's orderNumber; also the PosBillNo lookup key in KRS. */
  orderNumber: string;
  /** The original sale's KRS WarehouseCode — the stock-cut being reversed. Lifted
   *  from the original SALE SyncJob's own payload.warehouseCode (NOT the voiding
   *  admin's warehouse, which may differ). */
  warehouseCode: string;
  /** POS username/email performing the void → KRS InventoryFlowHdr.IsClosedBy. */
  requestedBy: string;
  /** ISO-8601 instant the void was requested. */
  requestedAt: string;
  /** Lines to restore into KrsStockSnapshot on success — lifted from the original
   *  SALE SyncJob's own payload.items (itemCode + quantity), not re-derived from
   *  live Product rows (sku could theoretically have changed since the sale). */
  items: VoidPayloadItem[];
  saleRef: VoidSaleRef;
};

export function parseVoidPayload(value: unknown): VoidPayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("VoidPayload is not an object");
  }
  const v = value as Record<string, unknown>;
  const str = (key: string): string => {
    const x = v[key];
    if (typeof x !== "string" || x.length === 0) {
      throw new Error(`VoidPayload.${key} must be a non-empty string`);
    }
    return x;
  };
  if (!Array.isArray(v.items) || v.items.length === 0) {
    throw new Error("VoidPayload.items must be a non-empty array");
  }
  const items: VoidPayloadItem[] = v.items.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`VoidPayload.items[${i}] is not an object`);
    }
    const it = raw as Record<string, unknown>;
    const itemCode = it.itemCode;
    const qty = it.qty;
    if (typeof itemCode !== "string" || itemCode.length === 0) {
      throw new Error(`VoidPayload.items[${i}].itemCode must be a non-empty string`);
    }
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0) {
      throw new Error(`VoidPayload.items[${i}].qty must be a positive integer`);
    }
    return { itemCode, qty };
  });
  const rawRef = v.saleRef;
  const ref = typeof rawRef === "object" && rawRef !== null
    ? (rawRef as Record<string, unknown>)
    : {};
  const optStr = (key: string): string | undefined =>
    typeof ref[key] === "string" ? (ref[key] as string) : undefined;
  return {
    orderNumber: str("orderNumber"),
    warehouseCode: str("warehouseCode"),
    requestedBy: typeof v.requestedBy === "string" ? v.requestedBy : "",
    requestedAt: str("requestedAt"),
    items,
    saleRef: {
      transactionNo: optStr("transactionNo"),
      saleVoucherNo: optStr("saleVoucherNo"),
      flowTxnNo: optStr("flowTxnNo"),
      flowVoucherNo: optStr("flowVoucherNo"),
    },
  };
}
```

### 5. `src/lib/krs/cancelSale.ts` — new module (the mssql write)

Mirrors `writeback.ts` conventions: own throwaway pool per call, everything
parameterized, `KrsWriteError`/`safeErrorParts` reuse, sanitized errors, `finally`
closes the pool.

```typescript
// NODE-ONLY. KRS VOID write module (krs-void-writeback). Cancels a previously-synced
// cash sale via the vendor-confirmed 4-UPDATE soft-close pattern (19-07-26, verbatim —
// see krs-void-writeback_PLAN_19-07-26.md header). Imported ONLY by the dispatcher.
// NEVER import from a client component, `src/auth.config.ts`, or `src/middleware.ts`.
//
// DOCUMENT RESOLUTION: PosBillNo lookup against SalesInvoiceHdr/InventoryFlowHdr is
// PRIMARY (works for any bill sold after the 16/17-07-26 PosBillNo columns landed:
// writeback.ts:633,767). payload.saleRef is the FALLBACK for a pre-16-07 bill with no
// PosBillNo in KRS. If NEITHER resolves both VoucherNo values, this throws — an
// operator/manual case, never a silent no-op.
//
// IDEMPOTENCY: unlike writeKrsSale, this needs NO burned anchor and NO reclaim check.
// All 4 UPDATEs are naturally idempotent (re-running against an already-IsClosed=1 row
// is a harmless no-op UPDATE) — a crash mid-tx just rolls back and the next dispatch
// attempt re-resolves + re-runs cleanly.
//
// STRICT vs WARN: SalesInvoiceHdr (must hit exactly 1 row) and InventoryFlowHdr (must
// hit >=1 row) are the two documents that actually gate "is this bill closed / is the
// stock reopened" — a miss there throws and rolls back ALL 4 updates (never leave KRS
// half-closed). TheJournal (expected 3) and SalePurchaseTax (expected 1) mismatches are
// WARN-only (logged in the returned counts) — see plan Invariants for rationale.

import sql from "mssql";
import { type VoidPayload } from "./voidPayload";
import { safeErrorParts } from "./client";
import { KrsWriteError } from "./writeback";

export type CancelSaleResult = {
  saleVoucherNo: string;
  flowVoucherNo: string;
  hdrRowsUpdated: number;
  flowRowsUpdated: number;
  journalRowsUpdated: number;
  taxRowsUpdated: number;
};

export async function cancelSaleInKrs(
  payload: VoidPayload,
  config: sql.config
): Promise<CancelSaleResult> {
  let pool: sql.ConnectionPool | null = null;
  let tx: sql.Transaction | null = null;
  let committed = false;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();

    const posBillNo = payload.orderNumber.slice(0, 30);
    const hdrLookup = await new sql.Request(pool)
      .input("ref", sql.NVarChar(30), posBillNo)
      .query<{ TransactionNo: string; VoucherNo: string }>(
        `SELECT TOP 1 TransactionNo, VoucherNo FROM dbo.SalesInvoiceHdr WHERE PosBillNo = @ref;`
      );
    const flowLookup = await new sql.Request(pool)
      .input("ref", sql.NVarChar(30), posBillNo)
      .query<{ TransactionNo: string; VoucherNo: string }>(
        `SELECT TOP 1 TransactionNo, VoucherNo FROM dbo.InventoryFlowHdr WHERE PosBillNo = @ref;`
      );

    const saleVoucherNo =
      hdrLookup.recordset[0]?.VoucherNo ?? payload.saleRef.saleVoucherNo;
    const flowVoucherNo =
      flowLookup.recordset[0]?.VoucherNo ?? payload.saleRef.flowVoucherNo;

    if (!saleVoucherNo || !flowVoucherNo) {
      throw new KrsWriteError(
        `Cannot resolve KRS documents for ${payload.orderNumber} — no PosBillNo match and no saleRef fallback`
      );
    }

    tx = new sql.Transaction(pool);
    await tx.begin(); // READ COMMITTED (default) — 4 independent idempotent UPDATEs, no claim race

    const hdrRes = await new sql.Request(tx)
      .input("sc", sql.NVarChar, saleVoucherNo)
      .query(`UPDATE dbo.SalesInvoiceHdr SET IsClosed = 1 WHERE VoucherNo = @sc;`);

    const taxRes = await new sql.Request(tx)
      .input("sc", sql.NVarChar, saleVoucherNo)
      .query(`UPDATE dbo.SalePurchaseTax SET IsClosed = 0 WHERE VoucherNo = @sc;`);

    const jnlRes = await new sql.Request(tx)
      .input("sc", sql.NVarChar, saleVoucherNo)
      .query(`UPDATE dbo.TheJournal SET IsClosed = 1 WHERE VoucherNo = @sc;`);

    const flowRes = await new sql.Request(tx)
      .input("osl", sql.NVarChar, flowVoucherNo)
      .input("user", sql.NVarChar, payload.requestedBy)
      .query(
        `UPDATE dbo.InventoryFlowHdr
            SET IsClosed = 1, IsClosedBy = @user, IsClosedDate = GETDATE()
          WHERE VoucherNo = @osl;`
      );

    const hdrRowsUpdated = hdrRes.rowsAffected[0] ?? 0;
    const flowRowsUpdated = flowRes.rowsAffected[0] ?? 0;
    const journalRowsUpdated = jnlRes.rowsAffected[0] ?? 0;
    const taxRowsUpdated = taxRes.rowsAffected[0] ?? 0;

    if (hdrRowsUpdated !== 1) {
      throw new KrsWriteError(
        `SalesInvoiceHdr cancel matched ${hdrRowsUpdated} rows for VoucherNo=${saleVoucherNo} (expected 1)`
      );
    }
    if (flowRowsUpdated < 1) {
      throw new KrsWriteError(
        `InventoryFlowHdr cancel matched 0 rows for VoucherNo=${flowVoucherNo} (expected >=1)`
      );
    }
    // TheJournal (expected 3) / SalePurchaseTax (expected 1) — WARN only, not thrown;
    // caller (dispatcher) logs journalRowsUpdated/taxRowsUpdated in the SyncJob.response.

    await tx.commit();
    committed = true;

    return { saleVoucherNo, flowVoucherNo, hdrRowsUpdated, flowRowsUpdated, journalRowsUpdated, taxRowsUpdated };
  } catch (e) {
    if (tx && !committed) {
      try { await tx.rollback(); } catch { /* secondary */ }
    }
    if (e instanceof KrsWriteError) throw e;
    const parts = safeErrorParts(e);
    throw new Error(`KRS cancel failed [${parts.code}]: ${parts.message}`);
  } finally {
    if (pool) {
      try { await pool.close(); } catch { /* secondary */ }
    }
  }
}
```

### 6. `src/lib/krs/dispatcher.ts` — widen claim, branch VOID, wire the flag

**6a. Import (line 41-42) — add `cancelSaleInKrs`/`parseVoidPayload`:**
```typescript
import { writeKrsSale, WriteConfigNotReadyError, checkKrsSaleExists } from "./writeback";
import type { KrsWriteOpts } from "./writeback";
import { cancelSaleInKrs } from "./cancelSale";
import { parseVoidPayload } from "./voidPayload";
```

**6b. `claimJobs` (lines 94-115) — widen the type filter (line 104):**
```typescript
WHERE "type" IN (${SyncJobType.SALE}::"SyncJobType", ${SyncJobType.VOID}::"SyncJobType")
```
(same tagged-template shape as the existing `status IN (...)` clause on the next line —
each `${}` becomes its own bound parameter).

**6c. `findUnique` select (lines 309-319) — add `type: true`:**
```typescript
select: {
  id: true,
  idempotencyKey: true,
  payload: true,
  attempts: true,
  ref: true,
  krsClaimedTxnNo: true,
  type: true,   // ← ADD: branch VOID vs SALE
},
```

**6d. Insert a VOID branch immediately after the SANDBOX GATE block (after line 363)
and BEFORE the existing `// === PAYLOAD BOUNDARY ===` comment (line 365).** This is an
early `continue` for VOID jobs — the entire existing SALE path below (payload boundary,
reclaim existence check, discount gate, KRS write) is textually untouched and
unreachable for a VOID job:

```typescript
    // === VOID BRANCH (early continue — SALE path below is unchanged for VOID) ===
    if (job.type === SyncJobType.VOID) {
      // VOID-WRITE GATE — held pattern (mirrors DISCOUNT_HELD): re-queue WITHOUT
      // counting an attempt until the owner flips KRS_VOID_WRITE_ENABLED. Checked
      // BEFORE parsing the payload (cheap, no payload dependency).
      if (env.KRS_VOID_WRITE_ENABLED !== "true") {
        await requeueHeld(job.id);
        result.skipped += 1;
        logger.info(
          { krsDispatch: { jobId: job.id, ref: job.ref, code: "VOID_HELD" } },
          "KRS dispatch: VOID held — KRS_VOID_WRITE_ENABLED is off"
        );
        continue;
      }

      let voidPayload;
      try {
        voidPayload = parseVoidPayload(job.payload);
      } catch (e) {
        const msg = `Invalid VOID payload: ${safeErrMsg(e)}`;
        logger.error(
          { krsDispatch: { jobId: job.id, ref: job.ref, code: "BAD_PAYLOAD" } },
          "KRS dispatch: invalid VOID SyncJob payload"
        );
        const { terminal } = await markFailedOrRetry(job.id, job.attempts, msg);
        result.failed += 1;
        if (terminal) {
          logger.error(
            { krsDispatch: { jobId: job.id, ref: job.ref } },
            "KRS dispatch: VOID job reached terminal FAILED (bad payload)"
          );
        }
        continue;
      }

      // No reclaim needed — cancelSaleInKrs's 4 UPDATEs are naturally idempotent (see
      // cancelSale.ts header). A crash mid-write just rolls back; the next attempt
      // re-resolves the documents and re-runs cleanly.
      try {
        const cancelResult = await cancelSaleInKrs(voidPayload, sandboxConfig);
        await markSyncedAndAdvance(
          job.id,
          job.attempts,
          JSON.stringify(cancelResult),
          voidPayload.items.map((it) => ({ itemCode: it.itemCode, qty: it.qty })),
          voidPayload.warehouseCode,
          "increment",
          job.ref
        );
        result.synced += 1;
      } catch (e) {
        const sanitized = safeErrMsg(e);
        logger.error(
          {
            krsDispatch: {
              jobId: job.id,
              ref: job.ref,
              attempts: job.attempts + 1,
              code: safeErrCode(e),
              message: sanitized,
            },
          },
          "KRS dispatch: VOID write failed"
        );
        const { terminal } = await markFailedOrRetry(job.id, job.attempts, sanitized);
        result.failed += 1;
        if (terminal) {
          logger.error(
            { krsDispatch: { jobId: job.id, ref: job.ref } },
            "KRS dispatch: VOID job reached terminal FAILED"
          );
        }
      }
      continue;
    }

    // === PAYLOAD BOUNDARY === (existing SALE path — unchanged below this line)
```

No other line in the existing SALE path (reclaim block, discount gate, KRS write,
markSyncedAndAdvance call) changes shape in Phase 2 beyond the 3 trailing args already
added in Phase 1 Touchpoint 1c.

### 7. `src/lib/env.ts` — new flag (insert after line 174, before the
`KRS_DISPATCH_SECRET` comment at line 175)

```typescript
  // KRS_VOID_WRITE_ENABLED — kill switch for writing a VOID (cancel) of a synced sale
  // to KRS. When not exactly "true", the dispatcher HOLDS any VOID job — re-queued
  // PENDING without counting an attempt (mirrors KRS_DISCOUNT_WRITE_ENABLED) — so no
  // cancel document reaches KRS until the vendor-confirmed 4-UPDATE pattern is verified
  // live. The Postgres-side void (status VOIDED, stock restored) still happens
  // immediately regardless — this flag only gates the KRS-side write. Opt-in by
  // design; the OWNER flips it after live verification (an agent must never flip it).
  KRS_VOID_WRITE_ENABLED: z.enum(["true", "false"]).default("false"),
```

### 8. `docker-compose.yml` — passthrough (insert after line 105)

```yaml
      KRS_VOID_WRITE_ENABLED: ${KRS_VOID_WRITE_ENABLED:-false}
```
Extend the comment block above (lines 95-99) with one more bullet:
```
      #  - KRS_VOID_WRITE_ENABLED: kill switch for writing a VOID (cancel) of a synced
      #    sale; when not "true" the dispatcher HOLDS the VOID job (PENDING). Default false.
```

### 9. `.env.example` — document the var (insert after line 193, before line 195)

```
# สวิตช์เปิดการส่ง "ยกเลิกบิล" (VOID) กลับ KRS สำหรับบิลที่ sync แล้ว
# When not exactly "true", the dispatcher HOLDS any VOID job as PENDING without
# counting an attempt. The Postgres-side void (status VOIDED, stock restored) still
# happens immediately regardless. Owner flips it after live verification.
KRS_VOID_WRITE_ENABLED=false
```

### 10. `src/lib/krs/index.ts` — export the two new modules (insert after line 55,
before the `writebackConfig` export block)

```typescript
export { cancelSaleInKrs } from "./cancelSale";
export type { CancelSaleResult } from "./cancelSale";
export { parseVoidPayload } from "./voidPayload";
export type { VoidPayload, VoidPayloadItem, VoidSaleRef } from "./voidPayload";
```

### 11. `src/lib/schemas/order.ts` — drop `refund` from the action enum

**Line 67-71, replace:**
```typescript
export const OrderPatchBodySchema = z.object({
  action: z.enum(["void", "request-tax"], {
    message: "action must be 'void' or 'request-tax'",
  }),
});
```

### 12. `src/app/api/orders/[id]/route.ts` — the core route rewrite

This is the largest single-file change. Work through it top to bottom.

**12a. Existing `existing` select (lines 359-367) — widen to add `orderNumber` and
`branchId`** (needed to build the VOID SyncJob's `ref`/`branchId`):
```typescript
      select: {
        id: true,
        orderNumber: true,
        branchId: true,
        status: true,
        syncStatus: true,
        total: true,
        items: { select: { productId: true, quantity: true } },
      },
```

**12b. Admin-gate condition (lines 180-188) — drop the `refund` branch of the check:**
```typescript
  if (action === "void" && !isAdminRole(session.user.role)) {
```

**12c. Remove the `if (action === "refund")` handling entirely.** After the shared
COMPLETED pre-check (lines 381-392, unchanged — but its error message ternary
collapses to the void-only string, dropping the `action === "refund" ? ... :` branch),
**delete the old `updateData`/`if (action === "refund") {...} else {...}` block (lines
394-417) and replace with:**
```typescript
    // Synced bills are no longer locked from void (krs-void-writeback, 19-07-26 owner
    // decision — supersedes domain-synced-bills-locked). When the bill WAS synced, the
    // KRS-side documents get closed via a VOID SyncJob (enqueued below); syncStatus is
    // left untouched here (stays SYNCED — it still accurately means "this order has
    // live KRS documents", now in the process of being cancelled). When the bill was
    // NOT yet synced, behavior is unchanged: syncStatus flips to SKIPPED (nothing in
    // KRS to cancel — TODO(krs-sync-P2) STOCK_REVERSAL comment below still applies).
    const wasSynced = existing.syncStatus === SyncStatus.SYNCED;
    const updateData: Prisma.OrderUpdateInput = wasSynced
      ? { status: OrderStatus.VOIDED, total: 0, tax: 0 }
      : { status: OrderStatus.VOIDED, total: 0, tax: 0, syncStatus: SyncStatus.SKIPPED };
```

**12d. `transitionWhere` (lines 419-432) — drop the void-specific `syncStatus: { not:
SYNCED }` lock; both actions (only void remains) use the plain COMPLETED guard:**
```typescript
    const transitionWhere: Prisma.OrderWhereInput = { id, status: OrderStatus.COMPLETED };
```

**12e. Inside the `$transaction` (lines 440-493) — remove the `action === "void"`
re-read-for-`VoidSyncedLockedError` block (lines 450-458, now unreachable dead logic
since `transitionWhere` no longer excludes SYNCED); keep the plain
`OrderStateConflictError` throw for `count !== 1`.**

**12f. Immediately after the stock-restore loop (after line 486, before the
`return tx.order.findUniqueOrThrow` at line 489), add the VOID SyncJob enqueue —
only when `wasSynced`:**
```typescript
      if (wasSynced) {
        const saleJob = await tx.syncJob.findFirst({
          where: {
            type: SyncJobType.SALE,
            ref: existing.orderNumber,
            status: SyncJobStatus.SYNCED,
          },
          orderBy: { createdAt: "desc" },
          select: { payload: true, response: true },
        });
        if (!saleJob) {
          throw new VoidMissingSaleJobError();
        }
        let saleSnapshot: SalePayload;
        try {
          saleSnapshot = parseSalePayload(saleJob.payload);
        } catch {
          throw new VoidMissingSaleJobError();
        }
        let saleRef: VoidPayload["saleRef"] = {};
        if (typeof saleJob.response === "string") {
          try {
            const r = JSON.parse(saleJob.response) as Record<string, unknown>;
            saleRef = {
              transactionNo: typeof r.transactionNo === "string" ? r.transactionNo : undefined,
              saleVoucherNo: typeof r.saleVoucherNo === "string" ? r.saleVoucherNo : undefined,
              flowTxnNo: typeof r.flowTxnNo === "string" ? r.flowTxnNo : undefined,
              flowVoucherNo: typeof r.flowVoucherNo === "string" ? r.flowVoucherNo : undefined,
            };
          } catch {
            /* leave saleRef empty — PosBillNo lookup in cancelSale.ts is primary anyway */
          }
        }
        const voidPayload: VoidPayload = {
          orderNumber: existing.orderNumber,
          warehouseCode: saleSnapshot.warehouseCode,
          requestedBy: session.user.name ?? session.user.email ?? "",
          requestedAt: new Date().toISOString(),
          items: saleSnapshot.items.map((it) => ({ itemCode: it.itemCode, qty: it.quantity })),
          saleRef,
        };
        await tx.syncJob.create({
          data: {
            type: SyncJobType.VOID,
            direction: SyncDirection.INSERT,
            ref: existing.orderNumber,
            amount: existing.total,
            status: SyncJobStatus.PENDING,
            provider: "KRS",
            idempotencyKey: `${existing.orderNumber}_VOID`,
            payload: voidPayload as unknown as Prisma.InputJsonValue,
            attempts: 0,
            branchId: existing.branchId,
          },
        });
      }
```

**12g. New imports (top of file, alongside the existing `@prisma/client` import at
lines 2-11):**
```typescript
import { parseSalePayload, type SalePayload } from "@/lib/krs/salePayload";
import { type VoidPayload } from "@/lib/krs/voidPayload";
```

**12h. New error class** (alongside `OrderStateConflictError`/`TaxAlreadyRequestedError`
at the bottom of the file, ~line 580) — **and remove `VoidSyncedLockedError` entirely**
(dead now that the lock is gone):
```typescript
/**
 * Thrown inside the VOID transaction when the bill's syncStatus is SYNCED but no
 * matching SALE SyncJob (status SYNCED) can be found to build the cancel payload from.
 * A genuine data-integrity anomaly (pre-outbox-migration order, or a corrupted/missing
 * SyncJob row) — fail loudly and roll back the whole void rather than guess at KRS
 * document numbers or silently skip the KRS-side cancel.
 */
class VoidMissingSaleJobError extends Error {
  constructor() {
    super("No matching SYNCED SALE SyncJob found for this order");
    this.name = "VoidMissingSaleJobError";
  }
}
```

**12i. Catch block (lines 527-570) — remove the `VoidSyncedLockedError` branch (lines
532-540); add a `VoidMissingSaleJobError` branch (500, since this is a server-side
data-integrity gap, not a client error):**
```typescript
    if (err instanceof VoidMissingSaleJobError) {
      logger.error({ err, orderId: id }, "PATCH /api/orders/[id] void: no matching SALE SyncJob");
      return NextResponse.json(
        {
          error: "ไม่พบข้อมูลการซิงค์เดิมของบิลนี้ · Original KRS sync record not found",
          code: "VOID_MISSING_SALE_JOB",
        },
        { status: 500 }
      );
    }
```

**12j. Error-message ternaries collapse to void-only** at the pre-check (line 385-387)
and the `OrderStateConflictError` catch (line 547-550) — both currently read
`action === "refund" ? "คืนเงินได้เฉพาะบิลที่ชำระแล้ว" : "ยกเลิก (Void) ได้เฉพาะบิลที่ชำระแล้ว"`;
replace both with the void string unconditionally: `"ยกเลิก (Void) ได้เฉพาะบิลที่ชำระแล้ว"`.

**12k. Audit call (lines 501-518) — collapse the `action === "refund" ? ... :`
ternaries** (both the `action:` field and the `total:` field in `detail`) to their
void-only values:
```typescript
    await logAudit({
      action: AuditAction.ORDER_VOIDED,
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      ip: await ipFromHeaders(),
      targetType: "Order",
      targetId: updated.id,
      detail: JSON.stringify({
        orderNumber: updated.orderNumber,
        total: existing.total.toString(), // pre-void amount (void always zeroes total)
      }),
    });
```

### 13. `src/app/api/sync-jobs/route.ts` — exclude real job types from the simulated
drain (lines 123-130)

The `insert-all` simulated action currently fake-SYNCs **every** PENDING job
regardless of type — including real `SALE` jobs today (a pre-existing gap this audit
surfaced) and `VOID` jobs once Phase 2 ships. Constrain it to the still-genuinely-
simulated types:
```typescript
    // insert-all — drain only PENDING jobs of the SIMULATED types (never SALE/VOID,
    // which have a REAL dispatcher at POST /api/krs/dispatch; fake-SYNCing one of those
    // here would corrupt SyncJob bookkeeping without ever writing to KRS).
    const result = await prisma.syncJob.updateMany({
      where: {
        status: SyncJobStatus.PENDING,
        type: { notIn: [SyncJobType.SALE, SyncJobType.VOID] },
      },
      data: {
        status: SyncJobStatus.SYNCED,
        response: 'HTTP 200 · INSERT KRS · {"rows":1}',
      },
    });
```

### 14. `src/types/index.ts` — add `VOID` to the local `SyncJobType` union

**Lines 326-333 — this is REQUIRED (not deferred), unlike the `NEEDS_RECONCILE`
precedent** which deliberately did NOT touch this file. `syncMeta.ts`'s
`JOB_TYPE_LABEL` (Touchpoint 15) is an exhaustive `Record<SyncJobType, string>` keyed
on THIS local union — the task explicitly wants a UI label for VOID, so both must be
updated together or `npm run build` fails with TS2741 ("Property 'VOID' is missing").
```typescript
export type SyncJobType =
  | "SALE"
  | "REFUND"
  | "STOCK"
  | "PULL"
  | "TAX_INVOICE"
  | "STOCK_ADJ"
  | "RECEIVE"
  | "VOID";
```

### 15. `src/components/data/syncMeta.ts` — VOID job-type label (lines 40-48,
paired 1:1 with Touchpoint 14)

```typescript
const JOB_TYPE_LABEL: Record<SyncJobType, string> = {
  SALE: "ขาย · Sale",
  REFUND: "คืนเงิน · Refund",
  STOCK: "สต็อก · Stock",
  PULL: "ดึงข้อมูล · Pull",
  TAX_INVOICE: "ใบกำกับภาษี · Tax invoice",
  STOCK_ADJ: "ปรับสต็อก · Stock adj.",
  RECEIVE: "รับสินค้าเข้า · Goods receipt",
  VOID: "ยกเลิกบิล · Void",
};
```

### 16. `src/components/sales/saleMeta.ts` — remove the refund filter chip

- `SalesFilter` union (lines 51-57): drop `| "refunded"`.
- `SALES_FILTERS` array (lines 59-66): drop the `{ key: "refunded", ... }` entry.
- `matchesFilter` (lines 69-86): drop the `case "refunded": return order.status ===
  "REFUNDED";` branch (lines 75-76).
- **Keep unchanged:** `STATUS_META.REFUNDED` badge entry (line 20) — historical
  REFUNDED orders still render correctly; only the filter *chip* and the action that
  *creates* new REFUNDED orders are removed.

### 17. `src/components/sales/SaleDetailDrawer.tsx` — remove Refund, add void confirm

**17a. Props (lines 15-31) — remove `onRefund`:**
```typescript
type SaleDetailDrawerProps = {
  order: OrderDTO | null;
  busy: boolean;
  onClose: () => void;
  onVoid: (order: OrderDTO) => void;
  onRequestTax: (order: OrderDTO) => void;
  onPrint: (order: OrderDTO) => void;
  onPrintTaxInvoice: (order: OrderDTO) => void;
};
```
Drop `onRefund` from the destructured params (line 51) too.

**17b. Gates (lines 123-124) — drop `canRefund`; `canVoid` no longer excludes SYNCED
(the whole point of this program):**
```typescript
  const canVoid = order.status === "COMPLETED";
```

**17c. Actions block (lines 285-309) — replace the `(canRefund || canVoid)` wrapper +
both buttons with a single conditional Void button (drop the `flex gap-[9px]` row
wrapper — it's the only action of its kind now, matching the standalone Print button's
own-row pattern below it), wired through a confirm dialog. The confirm copy branches on
whether this bill was ever synced (design/Simple POS.dc.html:1402 ported the original
"only unsynced bills" wording, which is now FALSE — do not reuse that copy verbatim):**
```typescript
          {canVoid && (
            <button
              type="button"
              onClick={() => {
                const msg =
                  order.syncStatus === "SYNCED"
                    ? "ยกเลิกบิลนี้และส่งยกเลิกเข้าระบบบัญชีใช่หรือไม่\nVoid this bill and send the cancellation to KRS?"
                    : "ยกเลิกบิลนี้ใช่หรือไม่\nVoid this bill?";
                if (!window.confirm(msg)) return;
                onVoid(order);
              }}
              disabled={busy}
              className="flex h-[46px] items-center justify-center rounded-[11px] border text-[13px] font-semibold transition hover:bg-[#fef2f2] disabled:opacity-50"
              style={{ borderColor: "#fecaca", color: "#dc2626" }}
            >
              ยกเลิก · Void
            </button>
          )}
```

### 18. `src/app/(shell)/sales/page.tsx` — remove refund wiring, void toast branches
on sync outcome

**18a. `patchOrder` (lines 112-145) — rename to `voidOrder`, drop the `action`
parameter (only void remains), branch the success toast on the response's
`syncStatus`:**
```typescript
  // ---- void (PATCH /api/orders/[id] {action:"void"}) ----
  async function voidOrder(order: OrderDTO) {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "void" }),
      });
      if (!res.ok) {
        let msg = "ยกเลิกบิลไม่สำเร็จ";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* keep default */
        }
        showToast(msg);
        return;
      }
      const updated = (await res.json()) as OrderDTO;
      setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
      setDetail(null);
      showToast(
        updated.syncStatus === "SYNCED"
          ? "ยกเลิกบิลแล้ว · กำลังยกเลิกในระบบบัญชี"
          : "ยกเลิกบิลแล้ว (Void)"
      );
    } catch {
      showToast("ยกเลิกบิลไม่สำเร็จ");
    } finally {
      setActionBusy(false);
    }
  }
```

**18b. `SaleDetailDrawer` wiring (lines 318-327) — drop `onRefund` prop, point `onVoid`
at the renamed function:**
```typescript
      <SaleDetailDrawer
        order={detail}
        busy={actionBusy}
        onClose={() => setDetail(null)}
        onVoid={voidOrder}
        onRequestTax={requestTax}
        onPrint={reprint}
        onPrintTaxInvoice={printTaxInvoice}
      />
```

### 19. `scripts/krs-void-proof.cjs` — new, read-only verification script

Direct copy of the `scripts/krs-discount-proof.cjs` connection pattern (targets the
LIVE `KrsConnectionSettings` singleton — the same server the vendor demonstrated
writes against, decrypted via `KRS_CONFIG_ENC_KEY`; **not** `KRS_SANDBOX_*`, matching
the existing precedent script for this program). For each test order number passed as
an argv, look up the 4 documents by `PosBillNo` and print their `IsClosed` values:
```sql
SELECT h.PosBillNo, h.VoucherNo, h.IsClosed AS HdrIsClosed
FROM dbo.SalesInvoiceHdr h WHERE h.PosBillNo = @ref;

SELECT t.IsClosed AS TaxIsClosed FROM dbo.SalePurchaseTax t
WHERE t.VoucherNo = (SELECT VoucherNo FROM dbo.SalesInvoiceHdr WHERE PosBillNo = @ref);

SELECT j.IsClosed AS JnlIsClosed, COUNT(*) AS Rows FROM dbo.TheJournal j
WHERE j.VoucherNo = (SELECT VoucherNo FROM dbo.SalesInvoiceHdr WHERE PosBillNo = @ref)
GROUP BY j.IsClosed;

SELECT f.PosBillNo, f.VoucherNo, f.IsClosed AS FlowIsClosed, f.IsClosedBy, f.IsClosedDate
FROM dbo.InventoryFlowHdr f WHERE f.PosBillNo = @ref;
```
Print a per-order OK/FAIL verdict: OK iff `HdrIsClosed=1`, `TaxIsClosed=0`,
`JnlIsClosed=1` for all 3 rows, `FlowIsClosed=1` with a non-null `IsClosedBy`/
`IsClosedDate`. This is the script used in the live-test step of the Rollout Gates below.

---

## Public Contracts

| Surface | Before | After |
|---|---|---|
| `SyncJobType` (Prisma enum) | 7 values | +`VOID` (additive migration) |
| `SyncJobType` (`src/types/index.ts` local union) | 7 values | +`"VOID"` (REQUIRED this time — paired with `JOB_TYPE_LABEL`) |
| `OrderPatchBodySchema.action` | `"refund" \| "void" \| "request-tax"` | `"void" \| "request-tax"` |
| `PATCH /api/orders/[id] {action:"void"}` on a SYNCED bill | 409 `VOID_SYNCED_LOCKED` | 200 — voids, restores stock, enqueues a `VOID` SyncJob |
| `PATCH /api/orders/[id] {action:"refund"}` | 200, sets REFUNDED | 400 `BAD_ACTION` (Zod rejects) |
| `markSyncedAndAdvance` (dispatcher.ts, internal) | `(jobId, attempts, response, lines)` | `(jobId, attempts, response, lines, warehouseCode, direction, orderNumber)` |
| `advanceGlobalSnapshotForSale` (dispatcher.ts, internal) | decrements global sentinel only | renamed `applySnapshotDelta`; decrements/increments BOTH global sentinel and per-warehouse row |
| `cancelSaleInKrs` / `parseVoidPayload` / `VoidPayload` | do not exist | new exports from `@/lib/krs` |
| `Order.syncStatus` | never reaches `SYNCED` via real code | dispatcher flips it to `SYNCED` on `SALE`/`VOID` success |
| `KRS_VOID_WRITE_ENABLED` | does not exist | new env var, default `"false"`, same pattern as `KRS_DISCOUNT_WRITE_ENABLED` |
| `SaleDetailDrawerProps` | has `onRefund` | `onRefund` removed |
| `SalesFilter` | includes `"refunded"` | `"refunded"` removed |
| `/api/sync-jobs POST {action:"insert-all"}` | drains ALL pending types | excludes `SALE`/`VOID` |

---

## Blast Radius

**Must NOT regress:**
- **Checkout / `orders/route.ts` (POST):** completely untouched. No touchpoint in this
  plan modifies it.
- **`writeback.ts` SALE write path:** untouched — only `KrsWriteError` (already
  exported) is imported by the new `cancelSale.ts`.
- **SALE reclaim/burned-anchor logic (dispatcher.ts lines ~389-483 in the pre-Phase-2
  numbering):** textually unchanged; the new VOID branch `continue`s before reaching it.
- **Discount-write gate (`salePayloadHasDiscount`/`KRS_DISCOUNT_WRITE_ENABLED`):**
  untouched; still SALE-only, still placed after the reclaim block.
- **`stockReconcile.ts` / `watermark.ts` / `autoSync.ts`:** zero edits. Both phases only
  change what `KrsStockSnapshot` baseline those files read from — never their own logic.
- **Historical REFUNDED orders:** `AuditAction.ORDER_REFUNDED`, `SaleStatus.REFUNDED`,
  and `STATUS_META.REFUNDED` all stay — only the ability to *create* a new one is
  removed.
- **`STOCK_REVERSAL` TODO (orders/[id]/route.ts, unsynced-void path):** untouched —
  still a documented gap, still out of scope.
- **Money Contract / Z-report / promotions report (`COMPLETED`-only aggregates):** a
  voided order's `total`/`tax` were already zeroed pre-void by existing code; this plan
  does not change that zeroing, only *when* the void is reachable.
- **Feature flags stay dark by default:** `KRS_VOID_WRITE_ENABLED=false` everywhere
  until the owner flips it (never the agent) — see Rollout Gates.
- **Snapshot exactly-once guard (`snapshotAdvancedAt`):** preserved verbatim — the
  generalized `applySnapshotDelta`/`markSyncedAndAdvance` still gate the delta apply on
  `claimed.count === 1`, unchanged from the burned-anchor plan's design.

**Newly acknowledged, not fixed by this plan (documented, not silently ignored):**
- `/api/sync-jobs POST {action:"insert-all"}` was ALREADY capable of fake-SYNCing real
  `SALE` jobs before this plan (a pre-existing gap this research surfaced) — Touchpoint
  13 fixes both `SALE` and `VOID` in the same edit since it's the same one-line fix.
- The alive-but-slow double-write race (crash-window 9,
  `krs-writeback-idempotency_PLAN_27-06-26.md`) is SALE-specific and untouched by VOID
  — VOID's idempotent-UPDATE design has no equivalent race (see Invariants #3 below).

---

## Invariants

1. **VOID needs no burned anchor.** `writeKrsSale`'s two-phase burn/reclaim design
   exists solely because `SalesInvoiceHdr.TransactionNo` is claimed once and a
   duplicate INSERT would silently create a second document. `cancelSaleInKrs`'s 4
   UPDATEs target existing rows by `VoucherNo` — re-running them against an
   already-`IsClosed=1` row is a no-op UPDATE, not a duplicate. No anchor, no reclaim
   block, no `NEEDS_RECONCILE` routing needed for VOID.
2. **Snapshot delta is exactly-once; `Order.syncStatus` flip is idempotent-always.**
   Inside `markSyncedAndAdvance`, `applySnapshotDelta` only runs on the
   `snapshotAdvancedAt IS NULL` winning branch (unchanged from the burned-anchor
   design). The new `tx.order.updateMany({ syncStatus: SYNCED })` runs unconditionally
   after the if/else — safe because re-asserting `SYNCED` on an already-`SYNCED` order
   is a true no-op.
3. **The alive-but-slow double-write race does not apply to VOID.** That race
   (crash-window 9 in the idempotency plan) requires a *claimed* resource
   (`TransactionNo`) that a second writer could also claim. VOID's UPDATEs are
   idempotent by construction — two concurrent dispatchers both running the same 4
   UPDATEs against the same `VoucherNo` converge to the identical end state
   (`IsClosed=1`/`0` as specified), not a duplicate row. No `UNIQUE` constraint
   pre-enable gate is needed for VOID (unlike SALE).
4. **Watermark blindness is covered by the unconditional full sweep, not the realtime
   poller.** `fetchChangedDocs` (`watermark.ts:242-244`) triggers on
   `TransactionNo`/`EntryDate`/`ApprovedDate` changes only — an `IsClosed`-only UPDATE
   trips none of them, so the (currently-dormant, `KRS_RT_POLL_ENABLED=false`) 2s
   realtime poller would miss a VOID's stock restoration. This does not matter in
   practice: the ≤60s safety-net sweep (`autoSync.ts` → `reconcileStock(config,
   "ALL")`, live today) visits every item unconditionally every cycle regardless of
   watermark signals, so it observes the restored on-hand on its own next tick. The
   snapshot pre-increment in Touchpoint 6d (`markSyncedAndAdvance(..., "increment")`)
   is what prevents that sweep from double-counting the restoration — not the
   watermark.
5. **`wasSynced` is decided once, at PATCH time, from a single snapshot read.** The
   existing `transitionWhere`/conditional-`updateMany` (race-safe double-fire guard,
   `count !== 1` → `OrderStateConflictError`) is unchanged and still the authoritative
   gate against two concurrent void requests. `wasSynced` itself does not need its own
   race guard beyond that — a bill's `syncStatus` cannot flip from `SYNCED` back to
   non-`SYNCED` by any other code path, so re-reading it inside the transaction would
   observe the same value the pre-transaction read saw (unlike the old `VOID_SYNCED_LOCKED`
   check, which guarded against `syncStatus` racing the OTHER direction, PENDING→SYNCED,
   during the void — a race that no longer needs guarding since a SYNCED bill is now
   always voidable).

---

## Rollout Gates

1. **Deploy Phase 1 immediately** (bugfix, no flag) — `dispatcher.ts` snapshot-advance
   fix + `krs-stock-trueup.cjs`. Run the true-up script in **dry-run** first, review the
   drift report with the owner, then `--apply` once.
2. **Phase 2 ships dark:** merge with `KRS_VOID_WRITE_ENABLED=false` everywhere. The
   Postgres-side void-of-a-synced-bill (stock restore, `VOID` SyncJob enqueue) is live
   immediately on merge — only the KRS write itself is held.
3. **Live test (owner/vendor permission required):** sell one small test bill, let it
   sync (`KRS_OUTBOUND_ENABLED=true` already live), void it from the POS UI, then flip
   `KRS_VOID_WRITE_ENABLED=true` on the box and let the next dispatch cycle drain the
   held job (or manually retry it). Run `scripts/krs-void-proof.cjs <orderNumber>` to
   confirm all 4 documents closed as specified.
4. **Voiding a synced test bill inherently restores ERP stock** (closing the
   InventoryFlow doc) — this satisfies "remove test stock from KRS" as a side effect of
   the test itself. Report the test order number(s) to the vendor.
5. **Vendor confirms the sample** and answers the 2 pending questions: (a) the
   `SalePurchaseTax IsClosed=0` asymmetry, (b) `IsClosedBy` value semantics /
   accounting-period-close window interaction.
6. **OWNER flips `KRS_VOID_WRITE_ENABLED=true`** on the production box — never the
   agent (mirrors `KRS_DISCOUNT_WRITE_ENABLED`/`KRS_OUTBOUND_ENABLED` precedent).

---

## Phase Completion Rules

- **Phase 1 is CODE DONE** when both verify commands exit 0 and the
  dispatcher/trueup-script touchpoints above are implemented exactly as specified.
  Phase 1 is **VERIFIED** only after it is deployed AND the true-up script's
  dry-run/`--apply` results have been reviewed by the owner (Rollout Gate 1) —
  code-only completion must be reported as `CODE DONE`, not `VERIFIED`, until that
  live confirmation happens.
- **Phase 2 is CODE DONE** when both verify commands exit 0, `KRS_VOID_WRITE_ENABLED=
  false` everywhere, and every Touchpoint 3-19 item is implemented. Phase 2 is
  **VERIFIED** only after Rollout Gates 3-5 (live test → `krs-void-proof.cjs` confirms
  all 4 documents → vendor confirms the sample) complete — a green build alone never
  justifies calling Phase 2 "live" or "working," since the flag stays off by design
  until the owner acts (Rollout Gate 6).
- Neither phase's green check proves the OTHER phase's correctness — Phase 1's fix is
  a prerequisite for Phase 2's snapshot symmetry (Invariant #4) but each phase's
  checklist/verify gate stands on its own.
- This plan stays in `active/` (not archived to `completed/`) until Phase 2 is
  VERIFIED (owner has flipped `KRS_VOID_WRITE_ENABLED=true` in production) — see
  Resume and Execution Handoff.

---

## Verification Evidence

Verification routing follows `process/context/all-context.md` →
`process/context/tests/all-tests.md` — there is no automated test runner in this repo
yet, so static type-check/build plus the manual matrix below are the authoritative
verification gates (per the testing context's documented pattern for this project).

**Static (required for BOTH phases, every commit):**
- `npm run type-check` exits 0.
- `npm run build` exits 0. Phase 2's build gate specifically must confirm **no TS2741**
  from `syncMeta.ts`'s `JOB_TYPE_LABEL` (Touchpoint 14+15 must land together) and no
  duplicate-identifier errors from the `dispatcher.ts` `applySnapshotDelta` rename.
- No `next lint` (not configured — per repo convention, skip).

**Manual verification matrix (document the code-path argument in the PR, mirroring
the burned-anchor plan's Crash-Point Safety Table style):**

| Scenario | Expected |
|---|---|
| Void an UNSYNCED COMPLETED bill (existing path) | 200, `status=VOIDED`, `syncStatus=SKIPPED`, stock restored, NO `VOID` SyncJob created — byte-identical to current behavior |
| Void a SYNCED COMPLETED bill, `KRS_VOID_WRITE_ENABLED=false` | 200, `status=VOIDED`, `syncStatus` stays `SYNCED`, stock restored immediately, a `VOID` SyncJob is created `PENDING`, dispatcher holds it (`requeueHeld`, no attempt counted) |
| Void a SYNCED COMPLETED bill, `KRS_VOID_WRITE_ENABLED=true`, sandbox test env | `VOID` job dispatches, `cancelSaleInKrs` resolves docs via PosBillNo, all 4 UPDATEs run, `hdrRowsUpdated=1`/`flowRowsUpdated>=1` asserted, job `SYNCED`, per-warehouse + global `KrsStockSnapshot` incremented, `Order.syncStatus` re-asserted `SYNCED` |
| Retry a `VOID` job after a mid-write crash | Next dispatch re-resolves docs (idempotent UPDATEs), no `NEEDS_RECONCILE`, no duplicate journal rows (UPDATE, not INSERT) |
| Void a bill with no `PosBillNo` in KRS (pre-16-07 bill) AND no `saleRef` in the original SALE job's stored `response` | `cancelSaleInKrs` throws `KrsWriteError` "Cannot resolve KRS documents" → job `FAILED`/retried — a clean, loud manual case, never a silent no-op |
| Void a SYNCED bill whose original SALE SyncJob is missing/unparseable | `VoidMissingSaleJobError` → 500 `VOID_MISSING_SALE_JOB`, whole PATCH rolls back (bill stays COMPLETED, no partial state) |
| Double-void the same bill (double-fire race) | Second request's `transitionWhere` `updateMany` matches 0 rows → `OrderStateConflictError` → 409 `INVALID_STATE` (unchanged existing guard) |
| `POST /api/orders/[id] {action:"refund"}` | 400 `BAD_ACTION` (Zod rejects before reaching the route body) |
| `POST /api/sync-jobs {action:"insert-all"}` with a PENDING `VOID` job queued | The `VOID` job is NOT touched (excluded by `notIn`); only genuinely-simulated types drain |
| A synced sale's next `≤60s` reconcile sweep (Phase 1 fix) | `intDelta` computed against the freshly-decremented per-warehouse snapshot row = `0` for that item — no double-decrement |
| A voided-and-cancelled sale's next `≤60s` reconcile sweep (Phase 2) | `intDelta = 0` for the restored item — no double-increment |
| `krs-stock-trueup.cjs` dry-run on already-drifted prod data | Prints per-item drift with no writes; `--apply` afterward converges `Product.stock` to `Σ` per-warehouse snapshot, skipping any item with an in-flight `SALE`/`VOID` job |

**Live-test SQL/proof steps** — see Rollout Gates step 3 and `scripts/krs-void-proof.cjs`
(Touchpoint 19) for the exact queries.

**Pricing-tester:** NOT needed — `src/app/api/orders/route.ts` (checkout) is untouched.

---

## Dependencies and Risks

| Item | Risk | Mitigation |
|---|---|---|
| `Order.syncStatus` never reached `SYNCED` before this plan | **HIGH if unaddressed** — the entire "void a synced bill" feature would be unreachable in production | Fixed as a mandatory part of Touchpoint 6 (`markSyncedAndAdvance` flips it); explicitly called out as a Critical Prerequisite Finding, not an optional nice-to-have |
| `SalePurchaseTax IsClosed=0` asymmetry | MEDIUM — vendor-confirm pending | Implemented verbatim per the vendor's spec; flagged in Rollout Gates step 5 as a pending confirm, not blocking merge (code ships dark) |
| Pre-16/17-07-26 bills lack `PosBillNo` in KRS | MEDIUM — `cancelSaleInKrs` PosBillNo lookup misses | `saleRef` fallback (from the original SALE job's stored `response`); if both miss, loud `KrsWriteError`, never a silent no-op |
| A SYNCED order's original SALE SyncJob missing/corrupted | LOW (should not happen post-Phase-1) but HIGH severity if it does | `VoidMissingSaleJobError` — 500, whole void rolls back, no partial state |
| `krs-stock-trueup.cjs --apply` racing a live dispatch | MEDIUM — rebasing `Product.stock` while a `SALE`/`VOID` job is mid-flight could clobber a concurrent decrement/increment | Script skips any item with a `PENDING`/`RETRYING` `SALE`/`VOID` job before applying |
| `insert-all` simulated drain already fake-SYNCing real `SALE` jobs (pre-existing) | MEDIUM — silent bookkeeping corruption if triggered today | Fixed in the same Touchpoint 13 edit that also excludes `VOID` |
| `TS2741` if Touchpoint 14 (local `SyncJobType` union) and 15 (`JOB_TYPE_LABEL`) land separately | HIGH if split across commits — build breaks | Plan explicitly pairs them 1:1 and calls out the REQUIRED (not deferred) nature, unlike the `NEEDS_RECONCILE` precedent |
| Removing `VOID_SYNCED_LOCKED` changes a documented domain rule (`domain-synced-bills-locked`) | LOW — this is an explicit 19-07-26 owner decision superseding it, stated at the top of this plan | Comment in Touchpoint 12c states the supersession explicitly so a future reader doesn't "fix" it back |

---

## Implementation Checklist

### Phase 1 (urgent, ship first, no flag)

1. `src/lib/krs/dispatcher.ts` — replace `advanceGlobalSnapshotForSale` with
   `applySnapshotDelta(tx, lines, warehouseCode, direction)` (Touchpoint 1a).
2. `src/lib/krs/dispatcher.ts` — update `markSyncedAndAdvance` signature + body to
   accept `warehouseCode`, `direction`, `orderNumber`, and flip `Order.syncStatus`
   (Touchpoint 1b).
3. `src/lib/krs/dispatcher.ts` — update the two existing SALE call sites (reclaim-FOUND
   at ~410-415, KRS-write-success at ~526-538) with the 3 new trailing args
   (Touchpoint 1c).
4. `src/lib/krs/dispatcher.ts` — add `SyncStatus` to the `@prisma/client` import
   (Touchpoint 1d).
5. `scripts/krs-stock-trueup.cjs` — create (dry-run default, `--apply` guarded,
   in-flight-job skip) (Touchpoint 2).
6. `npm run type-check` — must exit 0.
7. `npm run build` — must exit 0.
8. Deploy. Run `krs-stock-trueup.cjs` dry-run, review with owner, then `--apply` once.

### Phase 2 (new capability, ships dark)

9. `prisma/schema.prisma` — add `VOID` to the `SyncJobType` enum (Touchpoint 3a).
10. Run `npx prisma migrate dev --name add_syncjob_type_void`; confirm the generated
    SQL is exactly `ALTER TYPE "SyncJobType" ADD VALUE 'VOID';` (Touchpoint 3b).
11. `src/lib/krs/voidPayload.ts` — create (Touchpoint 4).
12. `src/lib/krs/cancelSale.ts` — create (Touchpoint 5).
13. `src/lib/krs/dispatcher.ts` — import `cancelSaleInKrs`/`parseVoidPayload`, widen
    `claimJobs`'s type filter, add `type: true` to the `findUnique` select, insert the
    VOID branch (Touchpoints 6a-6d).
14. `src/lib/env.ts` — add `KRS_VOID_WRITE_ENABLED` (Touchpoint 7).
15. `docker-compose.yml` — add the passthrough + comment (Touchpoint 8).
16. `.env.example` — document the var (Touchpoint 9).
17. `src/lib/krs/index.ts` — export `cancelSaleInKrs`/`parseVoidPayload`/types
    (Touchpoint 10).
18. `src/lib/schemas/order.ts` — drop `refund` from the action enum (Touchpoint 11).
19. `src/app/api/orders/[id]/route.ts` — full rewrite per Touchpoints 12a-12k (widen
    `existing` select; drop refund handling; new `wasSynced` branch; drop
    `transitionWhere` lock; drop the `VoidSyncedLockedError` re-read block; enqueue the
    `VOID` SyncJob; new imports; new `VoidMissingSaleJobError` class replacing
    `VoidSyncedLockedError`; catch-block branch; collapse the refund ternaries; collapse
    the audit call).
20. `src/app/api/sync-jobs/route.ts` — exclude `SALE`/`VOID` from `insert-all`
    (Touchpoint 13).
21. `src/types/index.ts` — add `"VOID"` to the local `SyncJobType` union (Touchpoint 14).
22. `src/components/data/syncMeta.ts` — add `VOID` to `JOB_TYPE_LABEL` (Touchpoint 15,
    must land in the same commit as step 21).
23. `src/components/sales/saleMeta.ts` — remove the `"refunded"` filter (Touchpoint 16).
24. `src/components/sales/SaleDetailDrawer.tsx` — remove `onRefund`, update `canVoid`,
    replace the actions block with the confirm-gated Void button (Touchpoint 17).
25. `src/app/(shell)/sales/page.tsx` — rename `patchOrder`→`voidOrder`, branch the
    success toast, update `SaleDetailDrawer` wiring (Touchpoint 18).
26. `scripts/krs-void-proof.cjs` — create (Touchpoint 19).
27. `npm run type-check` — must exit 0. Confirm no TS2741 in `syncMeta.ts` (steps 21+22
    paired correctly) and no leftover reference to `onRefund`/`VoidSyncedLockedError`.
28. `npm run build` — must exit 0.
29. Merge with `KRS_VOID_WRITE_ENABLED=false`. Proceed through Rollout Gates 3-6 before
    the owner flips the flag.

---

## Residual / Out-of-Scope (explicitly deferred)

1. **`UNIQUE` constraint on `SalesInvoiceHdr.TransactionNo`** — unrelated to VOID (see
   Invariant #3); tracked separately in the burned-anchor plan's Residual §5.
2. **Realtime 2s poller (`KRS_RT_POLL_ENABLED`)** — stays dormant; not exercised by
   either phase (Invariant #4).
3. **`STOCK_REVERSAL` for an unsynced-bill void** — unchanged TODO, still deferred;
   genuinely different scope (no KRS documents exist yet to cancel).
4. **`NEEDS_RECONCILE` UI surfacing** — pre-existing deferred item from the burned-anchor
   plan, untouched here (VOID never routes to `NEEDS_RECONCILE` — see Invariant #1).
5. **A dedicated audit action for VOID-job KRS completion** — not added; mirrors SALE's
   existing lack of one (see Scope exclusions).
6. **Least-privilege KRS write login** (backlog item 8) — unrelated, unaddressed here.

---

## Touchpoints Summary (files touched)

**Phase 1:** `src/lib/krs/dispatcher.ts`, `scripts/krs-stock-trueup.cjs` (new).

**Phase 2:** `prisma/schema.prisma` + 1 migration, `src/lib/krs/voidPayload.ts` (new),
`src/lib/krs/cancelSale.ts` (new), `src/lib/krs/dispatcher.ts`, `src/lib/env.ts`,
`docker-compose.yml`, `.env.example`, `src/lib/krs/index.ts`,
`src/lib/schemas/order.ts`, `src/app/api/orders/[id]/route.ts`,
`src/app/api/sync-jobs/route.ts`, `src/types/index.ts`,
`src/components/data/syncMeta.ts`, `src/components/sales/saleMeta.ts`,
`src/components/sales/SaleDetailDrawer.tsx`, `src/app/(shell)/sales/page.tsx`,
`scripts/krs-void-proof.cjs` (new).

---

## Resume and Execution Handoff

**Plan path (single file):**
`process/features/krs-sync/active/krs-void-writeback_PLAN_19-07-26.md`

**This plan supports partial execution at the Phase boundary.** Phase 1 is a
self-contained, urgent, flag-free bugfix and may be executed/deployed independently
before Phase 2 starts. If resuming after Phase 1 already shipped, re-verify
`src/lib/krs/dispatcher.ts`'s `applySnapshotDelta`/`markSyncedAndAdvance` signatures
match Touchpoints 1a-1d exactly before starting Phase 2 Touchpoint 6 (which extends
the same functions).

**Execute with:**
```
ENTER EXECUTE MODE
Plan: process/features/krs-sync/active/krs-void-writeback_PLAN_19-07-26.md
Scope: Phase 1 only   (or "Phase 1 + Phase 2" if executing both in one pass)
```

**Execution order is fixed within each phase.** Phase 1: dispatcher.ts edits (checklist
1-4) before the true-up script is meaningful to run, but the script itself (step 5) can
be authored in parallel; type-check/build (6-7) must be last. Phase 2: schema +
migration (9-10) must precede any source edit referencing `SyncJobType.VOID`; the local
`src/types/index.ts` union (21) and `syncMeta.ts`'s `JOB_TYPE_LABEL` (22) must land in
the same commit; type-check/build (27-28) must be last; deploy/flag-flip (29) requires
explicit owner action, never the agent.

**Verify gate:** Both `npm run type-check` AND `npm run build` must exit 0 after each
phase. If either fails, do not mark that phase DONE (see Phase Completion Rules).

**Validator:** run
`node ~/.claude/skills/vc-generate-plan/scripts/validate-plan-artifact.mjs process/features/krs-sync/active/krs-void-writeback_PLAN_19-07-26.md`
before treating this plan as ready, per the `vc-generate-plan` skill contract.

**After EXECUTE completes (per phase):**
- After Phase 1: update `process/memory/krs-sync-program-state.md` to note the
  per-warehouse snapshot double-count bug CLOSED + the true-up script's dry-run/apply
  result. Do NOT archive this plan file yet — Phase 2 is still active.
- After Phase 2 code lands (still dark, flag off): note in memory that VOID writeback
  is CODE DONE, dark, awaiting Rollout Gates 3-6 (live test → vendor confirm → owner
  flag flip). Archive this plan to `process/features/krs-sync/completed/` only after
  the owner flips `KRS_VOID_WRITE_ENABLED=true` in production and the flip is
  confirmed live — not at code-merge time (mirrors how
  `krs-discount-writeback-contract` stayed tracked until its own flag flip).

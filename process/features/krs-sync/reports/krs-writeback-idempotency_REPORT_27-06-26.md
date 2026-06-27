# KRS Writeback Idempotency — P0 Closeout Report

**Feature:** krs-sync
**Plan:** `process/features/krs-sync/completed/krs-writeback-idempotency_PLAN_27-06-26.md`
**Date:** 2026-06-27
**Status:** COMPLETE (code-only; module dormant, KRS_OUTBOUND_ENABLED=false)

---

## What Was Implemented

**Burned-anchor idempotency design** for the KRS cash-sale writeback dispatcher.

**Root defect (v1/v2 plan and the original dispatcher code):** `SaleInvoiceTrNo` was claimed inside the SERIALIZABLE phase-1 document tx via `claimRunningNumber`. A phase-1 rollback reverts the `RunningNumber` increment, releasing the value for reuse by the next sale. On reclaim after the 10-minute stale-lock window, `checkKrsSaleExists("N")` could match a DIFFERENT sale's row — causing the original crashed sale to be silently marked SYNCED without ever being written to KRS.

**Corrected design:** Claim `SaleInvoiceTrNo` in a SEPARATE, IMMEDIATELY-COMMITTED READ COMMITTED tx (phase 0) before the SERIALIZABLE document tx (phase 1). A phase-1 rollback cannot revert the phase-0 increment. The burned number is persisted to `SyncJob.krsClaimedTxnNo` via an `onSaleTxnNoBurned` callback that fires after phase-0 commit and before phase-1 opens — no mssql tx is held open during the Postgres write. On reclaim, the dispatcher checks `krsClaimedTxnNo`; if non-null, calls `checkKrsSaleExists(burnedNo)` to determine committed vs rolled-back at the instant the check runs.

**Alive-but-slow double-write risk documented, not eliminated.** The burned anchor disambiguates at the instant the existence check runs; it does NOT prevent a concurrently-alive dispatcher A from committing the same `TransactionNo` after a reclaiming dispatcher B has already checked NOT FOUND and re-entered phase-1. The UNIQUE constraint on `KRS.SalesInvoiceHdr.TransactionNo` (and `InventoryFlowHdr.TransactionNo`) is the only server-side guard against that race. This constraint is a hard pre-enable gate (see Deferred section).

---

## Files Changed

| File | Change |
|---|---|
| `prisma/schema.prisma` | `SyncJob`: added `krsClaimedTxnNo String?`; `SyncJobStatus` Prisma enum: added `NEEDS_RECONCILE` |
| `prisma/migrations/20260627000000_add_syncjob_krs_claimed_txn_v2/migration.sql` | Additive only: `ADD COLUMN "krsClaimedTxnNo" TEXT` + `ALTER TYPE "SyncJobStatus" ADD VALUE 'NEEDS_RECONCILE'` |
| `src/lib/krs/writeback.ts` | Two-phase `writeKrsSale` (phase-0 burn tx + phase-1 SERIALIZABLE doc tx); `KrsWriteOpts` exported type; `checkKrsSaleExists` exported function; updated INVARIANTS comment block |
| `src/lib/krs/dispatcher.ts` | Reclaim existence-check block with per-job try/catch (FOUND → markSynced recovered; NOT FOUND → fall through with preClaimedSaleTxnNo; THROWS → NEEDS_RECONCILE at MAX_ATTEMPTS); `KrsWriteOpts` supplied to `writeKrsSale`; extended `findUnique` select to include `krsClaimedTxnNo`; updated header comments |
| `src/lib/krs/index.ts` | Added `checkKrsSaleExists` to value exports; added `KrsWriteOpts` to type export in-place (line 51 only — no second export type line) |

**Explicitly NOT changed (Amendment 3 guard):** `src/types/index.ts` local `SyncJobStatus` union stays at 5 values. `NEEDS_RECONCILE` was added to the Prisma schema enum only. The UI alias and its two exhaustive `Record<SyncJobStatus,...>` maps (`SYNC_JOB_META` in syncMeta.ts, `STATUS_COUNT_KEY` in SyncActivityTab.tsx) were intentionally left at 5 values to prevent TS2741.

---

## Verification

- `npm run type-check` — exits 0, zero TypeScript errors; confirmed no TS2741 in syncMeta.ts / SyncActivityTab.tsx (local union NOT updated — correct); no TS2451 duplicate-const in writeback.ts (replace-region was 322-345 — correct)
- `npm run build` — exits 0, Next.js build clean

**Adversarial post-implementation review trail (3-lens):**
- v1 plan: NO_GO — root defect: in-tx RunningNumber claim reverts on rollback; existence check was ambiguous (could match a different sale's row)
- v2 plan: GO_WITH_AMENDMENTS — 6 must-fix corrections: honest alive-but-slow scope, replace-region fix 322-345 not 322-338, Amendment 3 NEEDS_RECONCILE build-break guard, UNIQUE constraint documented as hard pre-enable gate, per-job try/catch wrapping, NEEDS_RECONCILE vs FAILED routing
- v3 plan: SHIP — zero must-fix items; all amendments folded in

---

## Deferred Pre-Enable Gates

The module remains dormant (`KRS_OUTBOUND_ENABLED=false`). Before any flag-on, ALL of the following must be completed:

1. **UNIQUE constraint on `KRS.dbo.SalesInvoiceHdr(TransactionNo)`** — REQUIRED (owner/DBA action). The only server-side guard against alive-but-slow double-write (crash-window 9). Without it, two concurrent dispatchers can each commit the same `TransactionNo`, producing a double row, double journal entry, and double stock cut.
2. **UNIQUE constraint on `KRS.dbo.InventoryFlowHdr(TransactionNo)`** — REQUIRED (owner/DBA action). Same rationale for the inventory-flow side.
3. Confirm `SalesInvoiceHdr.TransactionNo` column is `NVARCHAR` (type safety for the `@txnNo NVarChar` binding in `checkKrsSaleExists`; needed for sargable WHERE).
4. Confirm KRS isolation level is RCSI (needed for post-commit row visibility at the existence check; adjust expectation if lock-based READ COMMITTED).
5. Acknowledge `SaleInvoiceTrNo` may have rare gaps on crash-window 3 (crash after burn-commit, before Postgres persist). Internal surrogate only; human-facing VoucherNo (`SC-YYMM-NNNN`) stays in-tx and gapless.
6. Apply migration `20260627000000_add_syncjob_krs_claimed_txn_v2` to real DBs (dev + prod) before enabling.
7. Sandbox write smoke test with explicit owner consent and configured `KRS_SANDBOX_*` creds.

**Additional deferred items (plan Residual §6-8):**
- `NEEDS_RECONCILE` UI surface: currently renders as "ไม่ทราบ / Unknown" (syncMeta.ts fallback); silently dropped from KPI counts; requires coordinated update of `SYNC_JOB_META`, `STATUS_COUNT_KEY`, `STATUS_ORDER`, `EMPTY_COUNTS`, `SyncCountsDTO`, and the local `SyncJobStatus` alias
- Dispatch batch run-lock (defense-in-depth): `runDispatch` has no app-level singleton run-lock unlike `runAutoSync` (autoSync.ts:116-150); recommended before enabling
- Phase-1 wall-time cap (defense-in-depth): explicit wall-clock abort for phase-1 beyond a threshold well below `LOCK_STALE_MS`
- STOCK_REVERSAL / refund-void idempotency: same crash-window gap exists for refund/void jobs; separate future work

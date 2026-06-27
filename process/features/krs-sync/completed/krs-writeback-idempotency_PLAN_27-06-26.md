# KRS Writeback Idempotency — P0 Crash-Window Fix (v3: Burned Anchor + Concurrency Corrections)
**Plan:** `process/features/krs-sync/active/krs-writeback-idempotency_PLAN_27-06-26.md`
**Feature:** krs-sync
**Complexity:** SIMPLE
**Date:** 27-06-26
**Status:** READY FOR EXECUTE (v3 — post-GO_WITH_AMENDMENTS corrections)

---

## Revision History

| Version | Date | Change |
|---|---|---|
| v1 | 27-06-26 | Initial plan — reusable anchor (`onDocNumbersClaimed` inside SERIALIZABLE tx). |
| v2 | 27-06-26 | Full redesign after NO_GO adversarial review. Root defect: in-tx RunningNumber claim reverts on rollback releasing the value for reuse, making existence check ambiguous. Corrected design: burned anchor (separate committed phase-0 tx). All 6 must-fixes and nice-to-haves folded in. `clearClaimedTxnNo` eliminated. `NEEDS_RECONCILE` status added. |
| v3 | 27-06-26 | GO_WITH_AMENDMENTS corrections. (1) Removed false claim that alive-but-slow double-write is impossible; reframed invariants #2/#4 and crash-window 9 truthfully; added UNIQUE constraint on `SalesInvoiceHdr.TransactionNo` as hard pre-enable gate; added defense-in-depth follow-ups (run-lock, wall-cap) as documented Residual items. (2) Fixed §3c replace-region "322-338" → "322-345" to cover voucher-number derivations; added explicit instruction to remove stale `const saleTxnNo` at line 336 (prevents TS2451 duplicate-const → build break). (3) Added prominent Amendment 3 guard: do NOT add `NEEDS_RECONCILE` to `src/types/index.ts` local union — would make `Record<SyncJobStatus,...>` maps non-exhaustive → TS2741 → build fail. Nice-to-haves: enum line-citation corrected to 101-107, `KrsWriteOpts` JSDoc clarified, `NEEDS_RECONCILE` UI gap documented, dispatch-vs-autoSync single-flight asymmetry noted. |

---

## Overview

Close the P0 double-write gap in the KRS cash-sale writeback dispatcher. A crash between the MS SQL `tx.commit()` (writeback.ts:570) and the Postgres `markSynced` call (dispatcher.ts:287) leaves the SyncJob in `RETRYING` with a stale lock. After 10 minutes (`LOCK_STALE_MS=600_000`, dispatcher.ts:39) the job is re-claimable.

**Why v1 was wrong.** The v1 plan claimed `SaleInvoiceTrNo` inside the SERIALIZABLE document tx via `claimRunningNumber` (writeback.ts:178-199, called at writeback.ts:323). An mssql tx rollback (writeback.ts:584-590) REVERTS the `UPDATE RunningNumber SET Number=Number+1` increment — releasing the value back to the shared counter. Within the 10-minute stale-lock window, the next sale reuses it. On reclaim, `checkKrsSaleExists("42")` then matches a DIFFERENT sale's `SalesInvoiceHdr` row, leading `markSynced(recovered)` to seal our crashed sale as SYNCED without writing — the crashed sale is silently dropped from the ERP.

**Corrected design: burn the anchor.** Claim `SaleInvoiceTrNo` in a SEPARATE, IMMEDIATELY-COMMITTED mssql transaction (phase 0, READ COMMITTED) BEFORE the SERIALIZABLE document tx (phase 1). A later rollback of phase-1 cannot revert the phase-0 increment. `checkKrsSaleExists(burnedNo)` returned FOUND means our phase-1 committed that row **at the instant the check ran** (see honest concurrency note below). NOT FOUND means our phase-1 rolled back — safe to reuse the burned number in a fresh phase-1.

**Honest concurrency scope.** The burned anchor disambiguates committed vs rolled-back at the instant the existence check runs. It does NOT prevent an alive-but-slow dispatcher A from committing phase-1 AFTER a reclaiming dispatcher B has already checked (NOT FOUND) and re-entered phase-1. That alive-but-slow window is a real double-write risk. The ONLY mechanism that makes A's late commit fail is a `UNIQUE` constraint on `KRS.SalesInvoiceHdr.TransactionNo` — a hard owner/DBA action required before enabling. This code pass does not build that constraint; the module is dormant and no ERP write occurs.

The Postgres anchor-write (`onSaleTxnNoBurned` callback) fires AFTER the phase-0 burn-commit and BEFORE the phase-1 SERIALIZABLE tx opens — no mssql tx is held open during the Postgres round-trip.

The KRS module remains dormant (`KRS_OUTBOUND_ENABLED=false`). This is code-only work; verification is `npm run type-check` + `npm run build` only — no ERP write at any point.

---

## Goals

1. Guarantee that a re-claimed job whose phase-1 document tx committed to KRS **at the time the existence check ran** is detected (FOUND) and marked SYNCED without re-running `writeKrsSale`.
2. Guarantee that a re-claimed job whose phase-1 tx rolled back proceeds with a fresh phase-1 run REUSING the burned anchor (no new burn = no inflated gaps in `SaleInvoiceTrNo`).
3. Guarantee that a job where the process crashed BEFORE persisting the burned anchor burns a new anchor on retry (acceptable gap in internal `SaleInvoiceTrNo`; human-facing `VoucherNo` stays gapless in-tx).
4. Preserve all existing invariants: no-prisma in writeback.ts, SERIALIZABLE phase-1 atomicity, fail-open checkout path, no ERP write at build/test time, feature flag dormant.
5. Route existence-check-persistent-throws jobs to `NEEDS_RECONCILE` (not terminal `FAILED`) so an operator can investigate. Document that this state is not yet surfaced in the UI (deferred).
6. Document the alive-but-slow double-write risk honestly and gate enablement on a UNIQUE constraint in KRS.

---

## Scope

**In scope (code changes only):**
- `prisma/schema.prisma` — add `krsClaimedTxnNo String?` to SyncJob; add `NEEDS_RECONCILE` to Prisma SyncJobStatus enum
- Prisma migration — additive only: one nullable column + one enum value
- `src/lib/krs/writeback.ts` — two-phase `writeKrsSale`; `KrsWriteOpts` type; `checkKrsSaleExists` helper; new section banner
- `src/lib/krs/dispatcher.ts` — reclaim block (per-job try/catch); NEEDS_RECONCILE routing; callback supply; extended select; header comment update
- `src/lib/krs/index.ts` — add `checkKrsSaleExists` and `KrsWriteOpts` to public exports (in-place, no duplicate type export)

**Explicitly excluded from all edits:**
- `src/types/index.ts` local `SyncJobStatus` union — do NOT add `NEEDS_RECONCILE` here (see §1b and Blast Radius)
- `src/components/data/syncMeta.ts` — do NOT add `NEEDS_RECONCILE` to `SYNC_JOB_META` (deferred UI change)
- `src/components/data/SyncActivityTab.tsx` — do NOT add `NEEDS_RECONCILE` to `STATUS_COUNT_KEY` or `STATUS_ORDER` (deferred UI change)
- STOCK_REVERSAL / refund/void idempotency — separate future work
- Family-1 vendor Remarks anchor — future simplification
- Sandbox write smoke test — gated on explicit user consent + `KRS_SANDBOX_*` creds
- `salePayload.ts`, `writebackConfig.ts`, `sandboxClient.ts` — untouched
- `src/app/api/orders/route.ts` (checkout) — untouched; pricing-tester NOT needed
- Flag-on enablement — separate owner-approved operational step; blocked on UNIQUE constraint in KRS (see Residual §5)

---

## Touchpoints

### 1. `prisma/schema.prisma`

**1a. SyncJob model — add field after `lockedAt DateTime?` (line 73):**

```
krsClaimedTxnNo  String?   // SaleInvoiceTrNo burned in a SEPARATE committed phase-0 tx.
                            // Non-null = a prior attempt burned this number. Reclaim uses
                            // checkKrsSaleExists to decide: FOUND → markSynced; NOT FOUND
                            // → reuse via preClaimedSaleTxnNo (no new burn). Never cleared
                            // after a phase-1 failure — must be reused, never replaced.
```

No `@unique`, no index. Additive nullable column; all existing rows default to null.

**1b. SyncJobStatus enum — add `NEEDS_RECONCILE` to the Prisma enum ONLY (lines 101-107):**

> **AMENDMENT 3 — BUILD-BREAK GUARD (critical):** Add `NEEDS_RECONCILE` ONLY to the Prisma schema enum below. Do NOT add it to `src/types/index.ts:192-197` (the local `SyncJobStatus` string union, comment: "mirrors the Prisma SyncJobStatus enum"). That union drives `SYNC_JOB_META: Record<SyncJobStatus, SyncBadgeMeta>` (syncMeta.ts:19) and `STATUS_COUNT_KEY: Record<SyncJobStatus, keyof SyncCountsDTO>` (SyncActivityTab.tsx:66). Adding a 6th value to the union without simultaneously adding it to both Record maps causes TS2741 ("Property missing") → `npm run build` fails. The Prisma enum (6 values after this change) and the UI alias (5 values — intentional) are deliberately decoupled. Do not "keep them in sync" in this pass.

```prisma
enum SyncJobStatus {
  PENDING
  SYNCED
  FAILED
  RETRYING
  SKIPPED
  NEEDS_RECONCILE   // burned anchor held but existence check persistently fails;
                    // operator must reconcile before re-entry (NOT auto-claimable);
                    // UI-alias NOT updated in this pass (see Residual §6)
}
```

`claimJobs` filters only `PENDING|RETRYING` — `NEEDS_RECONCILE` is excluded automatically. No change to `claimJobs` needed.

### 2. Prisma migration

Name: `add_syncjob_krs_claimed_txn_v2`
Command: `npx prisma migrate dev --name add_syncjob_krs_claimed_txn_v2`

Confirm the generated SQL contains ONLY:
```sql
ALTER TABLE "SyncJob" ADD COLUMN "krsClaimedTxnNo" TEXT;
ALTER TYPE "SyncJobStatus" ADD VALUE 'NEEDS_RECONCILE';
```

No data backfill, no constraint changes, no other table alterations. Commit the migration file.

**No-live-DB fallback:** Edit schema.prisma → run `npx prisma generate` (regenerates TypeScript client types only, no DDL executed) → hand-write or use `npx prisma migrate diff` to produce the SQL file. type-check and build pass without a live DB; the migration DDL is only applied at deployment.

### 3. `src/lib/krs/writeback.ts`

**3a. Add exported type `KrsWriteOpts` after `KrsWriteResult` ends (after line 72).**

```typescript
/**
 * Options for writeKrsSale. All fields optional. Omitting opts entirely (two-arg call)
 * still burns a fresh SaleInvoiceTrNo anchor in the separate phase-0 committed tx — it
 * just fires no persist callback and does no reuse. Only preClaimedSaleTxnNo skips the
 * burn; omitting onSaleTxnNoBurned means the burned number is never persisted to Postgres
 * (suitable for ad-hoc testing; the dispatcher always supplies it).
 */
export type KrsWriteOpts = {
  /**
   * A SaleInvoiceTrNo already burned (committed in its own phase-0 short tx) by a
   * prior attempt. When supplied, writeKrsSale SKIPS phase 0 (no new burn) and uses
   * this value as SalesInvoiceHdr.TransactionNo in the phase-1 document tx. Must be
   * byte-identical to the value stored in SyncJob.krsClaimedTxnNo. Do NOT supply a
   * new value each retry — that inflates gaps in the internal SaleInvoiceTrNo sequence.
   */
  preClaimedSaleTxnNo?: string;
  /**
   * Called AFTER the phase-0 burn-commit and BEFORE the phase-1 SERIALIZABLE tx opens.
   * No mssql tx is held open during this callback. The dispatcher uses this to persist
   * the burned number to Postgres (SyncJob.krsClaimedTxnNo) so a crash in phase 1 is
   * detectable on reclaim. A throw aborts before any document INSERT is attempted.
   * Also fires on the reuse path (preClaimedSaleTxnNo supplied) with the same value —
   * idempotent re-persist.
   */
  onSaleTxnNoBurned?: (txnNo: string) => Promise<void>;
};
```

**3b. Change `writeKrsSale` signature (line 283) — add optional third param:**

```typescript
export async function writeKrsSale(
  payload: SalePayload,
  config: sql.config,
  opts?: KrsWriteOpts
): Promise<KrsWriteResult>
```

**3c. Restructure `writeKrsSale` body — two-phase design.**

Current code (lines 309-570) uses a single pool + single SERIALIZABLE tx. Replace the pool/tx variable declarations and the section from pool.connect() through the RunningNumber claims and voucher-number derivations with the two-phase structure.

**Replace variable declarations (lines 309-311):**
```typescript
let pool: sql.ConnectionPool | null = null;
let burnTx: sql.Transaction | null = null;   // phase-0 short tx (READ COMMITTED)
let burnCommitted = false;
let tx: sql.Transaction | null = null;        // phase-1 document tx (SERIALIZABLE)
let committed = false;
```

> **AMENDMENT 2 — replace-region fix (build-break guard):** Replace lines **322-345** (NOT 322-338 as in v2). The five `claimRunningNumber` calls are at lines 323, 324, 328, 329, 333. The derived string/voucher-number declarations (`const saleTxnNo = String(saleTxnSeq)` at line 336, `flowTxnNo`/`jnlCode` at 337-338, `saleVoucherNo` at 340-344, `flowVoucherNo` at 345) sit OUTSIDE the 322-338 range. Replacing only through line 338 leaves `saleVoucherNo` and `flowVoucherNo` in place from the original code — when the replacement block also declares them, TypeScript throws TS2451 (duplicate block-scoped const) → `npm run build` fails. Additionally, the original `const saleTxnNo = String(saleTxnSeq)` at line 336 references `saleTxnSeq` (the now-phase-0 invoice claim that is being removed) and MUST be removed as part of this replacement.

**After `await pool.connect()` (currently line 314), replace the original `tx.begin(SERIALIZABLE)` block (lines 316-320) through the last voucher-number derivation (line 345) with this two-phase structure:**

```typescript
    // ── Phase 0: Burn the SaleInvoiceTrNo anchor ──────────────────────────────
    // A SEPARATE, IMMEDIATELY-COMMITTED tx (READ COMMITTED — sufficient for a
    // single-row counter UPDATE). Once committed, the increment is permanent: a later
    // rollback of the phase-1 SERIALIZABLE doc tx cannot revert it.
    //
    // SAFETY SCOPE: the burned anchor disambiguates committed vs rolled-back AT THE
    // INSTANT checkKrsSaleExists runs. It does NOT prevent an alive-but-slow concurrent
    // writer from committing the same TransactionNo after the existence check returns NOT
    // FOUND. The UNIQUE constraint on KRS.SalesInvoiceHdr.TransactionNo (hard pre-enable
    // gate, see Residual §5) is the only server-side protection against that race.
    //
    // REUSE PATH (preClaimedSaleTxnNo supplied): a prior attempt already burned this
    // number. Skip phase 0 and reuse it — do NOT burn a new one (inflates gaps).
    let saleTxnNo: string;
    if (opts?.preClaimedSaleTxnNo != null) {
      saleTxnNo = opts.preClaimedSaleTxnNo;
    } else {
      burnTx = new sql.Transaction(pool);
      await burnTx.begin();   // READ COMMITTED — sufficient for a counter UPDATE
      const saleTxnSeq = await claimRunningNumber(burnTx, cfg.RUNNING_NUMBER_NAME_INVOICE);
      await burnTx.commit();
      burnCommitted = true;
      saleTxnNo = String(saleTxnSeq);
    }

    // ── Phase 0b: Persist the burned anchor to Postgres ───────────────────────
    // Fires AFTER burn-commit, BEFORE the phase-1 SERIALIZABLE tx opens.
    // NO mssql tx is held open during this Postgres write.
    await opts?.onSaleTxnNoBurned?.(saleTxnNo);

    // ── Phase 1: SERIALIZABLE document tx ─────────────────────────────────────
    // Claims the remaining 4 running numbers + all INSERTs in one atomic tx.
    // A rollback releases these 4 in-tx claims (human-facing VoucherNo stays gapless).
    // SaleInvoiceTrNo is NOT claimed here — it came from the burned phase-0 anchor.
    tx = new sql.Transaction(pool);
    await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);

    // ── Step 1: atomic RunningNumber claims (4 in-tx counters only) ───────────
    const saleVoucherSeq = await claimRunningNumber(
      tx,
      `${cfg.RUNNING_NUMBER_VOUCHER_PREFIX}${yymm}`
    );
    const flowTxnSeq  = await claimRunningNumber(tx, cfg.RUNNING_NUMBER_NAME_INVFLOW);
    const flowVoucherSeq = await claimRunningNumber(
      tx,
      `${cfg.INV_VOUCHER_PREFIX}${yymm}`
    );
    const jnlSeq = await claimRunningNumber(tx, cfg.RUNNING_NUMBER_NAME_RECEIPT);

    // saleTxnNo is the burned phase-0 anchor (set above). DO NOT re-declare it here.
    const flowTxnNo    = String(flowTxnSeq);
    const jnlCode      = String(jnlSeq);
    const saleVoucherNo = formatVoucherNo(
      cfg.RUNNING_NUMBER_VOUCHER_PREFIX,
      yymm,
      saleVoucherSeq
    );
    const flowVoucherNo = formatVoucherNo(cfg.INV_VOUCHER_PREFIX, yymm, flowVoucherSeq);
```

All code from Step 2 (MainUnits lookup) through Step 8 (COMMIT and return), currently at lines 347-580, is unchanged. Every reference to `saleTxnNo` in the INSERT statements is satisfied by the phase-0 declaration.

**Update the catch block (lines 581-598) — roll back both transactions:**

```typescript
  } catch (e) {
    // Roll back burn tx only if it started but did not commit (phase-0 failure).
    if (burnTx && !burnCommitted) {
      try { await burnTx.rollback(); } catch { /* secondary */ }
    }
    // Roll back document tx if it started but did not commit (phase-1 failure).
    if (tx && !committed) {
      try { await tx.rollback(); } catch { /* secondary */ }
    }
    if (e instanceof WriteConfigNotReadyError || e instanceof KrsWriteError) throw e;
    const parts = safeErrorParts(e);
    throw new Error(`KRS write failed [${parts.code}]: ${parts.message}`);
  }
```

The `finally` block (lines 599-607, closes `pool`) is unchanged.

**3d. Add `checkKrsSaleExists` — insert after `claimRunningNumber` ends (line 199), before the existing `// ── lookups (read, inside the tx)` banner (line 201).**

Add a new section banner first:

```typescript
// ─── existence check (own pool, NOT in the sale tx — called by dispatcher on reclaim) ──
```

Then the function:

```typescript
/**
 * Read-only existence check: returns true when a SalesInvoiceHdr row with the given
 * TransactionNo is present in KRS AT THE INSTANT THE CHECK RUNS. Called ONLY by the
 * dispatcher on a reclaimed job that holds a non-null krsClaimedTxnNo (a previously
 * burned anchor), to determine whether the phase-1 document tx committed or rolled back.
 *
 * CONCURRENCY NOTE: this is NOT a lock. An alive-but-slow dispatcher A can commit the
 * same TransactionNo AFTER this function returns false (not found). The defense against
 * that race is a UNIQUE constraint on KRS.SalesInvoiceHdr.TransactionNo (owner/DBA
 * action; hard pre-enable gate — see plan Residual §5).
 *
 * Uses a THROWAWAY POOL (open → SELECT → close in finally) on the caller-supplied
 * config — NOT inside any sale tx and NOT sharing the in-tx pool.
 *
 * TransactionNo is bound as NVarChar (@txnNo) — never interpolated. Sargable when
 * SalesInvoiceHdr.TransactionNo is NVarChar (confirm at first sandbox run). A timed-out
 * check (REQUEST_TIMEOUT_MS=20_000, sandboxClient.ts:29) is a SAFE retry — it does not
 * bypass or alter KRS state.
 *
 * Errors are sanitized (never the raw mssql driver object or config).
 * Pure SELECT: this function NEVER modifies KRS state.
 */
export async function checkKrsSaleExists(
  saleTxnNo: string,
  config: sql.config
): Promise<boolean> {
  let pool: sql.ConnectionPool | null = null;
  try {
    pool = new sql.ConnectionPool(config);
    await pool.connect();
    const res = await new sql.Request(pool)
      .input("txnNo", sql.NVarChar, saleTxnNo)
      .query<{ Found: number }>(
        `SELECT TOP 1 1 AS Found FROM dbo.SalesInvoiceHdr WHERE TransactionNo = @txnNo;`
      );
    return res.recordset.length > 0;
  } catch (e) {
    const parts = safeErrorParts(e);
    throw new Error(`KRS existence check failed [${parts.code}]: ${parts.message}`);
  } finally {
    if (pool) {
      try { await pool.close(); } catch { /* secondary — result already determined */ }
    }
  }
}
```

**3e. Update the INVARIANTS comment block (lines 20-44).** Replace the old idempotency caveat (lines 33-44) with:

```
// IDEMPOTENCY (burned-anchor design, krs-writeback-idempotency_PLAN_27-06-26.md v3):
// SaleInvoiceTrNo is claimed in a SEPARATE COMMITTED phase-0 tx before the SERIALIZABLE
// phase-1 document tx opens. A phase-1 rollback cannot revert the phase-0 increment.
// checkKrsSaleExists(burnedNo) disambiguates committed vs rolled-back AT THE INSTANT the
// check runs — it is NOT a lock against a concurrently-alive writer committing the same
// TransactionNo after the check returns NOT FOUND. The UNIQUE constraint on
// KRS.SalesInvoiceHdr.TransactionNo (owner/DBA; hard pre-enable gate) is the ONLY server-
// side mechanism that forces such a late duplicate commit to fail. The dispatcher supplies
// opts.onSaleTxnNoBurned to persist the anchor after phase-0 commit (no mssql tx held).
// VoucherNo (SC-YYMM-NNNN, human/tax-facing) stays in-tx and gapless. SaleInvoiceTrNo
// may have rare gaps on crash paths — acceptable for this internal surrogate.
```

### 4. `src/lib/krs/dispatcher.ts`

**4a. Update import (line 29) — add `checkKrsSaleExists`; add type import for `KrsWriteOpts`:**

```typescript
import { writeKrsSale, WriteConfigNotReadyError, checkKrsSaleExists } from "./writeback";
import type { KrsWriteOpts } from "./writeback";
```

**4b. Update cross-engine invariant header comment (lines 8-11) — add anchor-write sequencing and run-lock notes:**

```typescript
// CROSS-ENGINE SEPARATION (invariant): the SyncJob bookkeeping (claim / status writes)
// goes through the `prisma` singleton; the KRS write goes through the mssql write
// module on the SEPARATE sandbox config. The mssql write is called OUTSIDE any Prisma
// `$transaction` (no mssql call ever enlists in a Prisma tx).
//
// ANCHOR WRITE SEQUENCING (invariant): SyncJob.krsClaimedTxnNo is written to Postgres
// via onSaleTxnNoBurned AFTER the phase-0 burn-commit completes and BEFORE the phase-1
// SERIALIZABLE tx opens. No mssql tx is held open during this Postgres write. See
// KrsWriteOpts in writeback.ts for the full per-phase contract.
//
// DISPATCH RUN-LOCK: runDispatch relies on per-job FOR UPDATE SKIP LOCKED + lockedAt to
// prevent two workers claiming the SAME job. It does NOT have an app-level singleton run-
// lock (unlike runAutoSync, autoSync.ts:116-150). The alive-but-slow double-write risk
// (crash-window 9) is mitigated by the UNIQUE constraint on KRS.SalesInvoiceHdr.
// TransactionNo (pre-enable gate). A batch-level run-lock is recommended defense-in-depth
// (see plan Residual §7).
```

**4c. Extend `findUnique` select (lines 203-211) — add `krsClaimedTxnNo: true`:**

```typescript
      select: {
        id: true,
        idempotencyKey: true,
        payload: true,
        attempts: true,
        ref: true,
        krsClaimedTxnNo: true,   // ← ADD: burned anchor for reclaim detection
      },
```

**4d. Do NOT add `clearClaimedTxnNo`.** The burned anchor must never be cleared on an in-process phase-1 failure. The correct behavior on NOT FOUND is to REUSE the burned number via `preClaimedSaleTxnNo`. There is no scenario in the burned-anchor design where clearing the anchor is correct.

**4e. Insert reclaim existence-check block between PAYLOAD BOUNDARY end (after line 280) and KRS WRITE start (line 282).**

The ENTIRE block must be wrapped in its own per-job try/catch so a Postgres fault on `markSynced` (FOUND path) does not throw out of `runDispatch` (mirrors "NEVER throws for a per-job fault" invariant at dispatcher.ts:178-181):

```typescript
    // === RECLAIM EXISTENCE CHECK ===
    // A prior attempt burned a SaleInvoiceTrNo and persisted it to krsClaimedTxnNo.
    // We must determine whether the phase-1 document tx committed BEFORE re-running
    // writeKrsSale. Calling writeKrsSale without this check risks a double-write.
    //
    // Safety scope: checkKrsSaleExists(burnedNo) disambiguates at the instant it runs.
    // It is NOT a lock. An alive-but-slow concurrent writer can still commit the same
    // TransactionNo after this returns NOT FOUND. Only the KRS UNIQUE constraint on
    // SalesInvoiceHdr.TransactionNo prevents that race at the server side.
    //
    //   FOUND   → markSynced(recovered). Job sealed. Done.
    //   NOT FOUND → fall through to KRS WRITE below with preClaimedSaleTxnNo.
    //   THROWS  → treat as per-job failure (retry or NEEDS_RECONCILE). writeKrsSale
    //             is NOT called on this path.
    if (job.krsClaimedTxnNo != null) {
      try {
        const exists = await checkKrsSaleExists(job.krsClaimedTxnNo, sandboxConfig);
        if (exists) {
          // FOUND: phase-1 committed in a prior attempt. Recover without re-writing.
          await markSynced(
            job.id,
            job.attempts,
            JSON.stringify({ transactionNo: job.krsClaimedTxnNo, recovered: true })
          );
          result.synced += 1;
          logger.info(
            {
              krsDispatch: {
                jobId: job.id,
                ref: job.ref,
                transactionNo: job.krsClaimedTxnNo,
              },
            },
            "KRS dispatch: crash-recovered — prior phase-1 tx found, job marked SYNCED"
          );
          continue;
        }
        // NOT FOUND: phase-1 never committed (or alive-but-slow — UNIQUE constraint is
        // the server-side guard). Fall through to KRS WRITE; writeKrsSale will reuse
        // the burned anchor via preClaimedSaleTxnNo (no new burn).
        logger.info(
          {
            krsDispatch: {
              jobId: job.id,
              ref: job.ref,
              reuseTxnNo: job.krsClaimedTxnNo,
            },
          },
          "KRS dispatch: prior phase-1 tx not found — reusing burned anchor"
        );
      } catch (e) {
        // checkKrsSaleExists OR markSynced (FOUND path) threw. Do NOT call writeKrsSale.
        const sanitized = safeErrMsg(e);
        logger.error(
          {
            krsDispatch: {
              jobId: job.id,
              ref: job.ref,
              code: safeErrCode(e),
              message: sanitized,
            },
          },
          "KRS dispatch: reclaim check failed"
        );
        const newAttempts = job.attempts + 1;
        if (newAttempts >= MAX_ATTEMPTS) {
          // Route to NEEDS_RECONCILE rather than terminal FAILED. A job with a burned
          // anchor but persistently-failing existence check MAY already be in KRS.
          // Terminal FAILED excludes the job from claims forever; an operator re-keying
          // it risks a manual double-write. NEEDS_RECONCILE signals "investigate before
          // re-entry." claimJobs does NOT claim NEEDS_RECONCILE jobs.
          await prisma.syncJob.update({
            where: { id: job.id },
            data: {
              status: SyncJobStatus.NEEDS_RECONCILE,
              lockedAt: null,
              attempts: newAttempts,
              lastError: sanitized,
              error: sanitized,
            },
          });
          logger.error(
            { krsDispatch: { jobId: job.id, ref: job.ref } },
            "KRS dispatch: job reached NEEDS_RECONCILE — manual reconciliation required"
          );
        } else {
          await markFailedOrRetry(job.id, job.attempts, sanitized);
        }
        result.failed += 1;
        continue;
      }
    }
```

**4f. Update the KRS WRITE try/catch block — supply `KrsWriteOpts` to `writeKrsSale` (line 284).**

Change:
```typescript
      const writeResult = await writeKrsSale(payload, sandboxConfig);
```
To:
```typescript
      const opts: KrsWriteOpts = {
        // Reuse the burned anchor on the NOT-FOUND reclaim path; undefined on first-time
        // path (job.krsClaimedTxnNo is null → writeKrsSale runs phase 0 + burns fresh).
        preClaimedSaleTxnNo: job.krsClaimedTxnNo ?? undefined,
        // Persist the burned SaleInvoiceTrNo to Postgres AFTER phase-0 commit and BEFORE
        // the phase-1 SERIALIZABLE tx opens. No mssql tx is held during this Postgres write.
        // Idempotent on reuse path (re-writes the same value already in krsClaimedTxnNo).
        onSaleTxnNoBurned: async (txnNo) => {
          await prisma.syncJob.update({
            where: { id: job.id },
            data: { krsClaimedTxnNo: txnNo },
          });
        },
      };
      const writeResult = await writeKrsSale(payload, sandboxConfig, opts);
```

### 5. `src/lib/krs/index.ts`

**Change line 51 IN PLACE** (do NOT add a second `export type` line — that would cause TS2300/TS2484 duplicate-export errors and fail the verify gate):

FROM (line 51):
```typescript
export type { KrsWriteResult } from "./writeback";
```
TO (line 51, in place):
```typescript
export type { KrsWriteResult, KrsWriteOpts } from "./writeback";
```

**Add `checkKrsSaleExists` to the value export block (lines 46-50) — result:**
```typescript
export {
  writeKrsSale,
  KrsWriteError,
  WriteConfigNotReadyError,
  checkKrsSaleExists,          // ← ADD
} from "./writeback";
export type { KrsWriteResult, KrsWriteOpts } from "./writeback";   // line 51 in-place edit
```

---

## Public Contracts

| Surface | Before | After |
|---|---|---|
| `writeKrsSale` signature | `(payload, config)` | `(payload, config, opts?)` — backward-compatible; two-arg call still burns fresh anchor (phase 0 runs; no persist callback) |
| `KrsWriteOpts` | does not exist | new exported type; `preClaimedSaleTxnNo?` skips burn; `onSaleTxnNoBurned?` persists anchor |
| `checkKrsSaleExists` | does not exist | new exported function; own-pool SELECT; NOT a concurrency lock |
| `SyncJob.krsClaimedTxnNo` | does not exist | nullable `String?` column; Prisma client regenerated |
| `SyncJobStatus.NEEDS_RECONCILE` (Prisma enum) | does not exist | additive Prisma enum value; `claimJobs` does NOT claim it |
| `SyncJobStatus` local union (`src/types/index.ts`) | 5 values | **UNCHANGED — 5 values** (Amendment 3 guard; see §1b) |
| `DispatchResult` type | unchanged | unchanged |
| `runDispatch` runtime behaviour | writes KRS on every re-claim | checks existence on re-claim; reuses burned anchor on NOT FOUND; NEEDS_RECONCILE on persistent check failure |

---

## Blast Radius

**Must NOT regress:**

- **writeback.ts no-prisma invariant (lines 26-29):** `checkKrsSaleExists` imports only `sql` and `safeErrorParts`. `onSaleTxnNoBurned` is a function parameter supplied by the dispatcher; writeback.ts never imports `@/lib/prisma`. Invariant preserved.
- **SERIALIZABLE phase-1 atomicity:** Phase-1 tx is still `ISOLATION_LEVEL.SERIALIZABLE` covering all 4 remaining RunningNumber claims + every INSERT + COMMIT. Phase-0 burn uses READ COMMITTED for a single-row counter.
- **No mssql tx held across Postgres write:** `onSaleTxnNoBurned` fires AFTER `burnTx.commit()` and BEFORE `tx = new sql.Transaction(pool)` — no mssql Transaction object is open during the Postgres write.
- **VoucherNo gapless:** `saleVoucherNo` (SC-YYMM-NNNN), `flowVoucherNo` (OSL-YYMM-NNNN), `flowTxnNo`, and `jnlCode` remain in-tx. Phase-1 rollback releases all four — human-facing and tax-facing numbers stay gapless.
- **SaleInvoiceTrNo gaps acknowledged:** Rare gaps on crash-window 3 (crash after burn-commit before persist). Internal surrogate only; not tax-facing. Flag for owner/vendor confirm at enable time.
- **Checkout enqueue path:** `src/app/api/orders/route.ts` untouched. New SyncJobs enqueued with `krsClaimedTxnNo=null`.
- **Feature flag:** `KRS_OUTBOUND_ENABLED=false` in all environments. Reclaim block is unreachable while the FEATURE-FLAG gate fires first.
- **Fail-open:** `runDispatch` still never throws for a per-job fault. The reclaim block's own try/catch absorbs all per-job faults.
- **No ERP write at build time:** `checkKrsSaleExists` opens no connection at module load.

> **Amendment 3 — LOCAL TYPE ALIAS (build-break guard):** Do NOT add `NEEDS_RECONCILE` to `src/types/index.ts:192-197`. The local `SyncJobStatus` union drives two exhaustive `Record<SyncJobStatus, ...>` maps:
> - `SYNC_JOB_META` at `src/components/data/syncMeta.ts:19`
> - `STATUS_COUNT_KEY` at `src/components/data/SyncActivityTab.tsx:66`
>
> Adding a 6th value to the union without simultaneously adding a matching key to both Record maps causes TS2741 ("Property X is missing in type") → `npm run build` fails. The Prisma enum (6 values after migration) and the UI type alias (5 values) are intentionally decoupled. Do not "keep them in sync" in this pass.

---

## Invariants

The following must be maintained by the implementation and verified in the code-path argument at EXECUTE time:

1. **Burned-anchor irreversibility:** The phase-0 `burnTx.commit()` permanently increments `RunningNumber.Number` for `SaleInvoiceTrNo`. No mechanism within the phase-1 rollback path can revert it. A `SalesInvoiceHdr` row with `TransactionNo == burnedNo` can only have been inserted by a phase-1 commit against that exact burned value.

2. **REQUEST_TIMEOUT_MS is per-request, NOT a transaction wall-time cap.** `REQUEST_TIMEOUT_MS=20_000` (sandboxClient.ts:29) vs `LOCK_STALE_MS=600_000` (dispatcher.ts:39) does NOT make the alive-but-slow double-write impossible. Phase-1 issues approximately 13+2N mssql requests (4 RunningNumber claims, 1 MainUnits lookup, 3 GL resolutions, 1 SalesInvoiceHdr INSERT, N SalesInvoiceDtl INSERTs, 3 TheJournal INSERTs, 1 InventoryFlowHdr INSERT, N InventoryFlowDtl INSERTs). Each request restarts its own 20-second timer. An event-loop pause, GC stall, or slow KRS response on any one request can freeze the Node.js timeout timer while the wall-clock `lockedAt` timestamp advances. Dispatcher A can remain alive and executing phase-1 well past `LOCK_STALE_MS`, allowing B to reclaim the job and enter phase-1 concurrently. Both then commit `TransactionNo=N`. The burned anchor does NOT prevent this race.

3. **Phase-1 is a single SERIALIZABLE tx:** All 4 remaining RunningNumber claims + every INSERT + COMMIT happen in one tx. The `SalesInvoiceHdr` INSERT using the burned `TransactionNo` is the existence-check witness — its absence at check time means phase-1 had not yet committed.

4. **RCSI guarantees post-commit visibility, NOT mutual exclusion.** Under Read Committed Snapshot Isolation (the KRS default per field-analysis), a committed phase-1 row is immediately visible to a subsequent `SELECT` in a separate pool — needed for crash-window 5 recovery. RCSI does NOT provide mutual exclusion against a concurrently-alive writer. `checkKrsSaleExists(burnedNo)` returns a snapshot at the instant it runs; an alive-but-slow dispatcher A can commit `SalesInvoiceHdr.TransactionNo=N` AFTER this function returns false. Confirm at sandbox-test time that RCSI is actually the KRS isolation level.

5. **UNIQUE constraint is the server-side mutual-exclusion gate.** A `UNIQUE` constraint on `KRS.SalesInvoiceHdr.TransactionNo` (and `KRS.InventoryFlowHdr.TransactionNo`) forces any duplicate-TransactionNo INSERT to fail, causing phase-1 to rollback. This is the ONLY mechanism that prevents the alive-but-slow race from producing a double row, double journal entry, and double stock cut. This constraint is a hard owner/DBA/vendor pre-enable requirement — it is NOT built in this code pass and the module is dormant.

6. **NEEDS_RECONCILE is not auto-claimable:** `claimJobs` (dispatcher.ts:84-102) WHERE clause filters `PENDING|RETRYING` only. `NEEDS_RECONCILE` is structurally excluded. Only an operator action (manual status reset to `PENDING`) re-enables a job.

7. **No double-burn on retry:** A reclaim path with `preClaimedSaleTxnNo != null` must NOT trigger phase 0. The `if (opts?.preClaimedSaleTxnNo != null)` guard in `writeKrsSale` enforces this at the source level.

8. **Local alias invariant (Amendment 3):** `src/types/index.ts SyncJobStatus` union remains at 5 values throughout this implementation. The Prisma enum grows to 6; the local alias stays at 5. This decoupling is intentional and must not be collapsed in this pass.

---

## Crash-Point Safety Table

Precondition: `sandboxConfig != null` and `KRS_OUTBOUND_ENABLED=true` (dormant state makes all writes unreachable regardless). "Anchor" = `SyncJob.krsClaimedTxnNo`. "Our row" = `SalesInvoiceHdr` row with `TransactionNo == burnedNo`.

| # | Crash window | Anchor in Postgres | `SalesInvoiceHdr` in KRS | Next dispatch action | Safety analysis |
|---|---|---|---|---|---|
| **1** | Before phase-0 burn tx starts | NULL | Absent | null check → fresh `writeKrsSale` (burns new number) | No KRS row, no anchor. Clean first-time retry. |
| **2** | During phase-0 burn tx, before `burnTx.commit()` | NULL | Absent | null check → fresh `writeKrsSale` (burns new number) | In-tx `UPDATE RunningNumber` rolled back by `burnTx.rollback()`. No gap — rollback releases the value. |
| **3** | After `burnTx.commit()`, before `onSaleTxnNoBurned` Postgres write commits | NULL (Postgres write never reached) | Absent (phase-1 not yet started) | null check → fresh `writeKrsSale` → burns a NEW number | Old burned number becomes a gap in `SaleInvoiceTrNo` (acceptable — internal surrogate; VoucherNo still gapless in-tx). |
| **4** | After `onSaleTxnNoBurned` commit, before phase-1 `tx.commit()` | SET | Absent (clean crash: phase-1 rolled back or never reached commit) | non-null → `checkKrsSaleExists` → NOT FOUND → fall through to `writeKrsSale` with `preClaimedSaleTxnNo` | For a clean crash (A is dead): NOT FOUND is unambiguous. Reuse burned number in fresh phase-1. For the alive-but-slow variant, see window 9. |
| **5** | After phase-1 `tx.commit()` (writeback.ts:570), before Postgres `markSynced` (dispatcher.ts:287) | SET | COMMITTED (our row) | non-null → `checkKrsSaleExists` → FOUND → `markSynced({ transactionNo, recovered: true })` → SYNCED | FOUND at that instant means our row is present. `writeKrsSale` never called. Job sealed SYNCED. |
| **6** | `markSynced` completes (status=SYNCED, lockedAt=null) | SET | COMMITTED | `claimJobs` filters PENDING/RETRYING — SYNCED excluded | Job is inert. `idempotencyKey` dedup is secondary backstop. |
| **7** | `checkKrsSaleExists` OR `markSynced` (FOUND path) throws transiently | SET | Unknown | reclaim catch → `markFailedOrRetry` (retry) OR `NEEDS_RECONCILE` at `MAX_ATTEMPTS` | `writeKrsSale` NOT called. Safe retry. NEEDS_RECONCILE at limit routes to operator review. |
| **8** | Concurrent second dispatcher races for same job | Depends on which holds lock | Depends | `FOR UPDATE SKIP LOCKED` (dispatcher.ts:97) prevents dual claim of the same job row | Only one dispatcher holds the RETRYING lock for a given job at a time. |
| **9** | **Alive-but-slow: A holds lock, `LOCK_STALE_MS` expires, B claims job; A is still alive in phase-1** | SET (if A persisted before stalling) | A has NOT committed yet at the instant B checks | B: non-null → `checkKrsSaleExists` → **NOT FOUND** → enters phase-1 with `preClaimedSaleTxnNo`. Then A commits. | **POSSIBLE DOUBLE-WRITE.** The burned anchor does NOT prevent this — it disambiguated only at the instant B's check ran. Both A and B hold `TransactionNo=N`; the later commit produces a duplicate `SalesInvoiceHdr`, duplicate `TheJournal`, and duplicate `InventoryFlow` stock cut. **The UNIQUE constraint on `KRS.SalesInvoiceHdr.TransactionNo` is the ONLY mechanism that forces A's or B's duplicate INSERT to fail.** Without it, this race silently produces a double ERP write. This scenario does not affect the dormant build-only merge; the UNIQUE constraint is a hard pre-enable gate (Residual §5). |

**Note on windows 2 vs 3:** In-tx RunningNumber rollback RELEASES the value (window 2 = no gap). Burned-anchor rollback does NOT release the value (window 3 = gap). This asymmetry is WHY the burned anchor is applied only to `SaleInvoiceTrNo` (the existence-check key); the other 4 counters remain in-tx to preserve gapless human-facing voucher numbers.

---

## Implementation Checklist

Steps are ordered for safe execution. Steps 1-3 (schema + migration) must precede all source edits referencing `krsClaimedTxnNo` or `SyncJobStatus.NEEDS_RECONCILE`. Steps 19-20 (verify) must be last.

1. **`prisma/schema.prisma` — SyncJob model:** Add `krsClaimedTxnNo  String?` after `lockedAt DateTime?` (line 73). Update comment block to note burned-anchor purpose.

2. **`prisma/schema.prisma` — SyncJobStatus Prisma enum:** Add `NEEDS_RECONCILE` to the Prisma enum body (lines 101-107). Add inline comment that it is not auto-claimable. Do NOT touch `src/types/index.ts` (Amendment 3 guard — see §1b and Blast Radius).

3. **Prisma migration:** Run `npx prisma migrate dev --name add_syncjob_krs_claimed_txn_v2`. Confirm generated SQL is ONLY the two additive statements. Commit migration file. If no live DB: run `npx prisma generate` only; hand-write migration SQL for deployment.

4. **`src/lib/krs/writeback.ts` — add `KrsWriteOpts` type:** After `KrsWriteResult` ends (after line 72), insert the exported `KrsWriteOpts` type with the clarified JSDoc as in §3a.

5. **`src/lib/krs/writeback.ts` — extend `writeKrsSale` signature:** Add `opts?: KrsWriteOpts` as the third parameter at line 283.

6. **`src/lib/krs/writeback.ts` — update variable declarations:** Replace the declaration block (around lines 309-311) with the five-variable set: `pool`, `burnTx`, `burnCommitted`, `tx`, `committed`.

7. **`src/lib/krs/writeback.ts` — insert phase-0 burn block + phase-0b callback:** After `await pool.connect()`, insert the `if/else` block (reuse vs burn) and the `await opts?.onSaleTxnNoBurned?.(saleTxnNo)` call as in §3c.

8. **`src/lib/krs/writeback.ts` — insert phase-1 SERIALIZABLE tx open:** Immediately after phase-0b, add `tx = new sql.Transaction(pool)` + `await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE)`.

9. **`src/lib/krs/writeback.ts` — replace lines 322-345 (NOT 322-338):** Remove ALL five original `claimRunningNumber` calls (lines 323, 324, 328, 329, 333) AND the derived-value declarations at lines 336-345 — specifically including the stale `const saleTxnNo = String(saleTxnSeq)` at line 336 (references `saleTxnSeq` which no longer exists). Replace with the 4 in-tx claims (`saleVoucherSeq`, `flowTxnSeq`, `flowVoucherSeq`, `jnlSeq`) and their string/voucher derivations. `saleTxnNo` is declared in phase-0 (step 7) — do NOT re-declare it in this block.

10. **`src/lib/krs/writeback.ts` — update catch block:** Add `if (burnTx && !burnCommitted) { try { await burnTx.rollback(); } catch {} }` before the existing `if (tx && !committed)` rollback.

11. **`src/lib/krs/writeback.ts` — add existence-check banner + `checkKrsSaleExists`:** After `claimRunningNumber` ends (line 199) and before the existing `// ─── lookups` banner (line 201), insert the new section banner and the `checkKrsSaleExists` function with concurrency note in JSDoc as in §3d.

12. **`src/lib/krs/writeback.ts` — update INVARIANTS comment block:** Replace old idempotency caveat (lines 33-44) with the updated note acknowledging the alive-but-slow race and UNIQUE constraint gate as in §3e.

13. **`src/lib/krs/dispatcher.ts` — update import (line 29):** Add `checkKrsSaleExists` to the destructured import from `"./writeback"`. Add `import type { KrsWriteOpts } from "./writeback"` on a separate line.

14. **`src/lib/krs/dispatcher.ts` — update header comment (lines 8-11):** Add `ANCHOR WRITE SEQUENCING` and `DISPATCH RUN-LOCK` paragraphs as in §4b.

15. **`src/lib/krs/dispatcher.ts` — add `krsClaimedTxnNo: true` to `findUnique` select (lines 203-211).**

16. **`src/lib/krs/dispatcher.ts` — insert reclaim existence-check block (between lines 280 and 282):** The full `if (job.krsClaimedTxnNo != null)` block with its own try/catch, three branches (FOUND/NOT FOUND/THROWS with NEEDS_RECONCILE at MAX_ATTEMPTS), and log calls as in §4e.

17. **`src/lib/krs/dispatcher.ts` — update `writeKrsSale` call (line 284):** Supply `opts` object with `preClaimedSaleTxnNo` and `onSaleTxnNoBurned` callback as in §4f.

18. **`src/lib/krs/index.ts` — update exports:** Add `checkKrsSaleExists` to value export block (lines 46-50). Change line 51 IN PLACE to add `KrsWriteOpts` to the type export. No second `export type` line.

19. **`npm run type-check`** — Must exit 0 with zero TypeScript errors. Confirm no TS2741 errors in `syncMeta.ts` or `SyncActivityTab.tsx` (local `SyncJobStatus` union was NOT updated — correct). Confirm `krsClaimedTxnNo` and `SyncJobStatus.NEEDS_RECONCILE` are recognised by the Prisma client.

20. **`npm run build`** — Must exit 0. Confirm no TS2451 duplicate-const errors from writeback.ts (replace-region was 322-345 — validates that `saleVoucherNo`/`flowVoucherNo` are not declared twice).

---

## Verification Evidence

**Static (required — both must pass before DONE):**
- `npm run type-check` exits 0 with zero TypeScript errors
- `npm run build` exits 0 (Next.js build clean)

**Code-path argument (document in PR):**

1. **Burned anchor is irreversible (clean crash paths):** `burnTx.commit()` permanently increments `SaleInvoiceTrNo`. Phase-1's `tx.rollback()` cannot revert it. For a clean crash, FOUND is unambiguous; NOT FOUND is unambiguous.

2. **Alive-but-slow double-write risk is documented, not eliminated:** The burned anchor does NOT prevent dispatcher A from committing after B checks NOT FOUND and re-enters phase-1. Only the KRS UNIQUE constraint on `SalesInvoiceHdr.TransactionNo` provides server-side mutual exclusion. This is a pre-enable gate, not a code invariant.

3. **Phase-0b fires outside any mssql tx:** `await opts?.onSaleTxnNoBurned?.(saleTxnNo)` is called after `burnCommitted = true` and before `tx = new sql.Transaction(pool)`. No mssql Transaction object is open at that point.

4. **Per-job try/catch wraps the entire reclaim block:** A Postgres fault on `markSynced` (FOUND path) is caught; the catch routes to `markFailedOrRetry` or `NEEDS_RECONCILE`. `runDispatch` never throws for this per-job fault (invariant at dispatcher.ts:178-181 preserved).

5. **NEEDS_RECONCILE not auto-claimable; not in UI alias:** `claimJobs` WHERE clause filters `PENDING|RETRYING`. `src/types/index.ts SyncJobStatus` union stays at 5 values — confirm type-check produces no TS2741 in Record maps.

6. **No duplicate `const` declarations:** Replace-region in step 9 covers lines 322-345 entirely. `saleTxnNo` is declared only in phase-0 (step 7). Confirm `npm run build` exits 0 with no TS2451.

7. **writeback.ts no-prisma invariant:** `checkKrsSaleExists` uses only `sql` and `safeErrorParts`. `onSaleTxnNoBurned` is a function parameter; writeback.ts never imports `@/lib/prisma`.

8. **Existing `idempotencyKey` dedup unchanged:** The SKIPPED dedup (dispatcher.ts:223-237) still catches re-queued duplicate jobs. The reclaim check covers the same-job crash-window — complementary, non-overlapping.

**Runtime test (out-of-scope — deferred):** Live sandbox smoke test requires explicit user consent + `KRS_SANDBOX_*` creds.

**Pricing-tester:** NOT needed — `src/app/api/orders/route.ts` is untouched.

---

## Residual / Out-of-Scope (explicitly deferred)

1. **STOCK_REVERSAL / refund-void idempotency** — The same crash-window gap exists for refund/void jobs. Out of scope for this P0 pass.

2. **Family-1 Remarks anchor** — If the vendor adds `Remarks` to the confirmed `SalesInvoiceHdr` insert column set, a `SELECT ... WHERE Remarks = orderNumber` can replace `checkKrsSaleExists`. The burned-anchor design is forward-compatible.

3. **Full doc-number recovery on crash-window 5** — The `markSynced` response for a crash-recovery is `{ transactionNo, recovered: true }`. The other doc numbers committed to KRS but were never stored in Postgres. Acceptable for P0.

4. **Sandbox write smoke test** — Gated on explicit owner consent + configured `KRS_SANDBOX_*` creds. Module is dormant; no test at CI/build time.

5. **`KRS_OUTBOUND_ENABLED` flag-on enablement — HARD PRE-ENABLE GATE:** Before `KRS_OUTBOUND_ENABLED` is ever set `true`, the following MUST be completed (owner/DBA/vendor action — not built in this code pass):
   - **UNIQUE constraint on `KRS.dbo.SalesInvoiceHdr(TransactionNo)`** — the only server-side mechanism that forces a duplicate-TransactionNo INSERT (alive-but-slow race, crash-window 9) to fail with a constraint error and rollback instead of silently inserting a double row, double journal, and double stock cut.
   - **UNIQUE constraint on `KRS.dbo.InventoryFlowHdr(TransactionNo)`** — same rationale for the inventory-flow side of the double-write.
   - Confirm `SalesInvoiceHdr.TransactionNo` column is `NVARCHAR` (existence check type safety; sargable WHERE `@txnNo` bound as `sql.NVarChar`).
   - Acknowledge `SaleInvoiceTrNo` may have rare gaps (internal surrogate; VoucherNo gapless).
   - Confirm KRS isolation level is RCSI (or adjust expectation for lock-based READ COMMITTED).

6. **`NEEDS_RECONCILE` UI surface** — A `NEEDS_RECONCILE` SyncJob currently renders as `"ไม่ทราบ / Unknown"` (the `syncJobMeta` fallback at syncMeta.ts:35-37) and is silently dropped from KPI counts (`STATUS_COUNT_KEY` at SyncActivityTab.tsx:66 has no `needsReconcile` key; `EMPTY_COUNTS SyncCountsDTO` has no such field). Goal #5 ("operator must investigate") is not yet surfaced in the UI. A separate UI change must update `SYNC_JOB_META`, `STATUS_COUNT_KEY`, `STATUS_ORDER`, `EMPTY_COUNTS`, and `SyncCountsDTO` together — and the local `SyncJobStatus` alias in `src/types/index.ts` must be updated at the same time to avoid TS2741. Acceptable to defer (module dormant; no `NEEDS_RECONCILE` jobs are created while the flag is off).

7. **Dispatch batch run-lock (defense-in-depth, recommended):** `runDispatch` relies only on per-job `FOR UPDATE SKIP LOCKED` + `lockedAt` to prevent concurrent processing of the same job. It does NOT have an app-level singleton run-lock like `runAutoSync` (`autoSync.ts:116-150`). The alive-but-slow double-write risk (crash-window 9) is mitigated by the UNIQUE constraint (Residual §5), but an app-level batch run-lock that prevents two concurrent `runDispatch` invocations from simultaneously processing any jobs is additional defense-in-depth. Recommended as a follow-up; not built in this pass.

8. **Phase-1 wall-time cap (defense-in-depth, recommended):** An explicit wall-clock timeout that aborts and rolls back phase-1 if it exceeds a cap well below `LOCK_STALE_MS` would further bound the alive-but-slow window. Not built in this pass.

---

## Dependencies and Risks

| Item | Risk | Mitigation |
|---|---|---|
| Prisma migration is additive-only | LOW — nullable column + new enum value; no backfill | Confirm generated SQL has exactly the two additive DDL statements |
| Phase-0 uses READ COMMITTED | LOW — single-row counter UPDATE is safe at READ COMMITTED; SERIALIZABLE would acquire excessive locks | Intentional; phase-1 SERIALIZABLE provides the full document guarantee |
| One pool reused across both phases | LOW — `burnTx` commits and releases its connection before `tx` begins; sequential on same pool | No resource contention; pool has up to `POOL_MAX=4` connections |
| `SalesInvoiceHdr.TransactionNo` is NVarChar | ASSUMED — matches writeback.ts:363 binding; verify DDL at first sandbox run | `@txnNo` bound as `sql.NVarChar`; timed-out SELECT is a safe retry |
| `checkKrsSaleExists` requires live KRS at call time | LOW at code level — flag + sandbox gate prevent execution while dormant | Sanitized error + retry path; existence check has no side effects |
| **Alive-but-slow concurrent double-write (crash-window 9)** | **HIGH if enabled without UNIQUE constraint** — two dispatchers can each hold the same burned `TransactionNo` and both commit → double `SalesInvoiceHdr`, double `TheJournal`, double stock cut | **Hard pre-enable gate:** UNIQUE constraint on `KRS.SalesInvoiceHdr(TransactionNo)` and `KRS.InventoryFlowHdr(TransactionNo)` required before enabling. Defense-in-depth: batch run-lock (Residual §7) + phase-1 wall-cap (Residual §8). Risk is dormant-gated; does not affect this build-only merge. |
| `NEEDS_RECONCILE` not in local UI alias | LOW — intentional decoupling; existing Record maps unaffected | Do NOT add to `src/types/index.ts` in this pass (Amendment 3 guard) |
| TS2451 duplicate-const if replace-region is too narrow (Amendment 2) | **HIGH if wrong** — replacing only through line 338 leaves `saleVoucherNo`/`flowVoucherNo` from original code; replacement block re-declares them → TS2451 → build fails | Replace-region is explicitly "lines 322-345"; step 9 names both the narrow-range trap and the line-336 `saleTxnNo` removal requirement |
| `SaleInvoiceTrNo` gaps on crash-window 3 | ACKNOWLEDGED — internal surrogate; not tax-facing | Documented; flagged for owner confirm at enable time |

---

## Resume and Execution Handoff

**Plan path (single file):** `process/features/krs-sync/active/krs-writeback-idempotency_PLAN_27-06-26.md`

**Execute with:**
```
ENTER EXECUTE MODE
Plan: process/features/krs-sync/active/krs-writeback-idempotency_PLAN_27-06-26.md
```

**Execution order is fixed:** Steps 1-3 (schema + migration) must precede all source edits. Steps 4-18 (source edits) may proceed in any order among themselves. Steps 19-20 (verify) must be last. Step 19 must confirm no TS2741 in syncMeta.ts/SyncActivityTab.tsx (local union NOT updated — correct). Step 20 must confirm no TS2451 from writeback.ts (replace-region 322-345 — correct).

**Primary edit targets for execute agent:**
- `src/lib/krs/writeback.ts` — 5 change sites: `KrsWriteOpts` type; `writeKrsSale` signature; variable declarations + phase-0/0b/1 restructure (replace lines 322-345, include removal of line-336 `const saleTxnNo`); catch block; `checkKrsSaleExists` + banner; INVARIANTS comment
- `src/lib/krs/dispatcher.ts` — 5 change sites: import; header comment; `findUnique` select; reclaim block; `writeKrsSale` call with opts
- `prisma/schema.prisma` — 2 changes: SyncJob model field; SyncJobStatus Prisma enum (NOT `src/types/index.ts`)
- `src/lib/krs/index.ts` — 2 in-place edits: `checkKrsSaleExists` in value block; `KrsWriteOpts` in type export line 51

**Verify gate:** Both `npm run type-check` AND `npm run build` must exit 0. If either fails, do not mark DONE.

**After EXECUTE completes:** Archive this plan to `process/features/krs-sync/completed/` via UPDATE PROCESS mode. Update `process/memory/krs-sync-program-state.md` to note P0 idempotency gap CLOSED with burned-anchor design (v3, code-only; runtime validation pending; UNIQUE constraint gate documented as hard pre-enable requirement).

// NODE-ONLY. KRS outbound dispatcher (krs-sync P2). Drains the SyncJob outbox: it
// ATOMICALLY claims pending SALE jobs, dedups by idempotencyKey, calls the KRS write
// module (Track-A stub for now), and applies retry/backoff/terminal-FAILED. Imported
// only by the dispatch route (POST /api/krs/dispatch). NEVER import from a client
// component, `src/auth.config.ts`, or `src/middleware.ts` (it transitively pulls in
// the `mssql` driver via the write module).
//
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
//
// FAIL-OPEN (invariant): a KRS/dispatch failure NEVER touches checkout — this module
// only runs from the dispatch endpoint, well after the sale committed. A write failure
// just updates the SyncJob (retry/backoff/FAILED); the sale is untouched.
//
// IDEMPOTENT (invariant): the atomic claim (FOR UPDATE SKIP LOCKED) guarantees a job
// is claimed by exactly one worker; the dedup check skips a job whose idempotencyKey
// already has a SYNCED row, so a re-queued/duplicate job never double-writes.
//
// Plan: process/features/krs-sync/active/krs-outbound-writeback_PLAN_25-06-26.md §8

import { Prisma, SyncJobStatus, SyncJobType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { buildSandboxConfig } from "./sandboxClient";
import { parseSalePayload, salePayloadHasDiscount } from "./salePayload";
import { writeKrsSale, WriteConfigNotReadyError, checkKrsSaleExists } from "./writeback";
import type { KrsWriteOpts } from "./writeback";

/** Jobs claimed per dispatch call. */
const BATCH_SIZE = 10;
/** Terminal FAILED after this many attempts. */
const MAX_ATTEMPTS = 5;
/** Backoff base (30s) and cap (1h): nextAttemptAt = now + min(BASE*2^attempts, MAX). */
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 3_600_000;
/** A lock older than this is stale (a crashed prior dispatch) and is re-claimable. */
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

/** The structured result of one dispatch run (returned to the endpoint). */
export type DispatchResult = {
  /** Jobs atomically claimed this run. */
  claimed: number;
  /** Jobs written to KRS successfully (SYNCED). */
  synced: number;
  /** Jobs that failed the write this run (retry-scheduled or terminal FAILED). */
  failed: number;
  /** Jobs skipped (already SYNCED dedup) OR left pending (feature off / not configured
   *  / write not implemented). Skipped jobs are never double-written. */
  skipped: number;
};

/** A sanitized error message — never the raw mssql driver object/config (which can
 *  embed the password). Mirrors client.ts / autoSync.ts sanitization. */
function safeErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}

/** A short error code for the log line (never an ERP value / secret). */
function safeErrCode(e: unknown): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    return String((e as { code?: unknown }).code ?? "UNKNOWN");
  }
  if (e instanceof Error) return e.name;
  return "UNKNOWN";
}

/**
 * Atomically claim up to BATCH_SIZE eligible jobs. "Eligible" = PENDING/RETRYING +
 * lock free or stale + retry-gate passed. The inner SELECT ... FOR UPDATE SKIP LOCKED
 * makes two concurrent dispatch runs claim DISJOINT row sets (no double-claim); the
 * outer UPDATE flips them to RETRYING and stamps lockedAt. RETURNING gives the claimed
 * ids only. One atomic statement under READ COMMITTED — no TOCTOU window.
 *
 * `staleBefore` is computed in JS and bound as a parameter (single-instance deploy;
 * the 10-minute window absorbs any app/DB clock drift), mirroring autoSync's lock.
 */
async function claimJobs(): Promise<string[]> {
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const now = new Date();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "SyncJob"
       SET "lockedAt" = NOW(),
           "status"   = ${SyncJobStatus.RETRYING}::"SyncJobStatus",
           "updatedAt" = NOW()
     WHERE id IN (
       SELECT id FROM "SyncJob"
        WHERE "type" = ${SyncJobType.SALE}::"SyncJobType"
          AND "status" IN (${SyncJobStatus.PENDING}::"SyncJobStatus", ${SyncJobStatus.RETRYING}::"SyncJobStatus")
          AND ("lockedAt" IS NULL OR "lockedAt" < ${staleBefore})
          AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= ${now})
        ORDER BY "createdAt" ASC
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id
  `;
  return rows.map((r) => r.id);
}

/** Re-queue a claimed job WITHOUT counting an attempt (feature off / not configured /
 *  write not implemented). Clears the lock and resets status to PENDING so the next
 *  dispatch re-evaluates it. Used for the "leave pending" outcomes. */
async function requeuePending(jobId: string): Promise<void> {
  await prisma.syncJob.update({
    where: { id: jobId },
    data: { status: SyncJobStatus.PENDING, lockedAt: null },
  });
}

/** How long a DISCOUNT_HELD bill steps aside before being re-checked. Held bills MUST
 *  NOT stay immediately eligible: the claim query is `ORDER BY createdAt ASC LIMIT 10`,
 *  so instantly-requeued held bills monopolize every batch and STARVE the clean bills
 *  behind them (16-07-26 incident: zero-discount sales never reached KRS because the
 *  10 oldest held bills were re-claimed on every run). 5 min keeps the queue flowing
 *  while the flag is off and bounds the post-flag-flip drain lag to ≤5 min. */
const DISCOUNT_HOLD_RECHECK_MS = 5 * 60_000;

/** Re-queue a DISCOUNT_HELD job attempt-free but with a recheck delay so it cannot
 *  block the head of the claim queue (see DISCOUNT_HOLD_RECHECK_MS). */
async function requeueHeld(jobId: string): Promise<void> {
  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status: SyncJobStatus.PENDING,
      lockedAt: null,
      nextAttemptAt: new Date(Date.now() + DISCOUNT_HOLD_RECHECK_MS),
    },
  });
}

/** One sale line reduced to the two fields the snapshot-advance needs: the snapshot key
 *  (= POS sku = KRS ItemCode = SalePayloadItem.itemCode bound to InventoryFlowDtl.ItemCode)
 *  and the positive integer quantity that the write-back cut from KRS on-hand. */
type SnapshotAdvanceLine = { itemCode: string; qty: number };

/**
 * Advance BOTH the PER-WAREHOUSE KrsStockSnapshot row AND the GLOBAL sentinel row
 * (warehouseCode = "") for each line, in `direction`, to reflect this sale's KRS
 * stock-cut. This "burns" the write-back's on-hand drop into the SAME baseline the
 * realtime reconcile engine reads.
 *
 * WHY BOTH ROWS (the fix): stockReconcile.ts STEP 7 computes its per-item delta from the
 * PER-WAREHOUSE snapshot row only (`prior = lastQty` keyed `${itemCode}\u0000${warehouseCode}`,
 * stockReconcile.ts:350-370) — the global sentinel is legacy/global-pass display. Before
 * this fix only the sentinel was decremented, so the next ≤60s reconcile sweep saw the
 * KRS-side cut as a brand-new negative delta on the PER-WAREHOUSE row and re-applied it on
 * top of a Product.stock that checkout ALREADY decremented, DOUBLE-COUNTING it (the shop's
 * "ERP 339 vs POS 338"; backlog outbound-production-gaps_TODO_27-06-26.md §9). Decrementing
 * the per-warehouse row too makes that sweep compute delta = 0 for the cut.
 *
 * `direction` is "decrement" for a SALE cut. (An "increment" — a KRS-side restore — is
 * reserved for a future cancel/void path; no caller passes it today.)
 *
 * An item with no existing snapshot row for a key (count === 0) is logged and SKIPPED for
 * THAT key — it NEVER creates a 0 row, because a fabricated 0 baseline would make the next
 * reconcile treat the full KRS on-hand as a fresh delta in the wrong direction (bootstrap
 * self-squares once the first reconcile sweep writes the real baseline).
 *
 * Runs INSIDE the caller's Prisma `$transaction(tx)` so the SYNCED flip and the snapshot
 * delta commit atomically together (the exactly-once guard lives on the SyncJob row).
 */
async function applySnapshotDelta(
  tx: Prisma.TransactionClient,
  lines: SnapshotAdvanceLine[],
  warehouseCode: string,
  direction: "decrement" | "increment"
): Promise<void> {
  for (const line of lines) {
    const delta =
      direction === "decrement"
        ? { decrement: line.qty }
        : { increment: line.qty };
    // GLOBAL sentinel row (warehouseCode = "") — legacy/global-pass baseline; kept in sync.
    const globalRes = await tx.krsStockSnapshot.updateMany({
      where: { itemCode: line.itemCode, warehouseCode: "" },
      data: { lastQty: delta },
    });
    if (globalRes.count === 0) {
      logger.warn(
        { krsDispatch: { itemCode: line.itemCode, key: "global" } },
        "KRS dispatch: snapshot-advance skipped — item not baselined in global snapshot (no 0 row created)"
      );
    }
    // PER-WAREHOUSE row — the one stockReconcile.ts STEP 7 actually reads for its delta.
    const whRes = await tx.krsStockSnapshot.updateMany({
      where: { itemCode: line.itemCode, warehouseCode },
      data: { lastQty: delta },
    });
    if (whRes.count === 0) {
      logger.warn(
        { krsDispatch: { itemCode: line.itemCode, key: "warehouse", warehouseCode } },
        "KRS dispatch: snapshot-advance skipped — item not baselined in per-warehouse snapshot (no 0 row created)"
      );
    }
  }
}

/**
 * Mark a job SYNCED after a successful KRS write AND apply the stock-snapshot delta
 * (per-warehouse + global) EXACTLY ONCE for this sale's lines. Clears the lock, records
 * the KRS document numbers in `response`, and bumps `attempts` (the succeeding attempt).
 *
 * EXACTLY-ONCE: the mssql document write already committed (the two engines cannot share
 * a tx), so the snapshot delta must not double-apply across retries / burned-anchor
 * reclaims. The conditional `updateMany({ where: { snapshotAdvancedAt: null } })` is the
 * boundary: only the FIRST attempt to reach SYNCED flips snapshotAdvancedAt and runs the
 * delta, both in the SAME pg tx. A later attempt finds count===0 and re-asserts the
 * SYNCED bookkeeping WITHOUT touching the snapshot or the advance timestamp. The SYNCED
 * fields (status, lockedAt, attempts, response, lastError) match the prior markSynced exactly.
 *
 * `warehouseCode` = the sale's cut warehouse (SalePayload.warehouseCode, already defaulted
 * to the HQ warehouse by parseSalePayload). `direction` = "decrement" for a SALE.
 */
async function markSyncedAndAdvance(
  jobId: string,
  currentAttempts: number,
  response: string,
  lines: SnapshotAdvanceLine[],
  warehouseCode: string,
  direction: "decrement" | "increment"
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
      // First time this job reaches SYNCED → apply the snapshot delta once (per-warehouse + global).
      await applySnapshotDelta(tx, lines, warehouseCode, direction);
    } else {
      // A prior attempt already advanced the snapshot (snapshotAdvancedAt set). Ensure the
      // SYNCED bookkeeping WITHOUT re-advancing the snapshot or re-stamping the timestamp.
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
  });
}

/** Mark a job SKIPPED (idempotent dedup: an existing SYNCED row already wrote it).
 *  Clears the lock; no KRS write occurred. */
async function markSkipped(jobId: string): Promise<void> {
  await prisma.syncJob.update({
    where: { id: jobId },
    data: { status: SyncJobStatus.SKIPPED, lockedAt: null },
  });
}

/** Apply retry/backoff after a transient write FAILURE. Bumps attempts; schedules
 *  nextAttemptAt with exponential backoff while under MAX_ATTEMPTS, else marks the job
 *  terminal FAILED. Always clears the lock. `lastError` is the SANITIZED message. */
async function markFailedOrRetry(
  jobId: string,
  currentAttempts: number,
  sanitizedError: string
): Promise<{ terminal: boolean }> {
  const attempts = currentAttempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await prisma.syncJob.update({
      where: { id: jobId },
      data: {
        status: SyncJobStatus.FAILED,
        lockedAt: null,
        attempts,
        lastError: sanitizedError,
        error: sanitizedError,
      },
    });
    return { terminal: true };
  }
  const delayMs = Math.min(BASE_DELAY_MS * 2 ** attempts, MAX_DELAY_MS);
  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status: SyncJobStatus.PENDING,
      lockedAt: null,
      attempts,
      lastError: sanitizedError,
      nextAttemptAt: new Date(Date.now() + delayMs),
    },
  });
  return { terminal: false };
}

/**
 * Run one dispatch pass. Returns a structured tally. NEVER throws for a per-job fault
 * (each job is handled independently); a top-level throw is only possible for a claim-
 * query DB failure, which the endpoint catches and sanitizes.
 *
 * Per-job state machine (plan §8.2):
 *   claimed → dedup check → feature-flag / sandbox / write-config gates →
 *   writeKrsSale → SYNCED (success) | retry/FAILED (transient throw) |
 *   left PENDING (not implemented / not configured / feature off).
 */
export async function runDispatch(): Promise<DispatchResult> {
  const result: DispatchResult = { claimed: 0, synced: 0, failed: 0, skipped: 0 };

  const claimedIds = await claimJobs();
  result.claimed = claimedIds.length;
  if (claimedIds.length === 0) return result;

  // Resolve the runtime gates ONCE per dispatch (they don't change mid-run):
  //  - feature flag (the write is opt-in)
  //  - sandbox config (the write target; null = not configured)
  const outboundEnabled = env.KRS_OUTBOUND_ENABLED === "true";
  const sandboxConfig = buildSandboxConfig();

  for (const jobId of claimedIds) {
    // Read the claimed job's data (we hold the lock via status=RETRYING + lockedAt).
    const job = await prisma.syncJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        idempotencyKey: true,
        payload: true,
        attempts: true,
        ref: true,
        krsClaimedTxnNo: true,   // ← ADD: burned anchor for reclaim detection
      },
    });
    if (!job) {
      // Vanished between claim and read (should not happen) — nothing to do.
      result.skipped += 1;
      continue;
    }

    // === DEDUP CHECK ===
    // If another SyncJob with the same idempotencyKey is already SYNCED, this job is a
    // duplicate (re-queued / replayed) — mark SKIPPED, never double-write. A null key
    // can't dedup (the enqueue guarantees a non-null key, so this is defensive).
    if (job.idempotencyKey) {
      const alreadySynced = await prisma.syncJob.findFirst({
        where: {
          idempotencyKey: job.idempotencyKey,
          status: SyncJobStatus.SYNCED,
          id: { not: job.id },
        },
        select: { id: true },
      });
      if (alreadySynced) {
        await markSkipped(job.id);
        result.skipped += 1;
        continue;
      }
    }

    // === FEATURE-FLAG GATE ===
    // Outbound disabled → re-queue WITHOUT counting an attempt (jobs accumulate and
    // drain once enabled). The write is gated here, not at enqueue.
    if (!outboundEnabled) {
      await requeuePending(job.id);
      result.skipped += 1;
      continue;
    }

    // === SANDBOX GATE ===
    // No sandbox connection configured → re-queue WITHOUT counting an attempt (a
    // configuration gap, not a data error). The write target is intentionally the
    // separate sandbox, never prod.
    if (!sandboxConfig) {
      await requeuePending(job.id);
      result.skipped += 1;
      continue;
    }

    // === PAYLOAD BOUNDARY ===
    // Validate the snapshot at the input boundary. A malformed/legacy payload is a
    // permanent data problem → retry/FAILED (not "leave pending"), so it eventually
    // surfaces as a terminal FAILED instead of looping forever.
    let payload;
    try {
      payload = parseSalePayload(job.payload);
    } catch (e) {
      const msg = `Invalid payload: ${safeErrMsg(e)}`;
      logger.error(
        { krsDispatch: { jobId: job.id, ref: job.ref, code: "BAD_PAYLOAD" } },
        "KRS dispatch: invalid SyncJob payload"
      );
      const { terminal } = await markFailedOrRetry(job.id, job.attempts, msg);
      result.failed += 1;
      if (terminal) {
        logger.error(
          { krsDispatch: { jobId: job.id, ref: job.ref } },
          "KRS dispatch: job reached terminal FAILED (bad payload)"
        );
      }
      continue;
    }

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
          // Advance the global snapshot EXACTLY ONCE (guarded by snapshotAdvancedAt): if a
          // prior attempt already advanced it, markSyncedAndAdvance re-asserts SYNCED only.
          await markSyncedAndAdvance(
            job.id,
            job.attempts,
            JSON.stringify({ transactionNo: job.krsClaimedTxnNo, recovered: true }),
            payload.items.map((it) => ({ itemCode: it.itemCode, qty: it.quantity })),
            payload.warehouseCode,
            "decrement"
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

    // === DISCOUNT-WRITE GATE ===
    // Placed AFTER the reclaim block ON PURPOSE (load-bearing): a discounted job that
    // ALREADY burned an anchor and committed its phase-1 write must first be recovered to
    // SYNCED (with the global snapshot advanced) by the reclaim block above — otherwise
    // holding it here would strand a committed-but-unrecorded KRS write and leave the
    // snapshot un-advanced (stock double-count risk). Only a NOT-YET-WRITTEN discounted job
    // reaches this gate. When the discount-write flag is off, HOLD it: re-queue WITHOUT
    // counting an attempt (same pattern as the KRS_OUTBOUND_ENABLED=false path above) so it
    // waits, PENDING, until the owner enables the verified net-out writeback. Zero-discount
    // bills pass straight through.
    if (env.KRS_DISCOUNT_WRITE_ENABLED !== "true" && salePayloadHasDiscount(payload)) {
      await requeueHeld(job.id);
      result.skipped += 1;
      logger.info(
        { krsDispatch: { jobId: job.id, ref: job.ref, code: "DISCOUNT_HELD" } },
        "KRS dispatch: discounted bill held — KRS_DISCOUNT_WRITE_ENABLED is off"
      );
      continue;
    }

    // === KRS WRITE (mssql, OUTSIDE any Prisma tx) ===
    try {
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
      // Store ALL returned KRS document numbers in SyncJob.response so the sale is
      // fully traceable back to its KRS rows (sale txn/voucher, flow txn/voucher, jnl).
      // markSyncedAndAdvance also burns this sale's KRS stock-cut into the global snapshot
      // EXACTLY ONCE, so the next auto-sync does not re-apply it as a fresh negative delta.
      await markSyncedAndAdvance(
        job.id,
        job.attempts,
        JSON.stringify({
          transactionNo: writeResult.transactionNo,
          journalNo: writeResult.journalNo,
          saleVoucherNo: writeResult.saleVoucherNo,
          flowTxnNo: writeResult.flowTxnNo,
          flowVoucherNo: writeResult.flowVoucherNo,
          jnlCode: writeResult.jnlCode,
        }),
        payload.items.map((it) => ({ itemCode: it.itemCode, qty: it.quantity })),
        payload.warehouseCode,
        "decrement"
      );
      result.synced += 1;
    } catch (e) {
      // "Leave pending" outcome (NOT a transient failure, NOT a data error):
      //  - WriteConfigNotReadyError → vendor constants still TODO_FROM_VENDOR.
      // Re-queue without counting an attempt; the job waits for the config to land.
      if (e instanceof WriteConfigNotReadyError) {
        await requeuePending(job.id);
        result.skipped += 1;
        logger.debug(
          { krsDispatch: { jobId: job.id, ref: job.ref, code: e.name } },
          "KRS dispatch: write not configured — left pending"
        );
        continue;
      }
      // Transient/real write failure → retry with backoff or terminal FAILED. Log the
      // SANITIZED code/message only — never the raw mssql driver error/config.
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
        "KRS dispatch: write failed"
      );
      const { terminal } = await markFailedOrRetry(job.id, job.attempts, sanitized);
      result.failed += 1;
      if (terminal) {
        logger.error(
          { krsDispatch: { jobId: job.id, ref: job.ref } },
          "KRS dispatch: job reached terminal FAILED"
        );
      }
    }
  }

  logger.info(
    { krsDispatch: { ...result } },
    "KRS dispatch run completed"
  );
  return result;
}

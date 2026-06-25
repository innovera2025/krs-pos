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
// FAIL-OPEN (invariant): a KRS/dispatch failure NEVER touches checkout — this module
// only runs from the dispatch endpoint, well after the sale committed. A write failure
// just updates the SyncJob (retry/backoff/FAILED); the sale is untouched.
//
// IDEMPOTENT (invariant): the atomic claim (FOR UPDATE SKIP LOCKED) guarantees a job
// is claimed by exactly one worker; the dedup check skips a job whose idempotencyKey
// already has a SYNCED row, so a re-queued/duplicate job never double-writes.
//
// Plan: process/features/krs-sync/active/krs-outbound-writeback_PLAN_25-06-26.md §8

import { SyncJobStatus, SyncJobType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { buildSandboxConfig } from "./sandboxClient";
import { parseSalePayload } from "./salePayload";
import {
  writeKrsSale,
  WritebackNotImplementedError,
  WriteConfigNotReadyError,
} from "./writeback";

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

/** Mark a job SYNCED after a successful KRS write. Clears the lock, records the KRS
 *  document numbers in `response`, and bumps `attempts` (the succeeding attempt). */
async function markSynced(
  jobId: string,
  currentAttempts: number,
  response: string
): Promise<void> {
  await prisma.syncJob.update({
    where: { id: jobId },
    data: {
      status: SyncJobStatus.SYNCED,
      lockedAt: null,
      attempts: currentAttempts + 1,
      response,
      lastError: null,
    },
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

    // === KRS WRITE (mssql, OUTSIDE any Prisma tx) ===
    try {
      const writeResult = await writeKrsSale(payload, sandboxConfig);
      await markSynced(
        job.id,
        job.attempts,
        JSON.stringify({
          transactionNo: writeResult.transactionNo,
          journalNo: writeResult.journalNo,
        })
      );
      result.synced += 1;
    } catch (e) {
      // "Leave pending" outcomes (NOT a transient failure, NOT a data error):
      //  - WritebackNotImplementedError → Track B not built yet (the current state).
      //  - WriteConfigNotReadyError     → vendor constants still TODO_FROM_VENDOR.
      // Re-queue without counting an attempt; the job waits for Track B / config.
      if (
        e instanceof WritebackNotImplementedError ||
        e instanceof WriteConfigNotReadyError
      ) {
        await requeuePending(job.id);
        result.skipped += 1;
        logger.debug(
          { krsDispatch: { jobId: job.id, ref: job.ref, code: e.name } },
          "KRS dispatch: write not configured/implemented — left pending"
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

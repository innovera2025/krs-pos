-- Migration: sync_job_outbox (krs-sync P2 — outbound write-back outbox)
-- Additive only. All new columns are nullable or defaulted, so existing rows and the
-- seed data are unaffected. The @unique index on idempotencyKey allows multiple NULLs
-- in Postgres, so legacy SyncJob rows (which have no key) do not collide.

-- AlterTable: add the 6 outbox fields to SyncJob.
ALTER TABLE "SyncJob"
  ADD COLUMN     "payload"        JSONB,
  ADD COLUMN     "idempotencyKey" TEXT,
  ADD COLUMN     "attempts"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "lastError"      TEXT,
  ADD COLUMN     "nextAttemptAt"  TIMESTAMP(3),
  ADD COLUMN     "lockedAt"       TIMESTAMP(3);

-- CreateIndex: unique key for dedup (multiple NULLs allowed in Postgres).
CREATE UNIQUE INDEX "SyncJob_idempotencyKey_key" ON "SyncJob"("idempotencyKey");

-- CreateIndex: serves the dispatcher's PENDING/RETRYING claim scan + retry gate.
CREATE INDEX "SyncJob_status_nextAttemptAt_idx" ON "SyncJob"("status", "nextAttemptAt");

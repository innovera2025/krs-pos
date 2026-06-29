-- Migration: add_heldbill_resolved_at (พักบิล resume/discard — least-privilege soft-delete)
-- Additive only. One nullable column. No backfill, no constraint changes, no other table
-- alterations. Existing rows default resolvedAt to NULL = still ACTIVE / resumable.
--
-- Purpose: the app DB role `krs_app` holds only SELECT/INSERT/UPDATE — NOT DELETE
-- (deliberate least-privilege; db/init/01-app-role.sh). HeldBill is the first feature that
-- would hard-DELETE a row, so `prisma.heldBill.delete()` fails with Postgres 42501
-- "permission denied". Instead, "discard" and "consume-on-resume" stamp `resolvedAt` via an
-- atomic UPDATE (which krs_app CAN do):
--   NULL     = ACTIVE / open / still resumable (the default for every existing parked bill)
--   non-NULL = consumed (resumed) OR discarded — excluded from the GET list and never
--              re-claimable by the atomic resume UPDATE.
-- No DELETE grant is added; the least-privilege posture is preserved (no prod DB change).

-- AlterTable: soft-delete marker for held-bill resume/discard.
ALTER TABLE "HeldBill" ADD COLUMN "resolvedAt" TIMESTAMP(3);

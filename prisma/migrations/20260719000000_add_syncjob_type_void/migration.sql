-- Migration: add_syncjob_type_void (krs-sync — VOID writeback)
-- Additive only: one new SyncJobType enum value. No backfill, no constraint changes.
-- Postgres cannot USE a newly-added enum value in the SAME transaction that adds it,
-- so this migration is the ALTER only (same constraint the NEEDS_RECONCILE precedent
-- in 20260627000000_add_syncjob_krs_claimed_txn_v2 documents).
ALTER TYPE "SyncJobType" ADD VALUE 'VOID';

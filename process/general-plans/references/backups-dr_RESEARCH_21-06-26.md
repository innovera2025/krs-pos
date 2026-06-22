# Database Backup + Restore (DR) — RESEARCH + Design

- Date: 2026-06-21 · Closes the gap-audit domain risk: "ไม่มี backup / PITR / DR — `docker compose down -v` = บัญชีขายหายถาวร" (a single-store cash POS with no recovery path). Scope: ops scripts + a runbook only — **no app code, no schema, no migration.**
- Companion: `backups-dr_REPORT_21-06-26.md` (what was built + the live DR drill).

## Current state (cited)
- **Persistence:** Postgres 16 runs in the compose `db` service backed by a named volume; `docker compose down -v` (or a disk failure) destroys it irrecoverably. No dump, no PITR, no off-box copy exists.
- **Roles:** the least-privilege phase added `krs_app` (LOGIN, DML-only) via `db/init/01-app-role.sh`, created by the superuser at first init. **This role is NOT captured by a plain `pg_dump -Fc`** (that dumps a single database's schema+data, not cluster-global roles) — a naive restore into a fresh cluster would recreate the DB but leave the app unable to log in. This is the key gotcha the design must handle.
- **Connections:** the compose stack does not publish 5432 to the host in production; backup/restore must run via `docker compose exec db …` (creds from `.env`, never hardcoded).
- **Migration ledger:** `_prisma_migrations` lives inside the database, so a logical dump that includes it lets the post-restore `migrate` service no-op (no double-apply / no drift).

## Decisions (= recommendations)
- **D1 — logical dump, not WAL/PITR.** `pg_dump -Fc` (custom format, compressed, selective restore) for schema+data **plus `pg_dumpall --globals-only`** for cluster roles (so `krs_app` is recreatable → a self-contained restore). WAL-archiving/PITR is overkill for a single store with low write volume; logical dumps are simpler to operate and verify.
- **D2 — host-cron-friendly shell scripts** using `docker compose exec` (port not published). Creds sourced from `.env` (no echo); zero secrets baked into the scripts. POSIX `sh` for portability.
- **D3 — retention + the off-box truth.** Local rotation (e.g. 7 daily + weeklies via `find -mtime +N -delete`), and a LOUD, repeated warning that **local-only dumps are NOT real DR** — a host-disk failure loses both the DB and its dumps. Real DR requires copying off-box (rsync/rclone to NAS/S3); Thai RD/PDPA retention (~5 years) means keeping monthly snapshots off-box.
- **D4 — restore order.** Recreate the role FIRST (apply the globals dump), THEN `pg_restore` the database (which carries `_prisma_migrations`, so the `migrate` service no-ops). A confirm-before-DROP guard (`--yes` to skip) prevents an accidental wipe of the wrong DB.

## Risks / failure modes the design must address
- **Role-not-in-pg_dump** (D1's globals dump) — the single most likely silent-failure on restore.
- **Partial/half-written backup** worse than none → `set -eu`, a pipefail guard where supported, and a trap that removes partial output on failure.
- **Restoring over a live DB** → stop `app`+`migrate`, terminate connections, then DROP+CREATE within the confirm guard.
- **False sense of safety from local-only copies** → the off-box warning is repeated in both the scripts and the runbook (D3).

## Sequencing (single pass)
`scripts/backup.sh` (globals + `-Fc` dump + rotation + trap) → `scripts/restore.sh` (recreate role → `pg_restore` → verify counts as `krs_app` + list `_prisma_migrations`) → runbook `process/context/container/db-backup-restore.md` (+ wire the `all-container.md` router) → `npm` wrappers (`db:backup`/`db:restore`) + `.env.example` (`BACKUP_DIR`/`RETENTION_DAYS`) + `.gitignore` (`/backups/`, `*.dump`). Verify: `sh -n`/`dash -n` + type-check + build, then a live DR drill (backup → DROP DATABASE + DROP ROLE → restore → exact data match).

# Database Backup + Restore (DR) — REPORT

- Date: 2026-06-21 · Research: `backups-dr_RESEARCH_21-06-26.md` (design + decisions). Closes the gap-audit domain risk "ไม่มี backup / PITR / DR — `docker compose down -v` = บัญชีขายหายถาวร". Ops scripts + runbook only — no app code / no schema / no migration.
- Status: ✅ **`sh -n`/`dash -n` + type-check + build pass + a full live DR drill (backup → DROP DATABASE + DROP ROLE → restore → EXACT data match) — verified.**

## Decisions (= research recommendations)
- **D1:** logical `pg_dump -Fc` (custom format) for schema+data **+ `pg_dumpall --globals-only`** for ROLES (the least-priv `krs_app` role is NOT in a `pg_dump -Fc`, so the globals dump makes restore self-contained). Not WAL-PITR (overkill for a single store).
- **D2:** host-cron-friendly shell scripts using `docker compose exec` (port 5432 not published); creds from `.env`, no secrets in scripts.
- **D3:** retention 7 daily + 4 weekly + rotation; **LOUD note that local-only is NOT real DR → copy off-box (rsync/rclone); Thai tax/PDPA retention ~5 years → keep monthly off-box.**
- **D4:** restore = recreate role (globals) FIRST → full `pg_restore` into a fresh DB (includes `_prisma_migrations`, so the `migrate` service no-ops, no double-apply).

## What was built
- **`scripts/backup.sh`** (POSIX sh, +x): loads `.env` (no echo), `pg_dumpall --globals-only` → `krs-pos-globals-<ts>.sql` + `pg_dump -Fc` → `krs-pos-<ts>.dump` into `$BACKUP_DIR` (default `./backups`); `set -eu` + pipefail-guard + a trap that removes partial files on failure (a half-written backup is worse than none); rotation (`find -mtime +N -delete`); header comment with a sample crontab line + the off-box/5-year warning.
- **`scripts/restore.sh`** (POSIX sh, +x): args = the `.dump` (+ optional `-globals-*.sql`) + `--yes` (else a "this will DROP $POSTGRES_DB" confirm). Steps via `docker compose exec`: stop `app`+`migrate` → terminate connections → DROP+CREATE DATABASE → apply globals (recreate `krs_app`) → `pg_restore --no-owner --role=$POSTGRES_USER` → verify (`SELECT count(*) FROM "Order"` as krs_app + list `_prisma_migrations`) → print "docker compose start app".
- **Runbook** `process/context/container/db-backup-restore.md` (manual backup/restore steps + cron + off-box + the role-not-in-pg_dump gotcha) + the `all-container.md` router wired to it.
- **npm:** `db:backup` / `db:restore` wrappers. **`.env.example`:** `BACKUP_DIR` + `RETENTION_DAYS` documented (uses the existing `POSTGRES_*` superuser creds). **`.gitignore`:** `/backups/` + `*.dump` (dumps never committed).

## Verification — live DR drill (orchestrator, ephemeral Postgres with the init role-bootstrap)
Ran the exact commands the scripts wrap against a seeded ephemeral DB:
- **BEFORE:** orders=6, products=17, customers=3, tax docNo=`TAX-2026-000418`, ShopSettings width=80, `krs_app` SELECT works.
- **Backup:** `globals.sql` (contains `CREATE ROLE krs_app`) + `krspos.dump` (~37 KB) produced.
- **DISASTER:** `DROP DATABASE krspos WITH (FORCE)` + `DROP ROLE krs_app` → `krs_app` gone, DB gone (total loss).
- **Restore:** CREATE DATABASE → apply globals (`krs_app` recreated) → `pg_restore`.
- **AFTER:** orders=6, products=17, customers=3, tax docNo=`TAX-2026-000418`, width=80, `_prisma_migrations`=9, `krs_app` SELECT works → **EXACT MATCH**. Every row + the role + the migration ledger recovered.
- Static: `sh -n` + `dash -n` clean; type-check + build pass.

## Notes / deviations
- `pipefail` is guarded (`( set -o pipefail ) 2>/dev/null && set -o pipefail || true`) for strict POSIX-sh/dash portability (pipefail isn't POSIX) — preserves the safety where supported.
- The scripts target the **compose** stack (`docker compose exec db`); the drill ran the same `pg_dump`/`pg_dumpall`/`pg_restore`/`psql` commands directly against an ephemeral container (the compose `db` `container_name` would clash with the running dev DB). The data round-trip — the thing DR depends on — is proven.
- **Real DR still requires off-box copies** (the scripts/runbook say so loudly): a host-disk failure loses local dumps. Set up `rsync`/`rclone` to a NAS/S3 + keep monthly snapshots ~5 years (Thai RD/PDPA).

## Remaining (Phase 4 / roadmap)
- Wire an off-box copy (rsync/rclone) + a managed-backup option if the host moves to cloud.
- Other Phase 4: PDPA + data retention (the off-box monthly policy ties in), abbreviated §86/6 (owner-gated), offline/PWA, a11y. Carried review items (shift-tx race, Zod on users, Customer PII scoping). Sentry (DSN). Move seller identity (env) into the `ShopSettings` admin screen.

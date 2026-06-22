# Database Backup & Restore (DR runbook)

Operational runbook for backing up and restoring the KRS POS Postgres database.
This database holds **real money and stock data**, so treat backups as a
compliance-and-survival concern, not a nice-to-have.

Read this after `process/context/container/all-container.md` when the task is
about taking, rotating, or restoring database backups, or about disaster
recovery.

Tooling lives in `scripts/`:
- `scripts/backup.sh` — take a logical backup (data dump + cluster roles)
- `scripts/restore.sh` — full restore into a fresh DB (automates this runbook)

npm wrappers: `npm run db:backup`, `npm run db:restore`.

---

## Design decisions (why it's built this way)

- **D1 — two artifacts per backup.** Each run produces:
  - `krs-pos-<TS>.dump` — schema + data via `pg_dump -Fc` (custom format).
  - `krs-pos-globals-<TS>.sql` — cluster **roles** via `pg_dumpall --globals-only`.
  - **The gotcha:** a `pg_dump -Fc` of a single database does **not** include
    cluster-level roles. The app logs in as the least-privilege `krs_app` role,
    which is created **outside** the database (by `db/init/01-app-role.sh`, and
    only on a *fresh* `pgdata` volume). Restoring only the `.dump` into a brand
    new cluster leaves `krs_app` missing and the app can't connect. The globals
    `.sql` captures the roles so a restore is self-contained.
- **D2 — `docker compose exec`, never `localhost:5432`.** Port 5432 is **not**
  published to the host (see `docker-compose.yml`). The dump/restore tools run
  *inside* the `db` container; stdout/stdin is streamed to/from host files.
  Credentials come from the git-ignored repo `.env` — never hardcoded.
- **D3 — retention + off-box.** Local rotation keeps a short rolling window
  (default 28 days ≈ 7 daily + 4 weekly recovery points). **Local-only is NOT
  disaster recovery** — copy backups off-box. Thai tax/PDPA retention is ≈5
  years, so keep **monthly** snapshots off-box for that long.
- **D4 — restore into a fresh DB.** Restore drops + recreates the database and
  `pg_restore`s the dump (which includes `_prisma_migrations`, so there is **no
  double-apply** of migrations). The role is recreated **first** from globals.

---

## Backup

### Run it

```bash
# From the repo root (so `.env` + `docker compose` resolve):
npm run db:backup
# or directly:
sh scripts/backup.sh
```

Output (default `BACKUP_DIR=./backups`, git-ignored):
- `backups/krs-pos-globals-<TS>.sql`
- `backups/krs-pos-<TS>.dump`

The script:
1. Loads `.env` (uses the **superuser** `POSTGRES_USER` — needed for
   `--globals-only` and a full data dump). It never echoes secrets.
2. Dumps roles, then schema+data.
3. On **any** failure, deletes the partial files and exits non-zero (a
   half-written backup is worse than none).
4. Prints the resulting file paths + sizes.
5. Rotates: deletes local `krs-pos-*` files older than `RETENTION_DAYS`
   (default 28).

Env knobs (set in `.env`):
- `BACKUP_DIR` — where dumps land (default `./backups`; on a server prefer
  `/opt/krs-backups`).
- `RETENTION_DAYS` — local rolling window before rotation deletes (default 28).

### Schedule it (host cron)

Run from the repo root so `docker compose` + `.env` resolve. Nightly at 02:30,
logging to a file:

```cron
30 2 * * *  cd /opt/krs-pos && /bin/sh scripts/backup.sh >> /var/log/krs-backup.log 2>&1
```

### ⚠️ Off-box copy is mandatory for real DR

A dump on the **same host** as the database dies *with* the host (disk failure,
theft, ransomware, fire). After the nightly backup, sync off-box, e.g.:

```bash
rsync -az "$BACKUP_DIR"/ backup-host:/srv/krs-pos-backups/
rclone copy "$BACKUP_DIR" remote:krs-pos-backups      # S3 / B2 / Drive / etc.
```

### ⚠️ 5-year retention (Thai tax + PDPA)

Accounting/tax records must be kept ≈**5 years**. The local rotation only keeps
a short window for fast recovery. You **must** retain **monthly** snapshots
**off-box** for ≈5 years to stay compliant — that off-box archive, not the local
window, is the legal record.

---

## Restore

### Automated (recommended)

```bash
# Prompts before dropping the DB:
sh scripts/restore.sh ./backups/krs-pos-<TS>.dump ./backups/krs-pos-globals-<TS>.sql

# Non-interactive (e.g. scripted DR drill):
npm run db:restore -- ./backups/krs-pos-<TS>.dump ./backups/krs-pos-globals-<TS>.sql --yes
```

Args (any order): the `.dump` (required), the matching `-globals-*.sql`
(optional but **strongly recommended** on a fresh cluster), and `--yes` to skip
the confirm prompt.

**This is destructive** — it DROPs and recreates `$POSTGRES_DB`.

### Manual runbook (what the script automates)

Do this by hand only if the script is unavailable. All commands run from the
repo root; creds come from `.env`. Substitute `$POSTGRES_USER`, `$POSTGRES_DB`,
`$APP_DB_USER` (default `krs_app`) and the backup `<TS>`.

1. **Stop the services that hold connections / could re-apply migrations:**
   ```bash
   docker compose stop app migrate
   ```
2. **Terminate any remaining connections to the DB** (DROP DATABASE fails while
   sessions are connected):
   ```bash
   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
     -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
         WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid();"
   ```
3. **Drop + recreate the database** (owned by the superuser):
   ```bash
   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
     -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\";"
   docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
     -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"
   ```
4. **Recreate cluster roles FIRST** (so `krs_app` exists before the data is
   restored). Roles are cluster-wide and survive the DROP DATABASE above; run
   *without* `ON_ERROR_STOP` so "role already exists" (e.g. the superuser) is
   harmless:
   ```bash
   docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres \
     < ./backups/krs-pos-globals-<TS>.sql
   ```
5. **Restore schema + data** from the custom-format dump. `--no-owner` skips
   restoring ownership to roles whose OIDs differ on a fresh cluster; `--role`
   runs the restore as the superuser:
   ```bash
   docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -Fc --no-owner --role="$POSTGRES_USER" < ./backups/krs-pos-<TS>.dump
   ```
6. **Verify**:
   ```bash
   # App role can read (proves krs_app + grants are intact):
   docker compose exec -T db psql -U "$APP_DB_USER" -d "$POSTGRES_DB" \
     -c 'SELECT count(*) FROM "Order";'
   # Migration history restored → migrate deploy won't re-apply:
   docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     -c 'SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at;'
   ```
7. **Bring the app back up:**
   ```bash
   docker compose start app
   ```

### Notes on migrations + roles

- The dump contains `_prisma_migrations`, so the restored DB already knows which
  migrations are applied. Do **not** expect/force a re-apply — `prisma migrate
  deploy` will see them as already done.
- If you restore into a cluster where `krs_app` already exists (e.g. the same
  volume), the globals `.sql` is optional; the role and its grants are already
  present. On a **fresh** cluster, the globals `.sql` is what makes the restore
  self-contained.

---

## Verify the scripts (no DB needed)

```bash
sh -n scripts/backup.sh && sh -n scripts/restore.sh   # POSIX-sh syntax check
```

---

## Update triggers

Update this doc when:
- the dump/restore strategy, formats, or flags change
- `db/init/01-app-role.sh` or the role model changes (the role-recreate step)
- `docker-compose.yml` service names / port publishing change (the
  `docker compose exec` assumption)
- `.env` backup-related vars (`BACKUP_DIR`, `RETENTION_DAYS`) change
- retention/off-box policy changes

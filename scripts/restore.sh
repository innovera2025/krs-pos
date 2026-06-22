#!/bin/sh
# =============================================================================
# KRS POS — database restore (full DR restore from a logical dump)       [ops]
# =============================================================================
# WHAT: Restores the krs-pos database from a `pg_dump -Fc` dump produced by
#   scripts/backup.sh, into a FRESH database. Recreates the cluster ROLES first
#   (from the matching globals .sql) so the least-privilege `krs_app` role
#   exists BEFORE the data is restored.
#
# !!!  DESTRUCTIVE  !!!
#   This DROPs the target database ($POSTGRES_DB) and recreates it. Everything
#   currently in it is destroyed and replaced by the dump contents. There is a
#   confirmation prompt unless you pass --yes.
#
# WHY the role is recreated FIRST:
#   A `pg_dump -Fc` of a single DB contains NO cluster roles. If you restore
#   into a fresh cluster without first creating `krs_app`, restore-time GRANTs
#   to that role fail and/or the app can't log in afterward. The globals .sql
#   (from pg_dumpall --globals-only) recreates the roles; apply it first.
#
# WHY `pg_restore --no-owner --role=$POSTGRES_USER`:
#   The dump's objects may be owned by roles whose exact OIDs differ on a fresh
#   cluster. `--no-owner` skips ownership-restore (objects end up owned by the
#   restoring superuser) and `--role` runs the restore as the superuser. The app
#   still works because db/init grants DML to krs_app via ALTER DEFAULT
#   PRIVILEGES / explicit GRANTs (re-applied by the globals + the dump's grants).
#
# WHY this is safe re: Prisma migrations:
#   The dump includes the `_prisma_migrations` table, so the restored DB already
#   knows which migrations are applied — `prisma migrate deploy` will NOT
#   re-apply them. Do NOT run the `migrate` service expecting a re-apply.
#
# CREDENTIALS: read from the git-ignored repo `.env` (POSTGRES_USER /
#   POSTGRES_PASSWORD / POSTGRES_DB). Nothing secret is hardcoded or echoed.
#
# USAGE:
#   sh scripts/restore.sh <path/to/krs-pos-<TS>.dump> [path/to/krs-pos-globals-<TS>.sql] [--yes]
#   npm run db:restore -- ./backups/krs-pos-20260622-023000.dump \
#                          ./backups/krs-pos-globals-20260622-023000.sql --yes
# =============================================================================

set -eu
( set -o pipefail ) 2>/dev/null && set -o pipefail || true

# --- Locate repo root so `.env` + `docker compose` resolve regardless of cwd --
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# --- Parse args (dump = required; globals + --yes = optional, any order) ------
DUMP_PATH=""
GLOBALS_PATH=""
ASSUME_YES="no"
for arg in "$@"; do
  case "$arg" in
    --yes|-y)
      ASSUME_YES="yes"
      ;;
    *.dump)
      DUMP_PATH="$arg"
      ;;
    *.sql)
      GLOBALS_PATH="$arg"
      ;;
    *)
      echo "ERROR: unrecognized argument: $arg" >&2
      echo "Usage: sh scripts/restore.sh <dump.dump> [globals.sql] [--yes]" >&2
      exit 2
      ;;
  esac
done

if [ -z "$DUMP_PATH" ]; then
  echo "ERROR: a .dump file path is required." >&2
  echo "Usage: sh scripts/restore.sh <dump.dump> [globals.sql] [--yes]" >&2
  exit 2
fi
if [ ! -f "$DUMP_PATH" ]; then
  echo "ERROR: dump file not found: $DUMP_PATH" >&2
  exit 1
fi
if [ -n "$GLOBALS_PATH" ] && [ ! -f "$GLOBALS_PATH" ]; then
  echo "ERROR: globals file not found: $GLOBALS_PATH" >&2
  exit 1
fi

cd "$REPO_ROOT"

# --- Load env (do NOT echo secrets) ------------------------------------------
if [ ! -f ./.env ]; then
  echo "ERROR: ./.env not found at $REPO_ROOT — cannot read DB credentials." >&2
  exit 1
fi
set -a
. ./.env
set +a

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-krs_pos}"
APP_DB_USER="${APP_DB_USER:-krs_app}"

echo "[restore] repo:       $REPO_ROOT"
echo "[restore] target db:  $POSTGRES_DB (superuser: $POSTGRES_USER)"
echo "[restore] dump:       $DUMP_PATH"
if [ -n "$GLOBALS_PATH" ]; then
  echo "[restore] globals:    $GLOBALS_PATH"
else
  echo "[restore] globals:    (none supplied — assuming roles already exist)"
fi

# --- Confirmation gate -------------------------------------------------------
if [ "$ASSUME_YES" != "yes" ]; then
  printf 'This will DROP and replace database "%s". Continue? [y/N] ' "$POSTGRES_DB"
  read -r REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "[restore] aborted by user."; exit 1 ;;
  esac
fi

# --- 1) Stop services that hold connections / could re-apply migrations ------
echo "[restore] stopping app + migrate services..."
docker compose stop app migrate || true

# --- 2) Terminate any remaining client connections to the target DB ----------
# A DROP DATABASE fails if other sessions are connected. Kill them first.
echo "[restore] terminating other connections to $POSTGRES_DB..."
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
      WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid();"

# --- 3) Drop + recreate the target DB (owned by the superuser) ---------------
echo "[restore] dropping + recreating database $POSTGRES_DB..."
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\";"
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\";"

# --- 4) Recreate cluster ROLES first (so krs_app exists before the restore) ---
# The globals .sql may contain CREATE ROLE for roles that already exist on this
# cluster (e.g. the superuser). Those statements error harmlessly; we therefore
# run the globals WITHOUT ON_ERROR_STOP so an "already exists" does not abort the
# whole restore. (Roles are cluster-wide and survive the DROP DATABASE above.)
if [ -n "$GLOBALS_PATH" ]; then
  echo "[restore] applying globals (roles incl. $APP_DB_USER)..."
  docker compose exec -T db psql -U "$POSTGRES_USER" -d postgres < "$GLOBALS_PATH"
else
  echo "[restore] no globals supplied; ensure roles (incl. $APP_DB_USER) already exist."
fi

# --- 5) Restore schema + data from the custom-format dump --------------------
# --no-owner: don't try to SET OWNER to roles that may differ on this cluster.
# --role:     run the restore session as the superuser.
echo "[restore] restoring data (pg_restore -Fc) into $POSTGRES_DB..."
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc --no-owner --role="$POSTGRES_USER" < "$DUMP_PATH"

# --- 6) Verify ---------------------------------------------------------------
echo "[restore] verifying restored data..."
echo "[restore]   Order row count (as $APP_DB_USER — proves app role can read):"
docker compose exec -T db psql -U "$APP_DB_USER" -d "$POSTGRES_DB" \
  -c 'SELECT count(*) AS order_count FROM "Order";'
echo "[restore]   Applied Prisma migrations (proves _prisma_migrations restored):"
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY finished_at;'

echo ""
echo "[restore] DONE. The app + migrate services are still STOPPED."
echo "[restore] To bring the app back up, run:"
echo "[restore]   docker compose start app"

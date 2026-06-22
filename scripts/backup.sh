#!/bin/sh
# =============================================================================
# KRS POS — database backup (logical dump + cluster roles)               [ops]
# =============================================================================
# WHAT: Takes a self-contained logical backup of the krs-pos Postgres database:
#   1. krs-pos-globals-<TS>.sql  — cluster ROLES via `pg_dumpall --globals-only`
#   2. krs-pos-<TS>.dump         — schema + data via `pg_dump -Fc` (custom format)
#
# WHY BOTH FILES (the critical gotcha):
#   A `pg_dump -Fc` of a single database does NOT include cluster-level roles.
#   The app connects as the least-privilege `krs_app` role, which is created
#   outside the database (by db/init/01-app-role.sh, only on a FRESH volume).
#   If you restore ONLY the .dump into a brand-new cluster, `krs_app` will not
#   exist and the app cannot log in. The globals .sql captures the roles so a
#   restore can recreate `krs_app` first and be fully self-contained.
#
# WHY `docker compose exec` (not localhost:5432):
#   Port 5432 is NOT published to the host (see docker-compose.yml). Postgres is
#   reachable only on the internal compose network. We therefore run the dump
#   tools INSIDE the `db` container and stream stdout to a host file.
#
# CREDENTIALS:
#   Read from the git-ignored repo `.env` (POSTGRES_USER / POSTGRES_PASSWORD /
#   POSTGRES_DB). The SUPERUSER creds are used on purpose: pg_dumpall --globals
#   and a full data dump need cluster-wide read. NO secret is hardcoded here and
#   nothing secret is echoed.
#
# -----------------------------------------------------------------------------
# SAMPLE HOST CRONTAB (run from the repo root so `docker compose` + `.env`
# resolve; nightly at 02:30, log to a file):
#
#   30 2 * * *  cd /opt/krs-pos && /bin/sh scripts/backup.sh >> /var/log/krs-backup.log 2>&1
#
# !!!  LOCAL-ONLY BACKUPS ARE *NOT* DISASTER RECOVERY  !!!
#   A dump sitting on the SAME host as the database dies WITH the host (disk
#   failure, theft, ransomware, fire). Real DR REQUIRES an off-box copy. Add an
#   off-box sync AFTER this script, e.g.:
#     rsync -az "$BACKUP_DIR"/ backup-host:/srv/krs-pos-backups/
#     rclone copy "$BACKUP_DIR" remote:krs-pos-backups   # to S3/B2/Drive/etc.
#
# RETENTION (Thai tax + PDPA): accounting/tax records must be kept ~5 YEARS.
#   The local rotation below keeps only a short rolling window. You MUST retain
#   MONTHLY snapshots OFF-BOX for ~5 years to stay compliant. The local window
#   is for fast recovery, not the legal record.
# =============================================================================

set -eu
# pipefail is bash/ksh; guard so `sh` (dash/busybox) does not choke on it.
( set -o pipefail ) 2>/dev/null && set -o pipefail || true

# --- Locate repo root so `.env` + `docker compose` resolve regardless of cwd --
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
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
# Where dumps land. Override via .env (BACKUP_DIR). Default to a repo-local dir
# (./backups) which is git-ignored; on a server prefer e.g. /opt/krs-backups.
BACKUP_DIR="${BACKUP_DIR:-./backups}"

# How many days of local files to keep before rotation deletes them. The spec is
# "7 daily + 4 weekly"; a robust, simple approximation is a 28-day rolling
# window (covers ~7 days + ~4 weeks of recovery points). Override via .env.
RETENTION_DAYS="${RETENTION_DAYS:-28}"

mkdir -p "$BACKUP_DIR"

TS=$(date +%Y%m%d-%H%M%S)
GLOBALS_FILE="$BACKUP_DIR/krs-pos-globals-$TS.sql"
DUMP_FILE="$BACKUP_DIR/krs-pos-$TS.dump"

# --- Partial-cleanup on ANY failure ------------------------------------------
# A half-written backup is worse than none: it looks like a valid restore point
# but silently restores garbage. On any error/interrupt, delete what we wrote.
cleanup_partial() {
  rm -f "$GLOBALS_FILE" "$DUMP_FILE" 2>/dev/null || true
}
trap 'cleanup_partial' EXIT INT TERM

echo "[backup] repo:        $REPO_ROOT"
echo "[backup] target db:   $POSTGRES_DB (user: $POSTGRES_USER)"
echo "[backup] backup dir:  $BACKUP_DIR"
echo "[backup] timestamp:   $TS"

# --- 1) Cluster ROLES (so a fresh-cluster restore can recreate krs_app) ------
echo "[backup] dumping globals (roles) -> $GLOBALS_FILE"
docker compose exec -T db pg_dumpall -U "$POSTGRES_USER" --globals-only > "$GLOBALS_FILE"

# --- 2) Schema + data (custom format; restorable with pg_restore) ------------
echo "[backup] dumping database (schema+data, -Fc) -> $DUMP_FILE"
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$DUMP_FILE"

# Both files written successfully — disarm the cleanup trap so we keep them.
trap - EXIT INT TERM

# --- Sanity: non-empty outputs (a 0-byte dump is a silent failure) -----------
if [ ! -s "$GLOBALS_FILE" ] || [ ! -s "$DUMP_FILE" ]; then
  echo "ERROR: a backup file is empty — treating as failure." >&2
  cleanup_partial
  exit 1
fi

echo "[backup] OK. Files written:"
# `ls -lh` prints human-readable sizes; no secrets involved.
ls -lh "$GLOBALS_FILE" "$DUMP_FILE"

# --- Rotation: delete local backups older than RETENTION_DAYS ----------------
# Matches both the .dump and the -globals-*.sql via the shared `krs-pos-*` prefix.
# NOTE: this only prunes the LOCAL window — your off-box monthly retention
# (≈5 years for Thai tax/PDPA) is a SEPARATE, EXTERNAL responsibility.
echo "[backup] rotating local backups older than ${RETENTION_DAYS} days in $BACKUP_DIR"
find "$BACKUP_DIR" -type f -name 'krs-pos-*' -mtime +"$RETENTION_DAYS" -print -delete || true

echo "[backup] done."

#!/bin/sh
# ---------------------------------------------------------------------------
# Least-privilege app DB role bootstrap (KRS POS, Phase 3).
#
# WHEN THIS RUNS:
#   The postgres:16-alpine image runs every executable script in
#   /docker-entrypoint-initdb.d ONLY ONCE, on a FRESH data directory (i.e. the
#   very first time the `pgdata` volume is created). It does NOT run again on an
#   existing database.
#
#   => For an EXISTING database (volume already initialized), this same SQL must
#      be applied MANUALLY, once, as the superuser. For example:
#        docker compose exec -e APP_DB_USER -e APP_DB_PASSWORD db \
#          sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
#            CREATE ROLE "krs_app" LOGIN PASSWORD '"'"'...'"'"';
#            ... (the same statements as below) ...
#          SQL'
#
# WHAT IT DOES:
#   Creates a dedicated `krs_app` login role with DML-only access (SELECT,
#   INSERT, UPDATE) to the `public` schema. Deliberately NO DELETE and NO DDL:
#   the app never issues a DB DELETE and must not alter the schema. Migrations
#   run as the superuser (POSTGRES_USER) via a separate connection string.
#
#   ALTER DEFAULT PRIVILEGES is keyed to the superuser so that tables created
#   LATER by `prisma migrate deploy` (which connects as POSTGRES_USER) auto-grant
#   DML to krs_app without re-running this script.
# ---------------------------------------------------------------------------
set -e

APP_USER="${APP_DB_USER:-krs_app}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE "$APP_USER" LOGIN PASSWORD '${APP_DB_PASSWORD}';
  GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO "$APP_USER";
  GRANT USAGE ON SCHEMA public TO "$APP_USER";
  -- Future tables created by the superuser (via prisma migrate deploy) auto-grant DML:
  ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE ON TABLES TO "$APP_USER";
  ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO "$APP_USER";
  -- Existing objects (none at fresh init; harmless + covers manual re-runs):
  GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO "$APP_USER";
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "$APP_USER";
EOSQL

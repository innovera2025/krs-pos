# Phase 3 (cont.) REPORT — Least-privilege DB role

- Date: 2026-06-21 · gap-audit root theme #1/#6 ("uses superuser `postgres`"). Config/infra only — no app code / no Prisma schema change.
- Status: ✅ **Verified live** — provisioned a fresh DB via the init script, migrated as the superuser, then ran the **app as `krs_app`** through e2e 14/14 + financial smokes (checkout/void/oversell), and confirmed `krs_app` is **denied** DDL/DELETE/DROP.

## What was built
- **`db/init/01-app-role.sh`** (executable; runs once via Postgres `/docker-entrypoint-initdb.d` on a fresh data dir) — creates the least-privilege login role `krs_app` and grants **DML only**:
  - `CREATE ROLE krs_app LOGIN` (NOT superuser / NOT createdb / NOT createrole), `GRANT CONNECT` on the db, `GRANT USAGE` on schema public.
  - `ALTER DEFAULT PRIVILEGES FOR ROLE <superuser> IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO krs_app` — so tables that `prisma migrate deploy` (run as the superuser) creates LATER auto-grant to `krs_app`. Same for sequences (USAGE, SELECT — none exist; insurance). Plus `GRANT … ON ALL TABLES` for existing objects / manual re-runs.
  - **No DELETE, no DDL** (the app never issues a DB DELETE; verified). Header documents: fresh-init only; apply the SQL manually once on an existing DB.
- **`docker-compose.yml`** — two-connection split:
  - `db`: env `APP_DB_USER`/`APP_DB_PASSWORD` + bind-mount `./db/init:/docker-entrypoint-initdb.d:ro`. No host port + healthcheck kept.
  - `migrate` service → `DATABASE_URL: ${MIGRATE_DATABASE_URL}` (the **superuser** — DDL).
  - `app` service → `DATABASE_URL: ${DATABASE_URL}` (now the **`krs_app` least-priv** connection — DML).
- **`.env.example`** — documents the two roles + two connection strings (placeholders only): `POSTGRES_USER/PASSWORD/DB` (superuser, used by db init + migrations), `APP_DB_USER`(=krs_app)/`APP_DB_PASSWORD`, `DATABASE_URL` (app = least-priv), `MIGRATE_DATABASE_URL` (superuser).

## Verification (orchestrator — fresh ephemeral Postgres with the init script mounted)
- **Provisioning:** the init script created `krs_app` with `rolsuper=false, rolcreatedb=false, rolcreaterole=false, rolcanlogin=true`. ✓
- **Auto-grant on migration tables:** after `prisma migrate deploy` (as superuser) + seed, `krs_app` had exactly `INSERT, SELECT, UPDATE` on `Order`/`Product`/`DailyOrderCounter`/`AuditLog` (via ALTER DEFAULT PRIVILEGES) and **0 DELETE grants**. ✓
- **App as `krs_app` (least-priv) — full surface works:**
  - **e2e 14/14** (auth/rbac/routes/checkout) ✓
  - **checkout → 201** (INSERT Order/OrderItem/PaymentLine/StockMovement + UPDATE Product stock + DailyOrderCounter `INSERT…ON CONFLICT` upsert + AuditLog INSERT — all permitted) ✓
  - **void → 200** (UPDATE + AuditLog) ✓ · **oversell → 422** (atomic guard) ✓ · **SELECT** count works ✓
- **Negative (least-priv enforced):** as `krs_app` — `CREATE TABLE` → *permission denied for schema public*; `DELETE FROM "Order"` → *permission denied for table Order*; `DROP TABLE "Product"` → *must be owner of table Product*. ✓
- Ephemeral DB torn down.

## Notes / deviations
- `POSTGRES_USER` was reassigned from `krs_app` (old placeholder) to the **superuser** (`postgres`-style); `krs_app` is now the separate app role. Documented in `.env.example`. This is the intended two-role design.
- Existing/already-provisioned databases need the init SQL applied **once manually** (the init script only runs on a fresh data dir) — documented in the script header.
- The app genuinely needs no DELETE (no DB delete anywhere in the code) — so the role is DML-minus-DELETE: SELECT/INSERT/UPDATE only.

## Remaining (Phase 3 + roadmap)
- **Sentry** — needs the owner's DSN (then a Node-only init + capture in logger/error paths).
- Optionally: separate non-superuser *owner* role for migrations (vs reusing POSTGRES_USER) — marginal for a single-store internal-only DB; deferred.
- **Phase 4:** tax invoice (running no. + TIN + VAT), backups/PITR + DR, PDPA + data retention, offline/PWA, a11y; + carried deferred review items (Customer PII/PDPA scoping, shift-tx race, idempotency body-match).

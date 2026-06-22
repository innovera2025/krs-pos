# Container Context

This file is the canonical container context entrypoint for krs-pos.

Use it after `process/context/all-context.md` when the task needs Docker, docker-compose, local
Postgres, the production image, or port/service wiring.

---

## Scope

This group covers:

- the `Dockerfile` (Next.js production image)
- `docker-compose.yml` services: `db` (Postgres) and `app` (the built Next.js app)
- ports, volumes, healthchecks, and service dependencies
- how to bring up a local database vs the full stack
- database **backup & restore / DR** → see `db-backup-restore.md` (deeper doc)

It does not cover:

- Prisma schema / migrations → `process/context/database/all-database.md`
- application/runtime logic → `all-context.md`
- a CI/CD pipeline (none exists yet)

## Read When

Read this entrypoint when:

- changing the Dockerfile or compose services
- standing up a local Postgres or the full app+db stack
- debugging container ports, env wiring, or build issues
- planning deployment of the production image
- backing up, rotating, or restoring the database / doing DR
  → `db-backup-restore.md`

## Services (`docker-compose.yml`)

| Service | Image / build | Port | Notes |
|---|---|---|---|
| `db` | `postgres:16-alpine` | **not published** | `POSTGRES_USER/PASSWORD/DB` come from env (`${POSTGRES_USER}` / `${POSTGRES_PASSWORD}` / `${POSTGRES_DB:-krs_pos}`); default user is non-`postgres` (suggest `krs_app`); named volume `pgdata`; healthcheck via `pg_isready -U ${POSTGRES_USER}` |
| `app` | built from `./Dockerfile` | `3000:3000` | `depends_on: db (service_healthy)`; `NODE_ENV=production`; `DATABASE_URL` from env, points at `db:5432` (in-network host `db`) |

- **Phase 0 hardening (2026-06-20):** the `db` service no longer hardcodes credentials and no
  longer publishes port 5432 to the host. Credentials are read from env vars at compose time, and
  Postgres is reachable only over the internal compose network (host `db`), not from the host/LAN.
- The compose `app` service sets `DATABASE_URL` from `${DATABASE_URL}`. Inside compose it must point
  at host **`db`** (the compose service name), e.g.
  `postgresql://krs_app:PASSWORD@db:5432/krs_pos?schema=public` — not `localhost`.
- Required env vars (names only; values live in a git-ignored `.env`, never committed):
  `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL`. See `.env.example` for
  placeholder-only documentation.
- The image's `POSTGRES_USER` is still the Postgres cluster owner. A true least-privilege app role
  (an app role distinct from the cluster owner, with superuser reserved for migrations) is
  **deferred to Phase 3** — Phase 0 only stops using the literal `postgres:postgres` default and
  stops publishing the port.
- `.dockerignore` excludes `node_modules`, `.next`, local env, `.git`, and the Docker/meta files
  (among others) from the build context.

## Common Commands

Compose now reads DB credentials from env, so create a `.env` (from `.env.example`) with
`POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` / `DATABASE_URL` set before running compose.

```bash
# Just the database (run the app with `npm run dev` on the host):
docker compose up -d db

# Full stack (build the app image + run db):
docker compose up -d --build

# Tail logs / stop:
docker compose logs -f app
docker compose down            # add -v to also drop the pgdata volume
```

The `db` service **no longer publishes port 5432 to the host** (Phase 0). The app running inside
compose reaches it at host `db`. If you run the **app on the host** and need it to reach the compose
`db`, that requires re-publishing the port (intentionally a follow-up — not enabled in Phase 0); the
default workflow assumes the app runs inside compose (host `db`).

## Build Gotchas

- **The two hard build-blockers are FIXED in Phase 0 (2026-06-20):**
  1. **Lockfile — RESOLVED.** `package-lock.json` is now committed, so the `deps` stage's `npm ci`
     (which **requires** a lockfile) works. Regenerate with `npm install` after dependency changes
     and re-commit the lockfile.
  2. **`public/` directory — RESOLVED.** `public/.gitkeep` is now committed, so the runner stage's
     `COPY --from=builder /app/public ./public` no longer fails the build.
- **Deferred to Phase 3:** a true least-privilege DB role (an app role distinct from the Postgres
  cluster owner, with superuser reserved for migrations). Phase 0 only moved DB credentials to env
  and stopped publishing port 5432; the official image's `POSTGRES_USER` is still the cluster owner.
- The build runs `npx prisma generate` before `npm run build`, so the Prisma client is generated
  inside the image — schema changes require a rebuild.
- Image is multi-stage (`base → deps → builder → runner`) on `node:20-alpine`; the runner runs as a
  non-root `nextjs` user and starts via `npm run start` on `PORT=3000`. `NODE_ENV=production` is set
  in **two** places — the Dockerfile runner (`ENV NODE_ENV=production`) and the compose `app` service —
  so the built image stays in production mode even if the compose value is removed.

## Backup & Restore (DR)

Database backup, rotation, and restore are owned by `scripts/backup.sh` /
`scripts/restore.sh` (npm: `db:backup` / `db:restore`). Because port 5432 is not
published, both run the Postgres tools via `docker compose exec` and read creds
from the git-ignored `.env`. A backup is **two** files: a `pg_dump -Fc` data
dump **plus** a `pg_dumpall --globals-only` roles dump (the least-priv `krs_app`
role is NOT in a single-DB dump and must be recreated on restore).

Full procedure, cron line, off-box/5-year-retention guidance, and the manual
restore runbook: **`db-backup-restore.md`**.

## Update Triggers

Update this group when:

- the Dockerfile build stages or base images change
- compose services, ports, volumes, healthchecks, or env wiring change
- a reverse proxy, additional service (e.g. Redis), or CI/CD deploy is introduced
- the backup/restore scripts, formats, retention, or DR policy change
  (also update `db-backup-restore.md`)

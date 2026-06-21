# Phase 3 (cont.) REPORT — Deploy hardening (standalone image + auto-migrate + compose)

- Date: 2026-06-21 · follows `phase3-ci_REPORT_21-06-26.md` · gap-audit root theme #6 (build/deploy). Config/infra only (no app-logic change; one env-guard already in place).
- Status: ✅ **type-check + build (standalone) + both docker images build + live run-chain (migrate → standalone app → health 200 → real Prisma query) — all verified** against an ephemeral Postgres on a docker network.

## What was built
- **`next.config.mjs`** — `output: "standalone"` (slim, self-contained server bundle; faster cold start).
- **`Dockerfile`** — runner stage rewritten to run the **standalone** server (`node server.js`): copies `.next/standalone` + `.next/static` + `public` only (not the full node_modules). **Prisma gotcha handled:** standalone tracing misses the native query engine, so the runner explicitly copies `node_modules/.prisma` + `node_modules/@prisma/client` (the base stage already has `openssl` + `libc6-compat` the engine needs). New `migrate` target (`FROM builder`, `CMD ["npx","prisma","migrate","deploy"]`) carries the prisma CLI for one-shot migrations — the app image deliberately does NOT.
- **`docker-compose.yml`** —
  - **Boot-bug fix:** the app service now passes `AUTH_SECRET: ${AUTH_SECRET}` (it previously set only DATABASE_URL/NODE_ENV → env.ts would fail-fast at runtime and the app could never boot). Also `AUTH_TRUST_HOST` (default true) + optional `AUTH_URL` passthrough.
  - **Auto-migrate:** new one-shot `migrate` service (target `migrate`, `restart:"no"`, depends_on db healthy); the app `depends_on` db `service_healthy` AND migrate `service_completed_successfully` → migrations apply before the app starts on every deploy.
  - **Resource limits:** app `deploy.resources.limits` 512M / 1.0 cpu; `restart: unless-stopped` kept. DB still has NO published host port (internal-only invariant held).
- **`.env.example`** — documents `AUTH_SECRET` (≥16, `openssl rand -hex 32`), `AUTH_TRUST_HOST`, `AUTH_URL`, and the compose `DATABASE_URL` form (`postgresql://USER:PASS@db:5432/krs_pos?schema=public`). Placeholders only.

## Verification (orchestrator — ephemeral Postgres on a docker network, no container-name clash with dev)
- `npm run build` → `.next/standalone/server.js` present; `docker build` (runner ~71 MiB, with the alpine `libquery_engine-linux-musl-openssl-3.0.x.so.node` confirmed inside) + `docker build --target migrate` both succeed.
- **migrate image** → `prisma migrate deploy` applied all 7 migrations + seed ran. ✓
- **standalone app image** → healthy in **2s**; `GET /api/health` → **200** `{status:ok, db:ok}` (proves the standalone server serves AND the Prisma engine works in standalone AND the DB is reachable + migrated). ✓
- **CSRF login as the seeded admin → 302** (proves a real Prisma MODEL query on the `User` table works inside the standalone image, not just `SELECT 1`). ✓
- `docker compose -f docker-compose.yml config` resolves: app gets AUTH_SECRET, limits applied, migrate-completion wired, db publishes 0 ports.
- All test containers/images/network torn down.

## Notes / deviations
- Runner `COPY` uses `--chown=nextjs:nodejs` (correct mechanism to own files as the runtime user).
- **Runtime env fail-fast is lazy in standalone:** env.ts runs when prisma/auth first load (first request), not at `node server.js` boot — so a misconfigured deploy (e.g. missing AUTH_SECRET) surfaces as a failing first request rather than an instant boot crash. The compose **healthcheck** (`/api/health` → loads prisma → env) turns that into an unhealthy container (→ restart), so a misconfig is still caught quickly. The compose AUTH_SECRET fix is the real remedy. (The eager runtime fail-fast itself was proven earlier via a direct import test.)
- **Least-privilege DB role deferred** (its own pass): needs careful migration-grant design (the migrate service does DDL); rushing it risks breaking migrations. The app still uses the configured DATABASE_URL role.

## Remaining (Phase 3 + roadmap)
- **Observability:** pino structured logs + request/correlation IDs + Sentry (needs an external DSN from the owner).
- **Deploy:** least-priv DB role; optionally pin image digests / add SBOM.
- **Phase 4:** tax invoice, backups/PITR, PDPA, offline/PWA, a11y. Plus carried deferred review items (Customer PII/PDPA, shift-tx race).

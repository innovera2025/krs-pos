# Phase 3 (start) REPORT — CI / quality gates (GitHub Actions)

- Date: 2026-06-21 · gap-audit root theme #5 (no testing/CI/quality gates). First slice of Phase 3; observability + deploy hardening deferred to later Phase-3 iterations.
- No app-logic change (config + one env-guard refinement).
- Status: ✅ **CI runs GREEN on GitHub** (run 27902070977, commit `d09d4a9`) — all 4 jobs pass. Verified live, not just locally.

## What was built
- **`.github/workflows/ci.yml`** — triggers on `push`→`main` + `pull_request`. Node 20 via `.nvmrc`, `npm ci`, npm cache. Four jobs:
  - **quality** — `type-check` → `build` → `vitest --coverage`.
  - **e2e** — `postgres:16` service container → `prisma migrate deploy` → `prisma db seed` → `build` → start server (poll `/login` until 200) → `playwright test` (the 14 e2e). Uploads the Playwright report on failure.
  - **docker-build** — `docker build` the production image (regression guard for the Dockerfile).
  - **gitleaks** — secret scan (gitleaks-action).
  - CI signing secrets are generated per-run via `openssl rand -hex 24` → `$GITHUB_ENV`; **no secret literal is hardcoded** in the workflow.
- **Vitest coverage** (`@vitest/coverage-v8`) with a per-file threshold on `src/lib/pricing.ts` (lines/functions ≥ 85; measured **100% / 100%**, 87% branch) so a money-math regression fails CI. `/coverage` is gitignored.
- **`src/lib/env.ts` build-phase skip** — the fail-fast now skips when `NEXT_PHASE === "phase-production-build"`. `next build` imports server modules (prisma/auth → env) for page-data collection but runs no DB query and signs no session, so it needs no runtime secrets. This:
  - fixed an env.ts-introduced **Docker build break** (the builder stage ran `next build` with no `DATABASE_URL`/`AUTH_SECRET` → env.ts threw);
  - let the **Dockerfile** drop the build-time secret placeholders (removing the `SecretsUsedInArgOrEnv` lint smell);
  - the guard still runs at real server boot (NEXT_PHASE unset/≠build), so a misconfigured **runtime** still fails fast. No fake secret literal lives in env.ts (values default to `""`).

## Verification
- **Live GH Actions run GREEN** — quality ✓ · e2e ✓ · docker-build ✓ · gitleaks ✓.
- Locally pre-confirmed: type-check, `npm test --coverage` (42/42, pricing.ts 100%), `docker build .` (clean, no secret warning, `.env` excluded via `.dockerignore`), env.ts runtime fail-fast still throws on short AUTH_SECRET / missing DATABASE_URL, gitleaks clean on tracked files (the only local findings were false positives inside the gitignored `.next/` build cache — a `jose` library `-----BEGIN PRIVATE KEY-----` validation string; never committed, never scanned by the git-aware CI job).

## Deviations / notes
- env.ts build-phase skip was a mid-task refinement (chosen over baking placeholder secrets into the Dockerfile) — cleaner + removes the secret-in-ENV smell + the gitleaks risk. It modifies Phase-1 env.ts behavior but only for the build phase; runtime validation is unchanged.
- gitleaks job is a separate job on a fresh checkout (no `.next`), so the build-cache false positives never reach it.

## Remaining (Phase 3 — next iterations)
- **Observability:** pino structured logging + request/correlation IDs + Sentry.
- **Deploy hardening:** `output:"standalone"` (smaller image) + matching Dockerfile, least-privilege DB role (drop superuser), resource limits, `prisma migrate deploy` on container startup.
- **Coverage ratchet:** raise thresholds + extend unit tests beyond `pricing.ts` as more pure logic is extracted.
- Then **Phase 4** (tax invoice, backups/PITR, PDPA, offline/PWA, a11y) + the carried deferred items (Customer PII/PDPA, shift-tx race).

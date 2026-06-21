# Phase 3 (cont.) REPORT — Observability (pino structured logs + correlation IDs)

- Date: 2026-06-21 · gap-audit root theme #4 (observability). Sentry deferred (needs the owner's DSN — out of scope this slice). No app-logic/money change.
- Design ref: research-agent design pass (decisions D1–D4, all followed; D4 adjusted toward standalone-robustness).
- Status: ✅ **type-check + build (standalone) + Vitest 42/42 + e2e 14/14 + live smoke (JSON logs, correlation ID, mutation info line) + standalone Docker image logs JSON — all verified.**

## What was built (decisions as settled)
- **`src/lib/logger.ts`** (NODE-ONLY) — pino, level from `process.env.LOG_LEVEL`/`NODE_ENV` (read directly to avoid coupling to env.ts → no import cycle), `base:{pid}`, `mixin()` pulls the active `requestId` from AsyncLocalStorage so **every line auto-includes the correlation id**. **D2 redaction:** `["*.password","*.secret","req.headers.authorization","req.headers.cookie","*.taxId","*.phone"]`.
- **`src/lib/requestContext.ts`** (NODE-ONLY) — `AsyncLocalStorage<{requestId}>` + `runWithRequestId(req, fn)` (reads `x-request-id`, else `crypto.randomUUID()`) + `getRequestId()`.
- **`src/middleware.ts`** (EDGE, auth-preserving) — wraps the NextAuth `auth((req)=>{…})` middleware to mint/propagate `x-request-id` (reuse inbound or generate), forward it to Node handlers via `NextResponse.next({request:{headers}})`, and echo it on the response. No pino/Node imports; the `authorized` redirect behavior + matcher are unchanged.
- **D1 (inline + ALS helper, NO wrapper):** all 19 handlers across 14 route files wrap their body in `runWithRequestId(req, …)` (existing logic/try-catch/error-codes/RBAC idiom untouched). All **29 server-side `console.error/warn` → `logger.error({err}, …)`/`logger.warn`** (pino `err` serializer; the 2 client-side `error.tsx` console calls left alone).
- **D3 (errors + mutations):** success **info** lines on exactly the 5 mutation routes (POST orders, PATCH orders/[id], POST shift, POST stock-movements, PATCH users/[id]) — method/path/status/durationMs only, **no bodies/amounts/emails**.
- **D4 (standalone-safe transport):** **no in-process pino transport** (a transport spawns a worker thread that breaks `output:"standalone"` tracing) — writes raw JSON to stdout in all envs. Dev pretty-printing via a `dev:pretty` script (`next dev | pino-pretty`); `pino-pretty` is a devDependency used only across that pipe. `serverExternalPackages` / Dockerfile COPY were **NOT needed** (webpack traced pino into the standalone server chunk; verified).

## Verification (orchestrator — ephemeral Postgres + live server + standalone image)
- type-check ✓ · `npm run build` → `.next/standalone/server.js` present, pino traced ✓ · Vitest **42/42** ✓.
- **Correlation ID:** `GET /api/health` response carries a generated `x-request-id`; an inbound `x-request-id: my-trace-123` is **echoed** (propagation works).
- **Structured log + correlation:** a checkout with `x-request-id: checkout-trace-1` produced exactly:
  `{"level":30,...,"requestId":"checkout-trace-1","method":"POST","path":"/api/orders","status":201,"durationMs":85,"msg":"order created"}` — JSON, correlation id threaded middleware→ALS→mixin, mutation info line, no PII.
- **Auth boundary intact:** `e2e 14/14` pass (auth-phase3 lockout/force-logout/set-password + rbac + routes + checkout) — the middleware change did not alter auth/redirect behavior.
- **pino in the standalone production image:** built the Docker image, ran it against an ephemeral pg on a docker network → boots in 2s, `/api/health` 200, **container stdout emits pino JSON** (e.g. the env.ts `logger.warn` line) — no `MODULE_NOT_FOUND`/worker issue. All smoke containers/images/network/server torn down.

## Notes / deviations
- **No import cycle:** logger reads `process.env` directly (not the validated `env` module), so `env.ts → logger` is one-way (env.ts's prod-AUTH_URL warn now goes through pino). Verified.
- pino's `*.` redaction wildcard matches one nesting level, so a *top-level* `password`/`taxId`/`phone` key wouldn't be redacted — matches the settled D2 paths, and the code never logs request bodies/PII, so it's latent defense only.
- Runtime correlation ID travels via the `x-request-id` **header** (not ALS seeded in middleware) — a known Next 14 edge→Node ALS limitation; the header is the supported channel.

## Remaining (Phase 3 + roadmap)
- **Sentry** (error tracking) — needs the owner's DSN; then a thin Node-only Sentry init + capture in the logger/error paths.
- **Least-priv DB role** (deferred infra item).
- Optionally bridge Prisma's `$on('query'|'error')` events into pino; ratchet Vitest coverage beyond pricing.ts.
- **Phase 4:** tax invoice, backups/PITR, PDPA, offline/PWA, a11y; + carried deferred review items (Customer PII/PDPA scoping, shift-tx race, idempotency body-match).

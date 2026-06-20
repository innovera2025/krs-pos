# krs-pos — All Tests

Last updated: 2026-06-20 (synced to P6b state)

Attach this file first when the task involves testing, verification, or test debugging.

> **Important:** this project currently has **no automated test runner and no test files.**
> "Verification" today means typecheck + build + manual live-smoke against an ephemeral Postgres.
> This file documents the real verification path and the gap to close.

---

## What This Covers

- how to verify a change today (no test suite exists)
- the exact commands available
- the ephemeral-Postgres live-smoke pattern used in phase execution
- what's missing and the recommended way to add tests

## Read This When

- you finished an implementation and need to verify it
- you are deciding how to prove a change is correct
- you are about to add the first real tests

## Quick Decision Guide

There is **no `test` script and no test runner** (`vitest`/`jest`/`playwright` are not installed).
Until a runner is added, verify in this order:

1. **Typecheck** — `npm run type-check` (`tsc --noEmit`). Fastest correctness signal; the codebase is strict.
2. **Lint** — *not wired up yet.* `next lint` has **no ESLint config or dependency**, so the first
   run launches an interactive "configure ESLint?" prompt (and fails in CI/non-interactive shells).
   Add `eslint` + `eslint-config-next` + a config before relying on it; until then skip this step.
3. **Build** — `npm run build` (catches App Router / server-component issues).
4. **Manual smoke** — start Postgres + dev server (or `next start`), exercise the POS flow and APIs
   (see ephemeral-Postgres pattern below).

## Default Verification Order

Unless the task clearly needs a different path: **typecheck → build → live smoke** (lint is not
wired up yet — see above). Prefer the narrowest signal that can fail (typecheck) before the
slowest (build/manual).

## Commands

| Purpose | Command | Notes |
|---|---|---|
| Typecheck | `npm run type-check` | `tsc --noEmit`, strict mode |
| Lint | `npm run lint` | `next lint` — **not configured** (no ESLint config/dep; triggers interactive setup on first run) |
| Build | `npm run build` | full Next.js production build |
| Dev server | `npm run dev` | http://localhost:3000 |
| Generate Prisma client | `npm run prisma:generate` | required after schema edits |
| Push schema to DB | `npm run db:push` | dev convenience (no migration history) |
| Migrate (dev) | `npm run prisma:migrate` | `prisma migrate dev` — creates/applies a tracked migration |
| Migrate (prod/CI) | `npx prisma migrate deploy` | applies pending migrations without interactive prompts |
| Seed sample data | `npm run prisma:seed` | runs `prisma/seed.ts` via tsx |

## Ephemeral-Postgres Live-Smoke Pattern

Phase execution (P3–P6b) verified against a real ephemeral Postgres to catch DB-level issues
(transaction behavior, enum coercion, migration applicability) that typecheck/build cannot catch.

**Standard ephemeral smoke loop:**

```bash
# 1. Bring up a throwaway Postgres (loopback port, e.g. 5433 to avoid conflicts)
docker run -d --name krs-smoke -e POSTGRES_USER=krs_app -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=krs_pos \
  -p 5433:5432 postgres:16-alpine

# 2. Point the app at it
DATABASE_URL=postgresql://krs_app:smoke@localhost:5433/krs_pos?schema=public

# 3. Apply tracked migrations (NOT db:push — verifies migration history)
npx prisma migrate deploy

# 4. Seed
npm run prisma:seed

# 5. Start the server (next start for a production-equivalent build, or npm run dev)
npm run build && npm start   # or: npm run dev

# 6. Exercise relevant APIs + pages via curl / browser

# 7. Tear down
docker stop krs-smoke && docker rm krs-smoke
```

Key points:
- Use `prisma migrate deploy` (not `migrate dev` or `db push`) in the smoke to verify that all
  tracked migrations in `prisma/migrations/` apply cleanly to a fresh DB.
- Run the seed after migrations to exercise seed idempotency (upserts).
- Tear down the ephemeral container after smoke so `.env` and the real DB remain untouched.
- 4 tracked migrations currently exist — see `process/context/database/all-database.md` for the list.

## Debugging Quick Reference

- **A database is required** for anything touching `/api/*` or data-fetching pages — without a
  reachable `DATABASE_URL`, fetches fail and UI shows the Thai "load failed" message.
- After editing `prisma/schema.prisma`, re-run `npm run prisma:generate` or the Prisma client
  types go stale.
- The app reads `DATABASE_URL` from `.env` (copy from `.env.example`).
- `npm run build` can surface server/client boundary errors that typecheck alone misses.
- **Money aggregates must scope to `status: "COMPLETED"`** — summing REFUNDED/VOIDED orders into
  totals is a real bug class that appeared in Phase 5 (Z-report by-payment-method). Any new
  aggregate query must explicitly filter to COMPLETED-only orders.

## Known Gaps

- **No unit, integration, or e2e tests exist** — the highest-value gap in the repo.
- Highest-risk areas that deserve the first tests when a runner is added:
  - checkout money math + stock decrement transaction (`src/app/api/orders/route.ts`)
  - Z-report aggregates — COMPLETED-only status scope, by-payment-method reconciliation
  - refund/void domain rules (`INVALID_STATE 409`, `VOID_SYNCED_LOCKED 409`)
  - shift lifecycle (open/close, 409 SHIFT_ALREADY_OPEN / NO_OPEN_SHIFT)
  - integer-satang pricing invariants (`lib/pricing.ts` — subtotal − discount === total)
  - stock-can-go-negative and unvalidated-quantity behavior
- Recommended setup when adding tests: **Vitest** for unit/route logic, **Playwright** for the
  checkout e2e flow. Add the `test` scripts and a routing entry here once they exist.

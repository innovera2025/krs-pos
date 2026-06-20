# krs-pos — All Tests

Last updated: 2026-06-20

Attach this file first when the task involves testing, verification, or test debugging.

> **Important:** this project currently has **no automated test runner and no test files.**
> "Verification" today means typecheck + lint + build + manual smoke against a running database.
> This file documents the real verification path and the gap to close.

---

## What This Covers

- how to verify a change today (no test suite exists)
- the exact commands available
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
4. **Manual smoke** — start Postgres + dev server, exercise the POS flow and the APIs (see below).

## Default Verification Order

Unless the task clearly needs a different path: typecheck → build → manual smoke (lint is not
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
| Migrate (dev) | `npm run prisma:migrate` | creates/applies a migration |
| Seed sample data | `npm run prisma:seed` | runs `prisma/seed.ts` via tsx |

**Manual smoke (needs a database):**

```bash
docker compose up -d db        # start postgres:16-alpine on :5432
cp .env.example .env           # set DATABASE_URL
npm run prisma:generate
npm run db:push
npm run prisma:seed
npm run dev                    # then exercise the POS UI + /api/products, /api/orders
```

## Debugging Quick Reference

- **A database is required** for anything touching `/api/*` or the POS page — without a reachable
  `DATABASE_URL`, the products fetch fails and the UI shows the Thai "load failed" message.
- After editing `prisma/schema.prisma`, re-run `npm run prisma:generate` or the Prisma client types go stale.
- The app reads `DATABASE_URL` from `.env` (copy from `.env.example`).
- `npm run build` can surface server/client boundary errors that typecheck alone misses
  (`src/app/page.tsx` is a client component via `"use client"`).

## Known Gaps

- **No unit, integration, or e2e tests exist** — the highest-value gap in the repo.
- Highest-risk areas that deserve the first tests when a runner is added:
  - checkout money math + stock decrement transaction (`src/app/api/orders/route.ts`)
  - stock-can-go-negative and unvalidated-quantity behavior
  - product search/filter and cart quantity logic (`src/app/page.tsx`)
- Recommended setup when adding tests: **Vitest** for unit/route logic, **Playwright** for the
  checkout e2e flow. Add the `test` scripts and a routing entry here once they exist.

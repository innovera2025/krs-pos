# Performance Optimization — REPORT

- Date: 2026-06-22 · Trigger: owner reported perceived UI lag ("perfamance ดูหน่วงช้า"). Diagnosis first, then four targeted optimizations.
- Status: ✅ **type-check + isolated production build + e2e 14/14 (incl. the reworked force-logout test) + index migration applied/verified on ephemeral Postgres + auth security review (no exploitable findings, 1 LOW hardening applied) — all verified.**
- Migration: **#10** `20260622061929_perf_order_indexes` (additive `CREATE INDEX` only — no data/schema-shape change).

## Diagnosis (why it felt slow)
Measured the owner's live dev server (curl timing): cold-vs-warm showed the lag was dominated by **Next.js dev-mode on-demand compilation** (cold 0.3–1.2s, warm 27–41ms). That is a dev-only artifact (production `next start` serves the warm path). Beyond it, four real code/DB hotspots were worth fixing for production scale + DB load — implemented below. **The optimizations are a scale/load improvement, not the fix for the perceived dev lag** (which disappears in a production build).

## What changed (decisions = the four hotspots)

### #1 — Throttle the per-request auth DB read (`src/auth.ts`) — the prime hotspot
The Auth.js `jwt` callback re-read the user (`isActive`/`role`/`tokenVersion`) from the DB on **every authenticated request**. Now THROTTLED to once per `SESSION_REVALIDATE_MS` (**10s**, owner-chosen), caching the last-known role/tokenVersion on the (signed) token between checks. Sign-in still validates immediately (`authorize()` already checked liveness) and stamps `lastCheckedAt`; a hard sign-out is still instant.
- **Tradeoff (owner-decided):** a server-initiated revocation — **deactivation, force-logout (tokenVersion bump), role demotion** — now propagates within **up to ~10s** instead of instantly, in exchange for removing a DB round-trip from every request. The 10s window was chosen over 30s (max savings) and "keep instant" (revert) as the balance.
- **Robustness (security-review LOW, applied):** `due` also fires when the wall clock jumps **backward** (`now < last`, e.g. NTP/VM migration) so a backward clock can't defer the re-check past the window. `now` is captured once and reused for the compare + re-stamp (monotonic-consistent).
- Type: `src/types/next-auth.d.ts` JWT augmentation gains `lastCheckedAt?: number` (in the `@auth/core/jwt` module).

### #2 — Batch the /sales mount fetches (`src/app/(shell)/sales/page.tsx`)
The three mount fetches (orders / seller-config / settings) are now issued from one `Promise.all`. **Behavior-preserving:** orders alone drives `loadState`; seller-config + settings stay best-effort (a failure leaves their state null, never flips loadState, never rejects). Deliberately **not** changed: `take`/includes/pagination — the loaded order objects are reused by the detail drawer + reprint + tax-invoice and client-side search filters the full set, so narrowing them would regress those. The orders-query scaling win comes from #4 instead.

### #3 — Gate the NavRail failed-count fetch to admins (`src/components/NavRail.tsx`)
The red failed-job badge only ever renders on the admin-only `data` nav item, yet `/api/sync-jobs/failed-count` was fetched on mount for **every** user (sellers included — a wasted request, likely a 401). Now gated behind `canAccess("data", role)`; a seller fires neither the fetch nor the `krs:sync-jobs-changed` listener. The endpoint keeps its own `requireUser` server guard (the gate is pure client UX/perf). Verified the event source (`DataFlowTab`) is itself admin-only, so the gate drops nothing a seller would receive.

### #4 — Add Order indexes (`prisma/schema.prisma` + migration #10)
`Order` had no index on `createdAt` (the GET /api/orders default `orderBy` + Sales History), nor on `status`/`shiftId`. Added `@@index([createdAt])`, `@@index([status, createdAt])` (filter+sort), `@@index([shiftId])` (Z-report per-shift aggregate; Postgres does not auto-index FKs). Additive `CREATE INDEX` only.

## Verification (orchestrator — isolated, dev server untouched)
All verification ran in an **isolated git worktree** (own `.next`) + an **ephemeral Postgres on :5455**, so the owner's running `npm run dev` on :3000 and its dev DB on :5432 were never touched (the `.next`-clobber lesson).
- `npm run type-check`: pass (after every edit).
- **Production build** (in the worktree): pass — all routes compiled.
- **Migration:** `prisma migrate dev` generated #10; the SQL is exactly the 3 `CREATE INDEX`; confirmed present in `pg_indexes`. Seed idempotent (6 orders / 17 products / 3 users / 1 settings).
- **e2e 14/14** against the worktree build on :3100: checkout, RBAC (seller scope both directions), all route smokes, lockout, set-password, and the **force-logout** test — reworked to assert revocation **within the window** (`expect.poll`, 15s, under a 45s per-test timeout); it passed at 12.7s (waited out the ~10s window then got 401), proving both that valid sessions keep working in-window AND that force-logout still revokes.
- **Security review (auth surface):** no confirmed exploitable findings. Token fields are not client-controllable (signed/encrypted JWT); the re-stamp is strictly downstream of a successful DB validation (no "window never elapses" path); role-demotion refreshes ≤10s; NavRail gate + Promise.all + indexes clean. One LOW (backward-clock) applied above; one LOW (refresh `token.id` on due path) is a no-op today (id immutable) — no action.

## Notes / deviations
- e2e file `tests/e2e/auth-phase3.spec.ts` was updated (not just app code): the force-logout test's immediate-revocation assertion became a bounded poll, matching the new ≤10s contract. This is the only test that assumed instant revocation; the others exercise the `authorize()` path (unaffected).
- `process/context/tests/all-tests.md` is stale (says "no test runner") — vitest + playwright + a 14-test e2e suite now exist. Worth a context refresh (not done here).

## Remaining / not in scope
- Optional future #2 win: narrow the `Order.items.product` include to the fields the UI reads (would change OrderDTO + the serializer — deferred; not worth the churn vs the money-adjacent serializer risk at current scale).
- Owner action: migration #10 should be applied to the dev DB + any prod (`npx prisma migrate deploy`) so the schema matches (verified only on the ephemeral DB here; the dev DB on :5432 was intentionally left untouched).

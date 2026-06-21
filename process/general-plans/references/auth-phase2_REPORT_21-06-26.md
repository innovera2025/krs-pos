# Auth Phase 2 REPORT — server RBAC on remaining APIs + login rate-limit

- Date: 2026-06-21 · Research: `auth-phase2_RESEARCH_21-06-26.md` · follows Auth Phase 1 (committed+pushed).
- Approved: full RBAC matrix; **refund/void = admin-only** (per-action); failed-count = requireUser; **rate-limit 15/10min, key ip:email, distinct message**.
- Status: ✅ **type-check + build + multi-role live smoke (admin/seller/unauth) + rate-limit smoke + Playwright e2e 11/11 + 2-dim adversarial security review (1 LOW found+fixed) — all verified.** No schema/migration/deps.

## What was built
**RBAC guards** (using Phase-1 `requireUser`/`requireAdmin`; MANAGER=admin):
- **admin-only:** `POST /api/products`, `PATCH /api/products/[id]`, `POST /api/stock-movements`, `/api/sync-jobs` GET+POST, `PATCH /api/sync-jobs/[id]`.
- **any-authenticated (requireUser):** `GET /api/products`, `GET /api/customers`, `/api/shift` GET+POST, `GET /api/sync-jobs/failed-count` (cashiers need these for POS — deliberately not admin).
- **`PATCH /api/orders/[id]` per-action:** requireUser at top; **refund + void → also require admin (403 for cashier)**; **request-tax → requireUser** (cashiers may request tax invoices). Domain rules (COMPLETED / VOID_SYNCED_LOCKED / TAX_REQUIRES_TAX_CUSTOMER / no-DELETE) intact.
- Unauth (no session) → 401 on all. Replaced the now-satisfied `// RBAC not enforced` TODOs (kept idempotency/Decimal/audit TODOs).

**Login rate-limit:** new `src/lib/rateLimit.ts` — in-memory fixed-window `Map`, key `ip:email` (x-forwarded-for first hop, fallback "unknown"), **15 attempts / 10 min**, capped/cleaned; exports isRateLimited/recordFailure/clearAttempts. Hooked in `src/auth.ts` `authorize`: short-circuit BEFORE DB+bcrypt when limited; count failures only; clear on success; DUMMY_HASH constant-time path preserved. Login page shows a distinct "พยายามเข้าสู่ระบบมากเกินไป ลองใหม่ภายหลัง · Too many attempts" message.

## Verification (orchestrator, independent)
- `npm run type-check` ✅ · `npm run build` ✅ (no schema/deps).
- **Multi-role live smoke** (ephemeral DB; admin + seller.aroon sessions via Auth.js CSRF flow):
  - requireUser routes (products GET, customers GET, shift GET, failed-count): **admin 200 / seller 200** (seller POS intact).
  - admin-only (sync-jobs GET, products POST, stock-movements POST): **admin 200/400-validation / seller 403**.
  - `PATCH /api/orders/[id]` void: **admin 200 / seller 403** (per-action refund/void admin-only works).
  - unauth → **401**.
- **Rate-limit smoke:** 15 wrong attempts (same ip:email) → `code=credentials`; **attempt 16–17 → `code=RATE_LIMITED`** (throttle + distinct message confirmed).
- **Playwright e2e: 11/11 PASS** (8-route smoke + checkout + new `rbac.spec.ts` seller-scope: seller CAN POS read APIs, CANNOT admin APIs / void).
- Ephemeral DB + server torn down; `.env` untouched. (No dev-DB re-seed needed — Phase 2 changed no users/passwords.)

## Adversarial security review (2-dim) — 1 LOW found + fixed
- **LOW** — rate-limit lockout MESSAGE never showed: `new CredentialsSignin("RATE_LIMITED")` doesn't set `.code` in Auth.js v5 (constructor force-sets `.code="credentials"` after super()), so the login page's RATE_LIMITED branch was dead — user saw the generic "invalid credentials". **The throttle itself worked** (isRateLimited short-circuits before bcrypt; no security impact). **Fix:** assign `.code = "RATE_LIMITED"` AFTER constructing CredentialsSignin (overrides). Re-verified: attempts 16–17 now surface `code=RATE_LIMITED`.
- RBAC matrix dimension: **0 findings** (matrix correct; no over/under-gating; seller-POS intact; per-action orders gate correct).

## Deviations / notes
- The first e2e run showed 11/11 fail due to the known `.next` race (a concurrent review-agent build corrupted the running server's chunks mid-run → MODULE_NOT_FOUND → all page loads timed out). Re-run after the review finished + a clean rebuild → 11/11 pass. Not an app defect.
- refund/void = admin-only (owner decision, stricter than the research's requireUser lean — conservative for money-out); request-tax stays cashier-accessible.

## Remaining (Auth Phase 3 + other production-readiness)
- **Phase 3:** account lockout (failed-attempt counter + lockedUntil persisted), audit log (login/logout/fail/refund/void), admin session list/terminate, CSRF review, set-password-on-first-login for admin-created users (placeholder, can't log in), Redis rate-limit for multi-instance.
- Separate production-readiness: Decimal end-to-end, idempotency keys, atomic stock, real KRS transport, Zod, ESLint/CI.

## User action (host dev)
Restart `npm run dev` to pick up the Phase-2 guards + rate-limit (new `rateLimit.ts` + `auth.ts` change). No DB change. Cashiers (seller.aroon) can sell/refund-request/shift but get 403 on admin APIs + refund/void.

# Auth Phase 3 REPORT — account lockout · audit log · force-logout · set-password

- Date: 2026-06-21 · Research: `auth-phase3_RESEARCH_21-06-26.md` · follows Auth P1 (login/session/bcrypt/middleware) + P2 (RBAC matrix + in-memory rate-limit).
- Approved decisions: **3A + 3B** in one phase · lockout **10 fails / 15-min auto-expire + admin unlock** · set-password = **admin sets real password at create (Option 1)** · force-logout-all via **tokenVersion** · audit = **table + `GET /api/audit-logs` API** (no UI screen) · full event list incl. ORDER_REFUNDED/VOIDED.
- **Migration #5** (first auth migration; P1/P2 had none): `20260621061255_phase3_auth_lockout_audit`.
- Status: ✅ **type-check + build + Playwright e2e 14/14 + multi-path live smoke (lockout / force-logout / set-password / audit / inactive-no-self-lock / void-audit) + 3-dim adversarial review (3 findings, all fixed AND re-verified live) — all green.** Migration applied to the dev DB.

## What was built
**(a) Account lockout (persistent, DB-backed).** `User += failedLoginAttempts Int @default(0)`, `lockedUntil DateTime?`. In `src/auth.ts authorize`: bcrypt always runs (DUMMY_HASH on unknown email — no enumeration timing oracle); a still-locked account is rejected with a distinct `ACCOUNT_LOCKED` code; each real password failure for an existing user **increments the counter (awaited — see FIX C below)** and at the 10th sets `lockedUntil = now + 15min`; a successful sign-in resets the counter. Complements the P2 in-memory ip:email rate-limit (15/10min, burst) — both can fire; the in-memory limiter short-circuits pre-DB, the lockout is post-DB and per-account.

**(b) Audit log (append-only, best-effort).** New `AuditLog` model (`actorId?/actorEmail?/action enum/targetType?/targetId?/ip?/detail?/createdAt`, `@@index([action,createdAt])` + `[actorId,createdAt]`) + `AuditAction` enum (LOGIN_SUCCESS/FAILURE/RATE_LIMITED, ACCOUNT_LOCKED/UNLOCKED, LOGOUT, PASSWORD_CHANGED, USER_CREATED/DEACTIVATED/ACTIVATED, ORDER_REFUNDED/VOIDED, SESSION_REVOKED). New `src/lib/auditLog.ts` `logAudit()` is **best-effort** (`prisma.auditLog.create(...).catch(console.error)`; never throws; never inside a `$transaction`). Writes wired into login (authorize), `events.signOut` (logout), orders/[id] (refund/void — money), users routes (create/deactivate/activate/password/forceLogout/unlock). Admin read: `GET /api/audit-logs` (requireAdmin, `?action`/`?actorId` filters).

**(c) Force-logout-all (JWT-compatible).** `User += tokenVersion Int @default(0)`, stamped onto the JWT at sign-in and re-checked in the existing per-request `jwt` callback DB read (no extra query): a stale version invalidates the token like an inactive user. Admin action `PATCH /api/users/[id] {action:"forceLogout"}` bumps `tokenVersion` → every existing JWT for that user is rejected on its next **API** request. `tokenVersion` added to `src/types/next-auth.d.ts`. (Individual device-session listing isn't feasible with JWT → deferred.)

**(d) Set-password (Option 1).** `POST /api/users` now accepts `password` (min 8, `BAD_PASSWORD`), bcrypt-hashes it, and the old `placeholderPassword()` is **removed** (this fixes the real P1/P2 bug where admin-created users could never log in). `PATCH /api/users/[id] {password}` = admin reset. UI: `AddUserModal` gains a password field; the Users screen gains reset-password / force-logout / unlock actions + a "locked" badge. Reactivating a user (`{isActive:true}`) also clears `failedLoginAttempts`/`lockedUntil` (FIX B).

## Schema / migration
Migration #5 `20260621061255_phase3_auth_lockout_audit`: adds the 3 `User` columns (all defaulted/nullable — non-destructive), the `AuditLog` table + 2 indexes, and the `AuditAction` enum. Seed unchanged (defaults cover existing rows). `PATCH /api/users/[id]` is now multi-variant: `{isActive}` | `{password}` | `{action:"forceLogout"}` | `{action:"unlock"}`. Applied to the dev DB via `prisma migrate deploy` (existing users keep their P1 bcrypt passwords + get the new defaults).

## Verification (orchestrator, independent)
- `npm run type-check` ✅ · `npm run build` ✅.
- **Playwright e2e: 14/14** (11 existing route/checkout/rbac + 3 new `auth-phase3.spec.ts`: lockout→unlock→login, force-logout, set-password create+reset). Each isolated test user has a unique email so the seeded admin is never touched.
- **Live smoke** (ephemeral Postgres + `next start`, CSRF-aware Auth.js curl):
  - **Lockout:** 10 wrong attempts increment the DB counter 1→10; the 10th sets `lockedUntil`; the 11th attempt **with the correct password** → `code=ACCOUNT_LOCKED` (DB still locked); admin `{action:"unlock"}` → 200 → correct password logs in again.
  - **Force-logout:** authenticated API 200 → admin `{action:"forceLogout"}` (200) → same session's next API call → **401** (jwt callback sees the stale tokenVersion).
  - **Set-password:** admin-create with `password` → 201 (no hash leaked); the user logs in; create without `password` → 400; admin `{password}` reset → old password rejected / new accepted.
  - **Inactive no self-lock (FIX B):** inactive `seller.malee` + the CORRECT password ×5 → generic reject, counter stays `0|null` (an unadmittable account can't self-lock or pollute the audit).
  - **Void-audit (FIX A):** voiding a ฿180 COMPLETED order zeroes the order (total 0 / VOIDED) **but** the `ORDER_VOIDED` audit row records `total:"180"` (the pre-void amount).
  - **Audit / RBAC:** rows present for all actions; `GET /api/audit-logs` admin 200 / seller 403; cashier refund/void → 403.
- Ephemeral DB + server torn down; `.env` untouched.

## Adversarial security review (3-dim) — 3 findings, all fixed AND re-verified
1. **MED — void audit logged `total:"0"`.** The void path zeroes `total` in the same `update`, and the audit read `updated.total` → every `ORDER_VOIDED` row recorded 0, destroying the money-reversal trail. **Fix A:** capture `total` in the pre-update `existing` select and log `existing.total` for void (refund still logs `updated.total`, which it doesn't zero). Re-verified live: a ฿180 void now audits `total:"180"`.
2. **LOW — inactive user could self-lock.** A correct password against an inactive account (`ok===true`, `!isActive`) is rejected, but the counter still advanced → an account that was never going to be admitted could lock itself and emit spurious `ACCOUNT_LOCKED`. **Fix B:** gate the increment on `if (user && !ok)`; reactivation also clears `failedLoginAttempts`/`lockedUntil`. Re-verified live (counter stays 0).
3. **LOW — enumeration timing oracle from the awaited counter write.** The review proposed making the lockout increment **fire-and-forget** so an existing-user failure costs the same awaited work as an unknown-email failure. **This was applied, then REVERSED during this verification** — see below.

### ⚠️ Fix C reversal (important durable note)
The review's fire-and-forget increment (Fix C) **silently broke the lockout**: the lock must be committed before the user's *next* sign-in reads it, and a non-awaited write does not guarantee read-after-write. The new e2e exposed it — under the browser's fast cadence the increments hadn't committed before the next attempt, so the account never locked (the slower curl smoke happened to pass because a `psql` probe between attempts gave the write time to land — a classic false-green).

**Decision: await the counter update** (atomic `{increment:1}` + conditional `lockedUntil`). A reliable, owner-requested security control beats a marginal, heavily-mitigated timing oracle. The residual asymmetry (one PK-indexed write on the existing-user path) is sub-millisecond, sits far below the ~tens-of-ms `bcrypt.compare` that runs **identically on both paths** (DUMMY_HASH, Fix D from P-earlier) and dominates the timing profile, and is further capped by the 15/10min ip:email rate limit. Documented inline in `src/auth.ts`. Accepted **LOW**.

## Deviations / notes
- **Force-logout is enforced at the DATA boundary, not page navigation (documented limitation).** The edge `middleware` (authConfig) is a UX gate that does **not** re-read the DB, so it can't see a bumped `tokenVersion`; the real revocation is the Node `auth()` jwt callback that 401s every API call. A force-logged-out user's static page *shell* may still render until the 12h cookie expires, but no data loads and no mutation succeeds. The Phase-3 e2e was written to assert this real boundary (API 401), not a page redirect. **Deferred enhancement:** add a server-side `auth()` gate to the `(shell)` layout for immediate redirect-on-revoke (and the same would tighten deactivation UX). The same property applies to deactivation today.
- **e2e harness determinism:** `attemptLogin` now awaits the Auth.js `callback/credentials` response before returning — without it, the next `page.goto` aborted the in-flight sign-in and under-counted the lockout loop (flaky). This was a test-only fix; the backend was already correct (curl-proven).
- refund/void remain **admin-only** (owner decision from P2, stricter than the research lean) — cashier → 403.

## Remaining (deferred — out of P3 scope)
- **Auth:** Redis rate-limit (multi-instance), individual device-session list, `mustChangePassword` forced-rotation flow, an audit-log **UI** screen, page-level redirect-on-revoke in the `(shell)` layout.
- **Other production-readiness:** Decimal/integer-satang money end-to-end, checkout idempotency keys, atomic stock decrement, real KRS transport, Zod validation, ESLint + CI.

## User action (host dev)
The Phase-3 migration is **already applied** to your dev DB (`krs-pos-db` on 127.0.0.1:5432). Just **restart `npm run dev`** to pick up the new `auth.ts` / routes / UI. No reseed needed. Existing logins are unchanged; admin can now set a real password when creating a user, reset passwords, force-logout, and unlock locked accounts, and `/api/audit-logs` records security + money events.

# Auth Phase 3 Research — hardening (lockout, audit log, force-logout, set-password)

- Date: 2026-06-21 · follows Auth P1 (login/session/bcrypt/middleware) + P2 (RBAC matrix + in-memory rate-limit). JWT sessions; jwt callback already re-reads user (isActive/role) from DB each request. Admin-created users get a **placeholder password → cannot log in** (a correctness bug to fix).
- **Migration #5** (first auth migration; P1/P2 had none).

## Candidate scope → recommendation
- (a) **account lockout (persistent)** — IN
- (b) **audit log** — IN
- (c) **session mgmt / force-logout** — IN as **force-logout-all via tokenVersion** (JWT can't list individual device sessions without a Session table → that's DEFERRED)
- (d) **set-password-on-first-login** — IN (fix the can't-login bug)
- (e) **Redis rate-limit** — DEFER (single-store; in-memory + persistent lockout suffice)

## Feature design
**(a) Lockout:** add `User.failedLoginAttempts Int @default(0)` + `lockedUntil DateTime?`. In `authorize` (after DB lookup + bcrypt — keep constant-time, don't short-circuit bcrypt before lock-check to avoid timing oracle): if locked & not expired → reject (run DUMMY_HASH for timing); on fail → increment, set `lockedUntil = now+15min` at threshold; on success → reset to 0/null. **Complementary** to the in-memory ip:email rate-limit (burst, per-IP, resets on restart) — both can fire; no conflict (in-memory fires first/pre-DB, lockout post-DB). Auto-expire + admin manual unlock.
**(b) Audit log:** new `AuditLog` model (`actorId?/actorEmail?/action enum/targetType?/targetId?/ip?/detail?/createdAt`, append-only, `@@index([action,createdAt desc])` + `[actorId,createdAt desc]`) + `AuditAction` enum (LOGIN_SUCCESS/FAILURE/RATE_LIMITED, ACCOUNT_LOCKED/UNLOCKED, LOGOUT, PASSWORD_CHANGED, USER_CREATED/DEACTIVATED/ACTIVATED, ORDER_REFUNDED/VOIDED, SESSION_REVOKED). Write events in authorize (login), orders/[id] (refund/void = money), users routes (create/deactivate/activate/password/unlock/force-logout), Auth.js `events.signOut` (logout). **Writes MUST be best-effort** (`prisma.auditLog.create(...).catch(...)`; NEVER inside a primary `$transaction`; never fail the primary action). New `src/lib/auditLog.ts` helper. Admin read = `GET /api/audit-logs` (requireAdmin) — UI screen optional (table+API closes the gap).
**(c) Force-logout (JWT):** add `User.tokenVersion Int @default(0)`; stamp into JWT at sign-in (extend authorize select+return + jwt `if(user)` branch) + re-check in the jwt callback's existing per-request DB read (compare token vs DB; stale → invalidate token like inactive). Admin "force logout" = `tokenVersion: {increment:1}` → all that user's JWTs invalid next request. Add `tokenVersion` to `src/types/next-auth.d.ts`. Individual device-session listing = NOT feasible w/ JWT → deferred.
**(d) Set-password (Option 1 = admin sets real password at create — recommended):** `POST /api/users` accepts `password` (min len), hashes (bcrypt 12), **remove `placeholderPassword()`**; `AddUserModal` gains a password field; `PATCH /api/users/[id]` gains admin reset-password (`{password}`) + the Users screen gets a reset action. (Option 2 = `mustChangePassword` flag + `/set-password` forced flow = more files; deferred unless chosen.)

## Schema (migration #5)
`User` += `failedLoginAttempts Int @default(0)`, `lockedUntil DateTime?`, `tokenVersion Int @default(0)` (+ `mustChangePassword Boolean @default(false)` ONLY if Option 2). New `AuditLog` model + `AuditAction` enum. Seed needs no change (defaults). `PATCH /api/users/[id]` becomes multi-variant: `{isActive}` (existing) | `{password}` (reset) | `{action:"forceLogout"}` | `{action:"unlock"}`.

## Regression risks
- authorize lockout must keep constant-time (bcrypt/DUMMY_HASH before/around lock-check); don't break valid login or the existing rate-limit/RATE_LIMITED path.
- audit writes fire-and-forget (outside transactions) — must not fail refund/void/login/user-create.
- jwt callback tokenVersion check extends the EXISTING per-request DB read (no new query); Node-only (`@/auth`) — edge/middleware unaffected.
- e2e: lockout threshold (10) >> test login count; successes reset → seeded admin won't lock; existing 11 e2e stay green. New lockout/force-logout/set-password e2e use ISOLATED users (not seeded admin).

## ★ Scope + sequencing
**3A (one migration+PR):** lockout + tokenVersion force-logout + audit-log writes + admin force-logout + admin unlock actions. **3B (builds on 3A):** set-password (admin-sets at create + reset action; delete placeholderPassword). Optional `GET /api/audit-logs` API (no UI screen this phase). DEFER: Redis, device-session list, mustChangePassword flow, audit UI screen, CSRF review (Auth.js has built-in).

## Decisions (recs)
- **D1 lockout threshold:** 10 (OWASP mid; generous for shared terminal).
- **D2 lock duration:** 15 min auto-expire + admin manual unlock.
- **D3 lockout message:** distinct "บัญชีถูกล็อก/ลองใหม่ภายหลัง" (single-store, enumeration risk ~0) — or generic.
- **D4 set-password:** Option 1 (admin sets at create) — recommended.
- **D5 audit view:** table + `GET /api/audit-logs` API only (no UI screen) — recommended.
- **D6 force-logout:** tokenVersion force-logout-all (device-list deferred — JWT) — recommended.
- **D7 events:** full list in (b) incl. ORDER_REFUNDED/VOIDED (highest priority).

## Files + verify
Touch: `prisma/schema.prisma` + migration #5; `src/auth.ts` (lockout + tokenVersion + login audit + events.signOut); `src/types/next-auth.d.ts`; `src/lib/auditLog.ts` (new); `src/app/api/users/route.ts` (password on create + audit), `[id]/route.ts` (password reset / forceLogout / unlock + audit); `src/app/api/orders/[id]/route.ts` (refund/void audit); optional `src/app/api/audit-logs/route.ts`; `src/components/users/AddUserModal.tsx` + `(shell)/users/page.tsx` (password field + reset/forceLogout/unlock actions); new e2e `tests/e2e/auth-phase3.spec.ts`.
Verify: type-check + build; live — lockout after 10 fails + auto-expire/admin-unlock; tokenVersion bump → old token rejected next request; admin-create-with-password → new user logs in; admin reset → old pw rejected/new ok; audit rows for login/refund/void/user-actions; existing 11 e2e green + new phase-3 e2e.

## Readiness
**Ready to EXECUTE.** Recommend **3A + 3B** (3B fixes a real can't-login correctness bug). Decisions D1–D7 have clear recs; need go-ahead on D1–D4 mainly (D5–D7 follow recs). One migration (#5). tokenVersion = the JWT-compatible force-logout; audit = best-effort writes; set-password = admin-sets (Option 1).

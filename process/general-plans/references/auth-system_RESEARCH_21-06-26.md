# Auth System Research — real login/session/RBAC (production-readiness Phase 1)

- Date: 2026-06-21
- Context: `/login` is a UI stub; auth/session/RBAC were deferred throughout the redesign (P1–P7 done). This is the FIRST piece of the separate **production-readiness** program. **Highest-stakes surface** (cash/inventory POS).
- Stack: Next 14.2.5 (App Router) · TS strict · Prisma 5 + Postgres 16 · npm. No auth deps yet.

## 1. Current state (all stub / plaintext / client-only)
- `src/app/login/page.tsx` — full Taste UI, but `handleSubmit` = 400ms fake delay → toast → `router.push('/pos')`. No fetch, any credential passes. "DEMO" badge shown. Route is outside `(shell)` (no rail) ✓.
- `RoleProvider`/`AdminOnly`/`NavRail` — **client RBAC demo**: role in `localStorage` (`krspos.demoRole`, default admin), AdminOnly = client redirect only (URL-bypassable), NavRail has a DEMO role toggle. No server knows the role.
- `User.password` = **plaintext** column; seed: `admin@krs-pos.local`/`admin123` plaintext + 2 sellers placeholder strings. `Role{ADMIN MANAGER CASHIER}`.
- **No** `middleware.ts`, **no** session, **no** password hashing, **no** server-side RBAC. Every API route open (carries `// TODO(production-readiness): real auth/session + server RBAC`). (Good: GET /api/orders + USER_PUBLIC_SELECT already exclude `password`.)
- `POST /api/orders` takes `cashierId` from the **client body** (forgeable).
- Playwright e2e (`tests/e2e/*`) navigate protected routes **without login** (rely on RoleProvider default admin).

## 2. Target
Credentials login (email+password) → bcrypt verify + `isActive` check → server session (httpOnly cookie) → role server-side → middleware route gate + API `requireUser/requireRole` → logout. **Wire the EXISTING /login UI + replace the client role source** (don't rebuild). `cashierId` from session, not body.

## 3. ⚠️ Approach decisions (recommendation)
| # | Decision | Recommendation |
|---|---|---|
| **A** | Auth library | **hand-rolled `jose`** (Next official rec for App-Router email/password; one credential type, no OAuth → Auth.js v5 adds beta dep + Credentials=JWT-only constraint; **Lucia deprecated Mar 2025**). ~80-line `src/lib/session.ts`. |
| **B** | Session strategy | **DB sessions** (`Session` table) — server-revocable; needed so `isActive=false` (deactivate user) takes effect immediately (not after JWT expiry). 1 indexed lookup/req in API helper. |
| **C** | Password hashing | **`bcryptjs`** cost 12 (pure JS, zero native deps → Alpine Docker safe; OWASP-valid). argon2 = native-dep burden; migrate-on-login later if needed. |
| **D** | MANAGER role | **owner decision** — does MANAGER see admin screens? `NAV_ACCESS` has no MANAGER entry; `AppRole` is only admin\|seller. Must map before RBAC finalized. |
| **E** | demo toggle | **remove** RoleToggle (or gate `NODE_ENV!=='production'`); role comes from session. |
| **F** | phase-1 API scope | **orders (cashierId from session) + users (admin-only) only**; rest of APIs → phase 2. |
| **G** | **next upgrade (PREREQUISITE, not optional)** | **upgrade `next@14.2.5`→`14.2.25`** to patch **CVE-2025-29927** (middleware auth-bypass via `x-middleware-subrequest` header). Any middleware on 14.2.5 is trivially bypassable. |

## 4. ⚠️ Cross-cutting / regression risk
- **CVE-2025-29927** — must upgrade next BEFORE shipping middleware; AND middleware alone is never the only gate → API `requireUser/requireRole` is the real boundary (defense-in-depth).
- **Middleware = highest blast radius** — matcher must exclude `/login`, `/api/auth/*`, `/_next/*`, favicon (else redirect loop); include `/` redirect root.
- **Playwright e2e WILL break** — both spec files navigate protected routes with no login → add a `loginAs(page)` helper + prepend to every protected-route test. This is part of phase 1, not optional.
- **RoleProvider/AdminOnly role source change** touches every screen's nav/guard (any `useRole()` consumer).
- **`cashierId` contract change** — POST /api/orders ignores client `cashierId`, uses `session.userId`; verify in checkout e2e.

## 5. ★ Recommended phased plan (new program — store in `process/features/auth/`)
**Phase 1 (smallest secure increment):** upgrade next→14.2.25; add `jose`+`bcryptjs`(+types); `src/lib/session.ts` (create/get/delete, jose-signed token + DB Session row + isActive check) + `src/lib/auth.ts` (`requireUser`/`requireRole`); **migration #5** `Session` model; seed hashes the 3 passwords (bcrypt cost 12); `/api/auth/{login,logout,me}` route handlers (httpOnly Secure SameSite=Lax cookie); wire `/login` (real fetch + error states บัญชีถูกระงับ/อีเมลหรือรหัสผ่านไม่ถูกต้อง + `?next=`); `middleware.ts` (stateless verify, redirect to /login); replace RoleProvider role with `GET /api/auth/me` (remove DEMO toggle); NavRail logout button; `cashierId` from session in POST orders; **+ guards on /api/users (ADMIN) & /api/orders**; **update Playwright e2e (loginAs helper)**.
**Phase 2:** server-side RBAC on ALL remaining APIs (`requireRole`), MANAGER mapping, `lastLoginAt`, login rate-limit.
**Phase 3:** account lockout (failed-attempt counter + lockedUntil), audit log (login/logout/fail), admin session-list/terminate, CSRF review.

## 6. Decisions needing go-ahead
A (library), B (session), C (hashing) — recommended bundle = **jose + DB sessions + bcryptjs**. Plus D (MANAGER behavior), E (demo toggle removal), F (phase-1 API scope). G (next upgrade) is a hard prerequisite.

## 7. Files
**New:** `middleware.ts`, `src/lib/session.ts`, `src/lib/auth.ts`, `src/app/api/auth/{login,logout,me}/route.ts`. **Modified:** `package.json` (jose/bcryptjs + next 14.2.25), `prisma/schema.prisma` (`Session` model + migration #5), `prisma/seed.ts` (hash pwds), `src/app/login/page.tsx`, `src/app/api/orders/route.ts` (cashierId from session), `src/app/api/users/{route,[id]}.ts` (ADMIN guard), `RoleProvider.tsx`, `NavRail.tsx` (logout, drop toggle), `tests/e2e/*` (loginAs).
**Verify:** type-check + build + live login smoke (admin123→cookie→/pos→logout→/login; direct /products→redirect /login?next; inactive seller→ระงับ; wrong pw→error; cashierId from session) + `npm run test:e2e` (with loginAs).

## 8. Readiness + recommendation
**Ready to PLAN.** Recommended: **jose + DB sessions + bcryptjs cost 12 + hand-rolled session module + middleware (after next→14.2.25)**, phase-1 = core login/session/hashing/wire/logout/replace-client-role + orders+users guard + e2e loginAs. Phase 2 = full API RBAC + rate-limit; Phase 3 = lockout/audit. Store plan in a new `process/features/auth/` feature folder. **Hard prerequisite: upgrade Next to 14.2.25 (CVE-2025-29927) before middleware.**
Sources: Auth.js v5 docs, Next.js auth guide, Lucia deprecation, CVE-2025-29927 (NVD/Vercel/Datadog), OWASP bcrypt/argon2.

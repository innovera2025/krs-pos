# Auth System REPORT — Phase 1 (real login/session/RBAC) — production-readiness

- Date: 2026-06-21
- Research/spec: `process/general-plans/references/auth-system_RESEARCH_21-06-26.md`
- Approved: **Auth.js v5 (next-auth@beta) Credentials + JWT sessions · bcryptjs · MANAGER = admin**
- Status: ✅ **type-check + build + live login smoke + Playwright e2e (9/9) + 3-dim adversarial SECURITY review (4/4 confirmed findings fixed + re-verified) — all verified.** First piece of the deferred production-readiness program. (`/login` was a stub.)

## What was built (Auth Phase 1)
- **Next upgrade (CVE-2025-29927):** `next 14.2.5 → 14.2.35` — patches the `x-middleware-subrequest` middleware-bypass before any middleware ships.
- **Auth.js v5 config** (`src/auth.ts` Node + `src/auth.config.ts` edge-safe split + `src/types/next-auth.d.ts`): Credentials provider; `authorize` = bcrypt.compare (constant-time vs a DUMMY_HASH even for unknown email — anti-enumeration), reject wrong-pw + `isActive:false`, return only id/name/email/role (never the hash); `session.strategy:"jwt"` (12h); `jwt` callback stamps id+role at sign-in AND re-reads `isActive` from DB each request (prompt deactivation); `session` callback exposes id+role; `authorized` callback gates protected paths + admin nav via `roleAccess`.
- **Password hashing:** `bcryptjs` cost 12; seed hashes all users (admin/admin123, seller.aroon/seller123 active, seller.malee/seller123 inactive); hash on create AND update so re-seed migrates old plaintext.
- **Middleware** (`src/middleware.ts`): **edge-safe** — `NextAuth(authConfig)` (no Prisma/bcrypt in the edge bundle, verified); redirects unauth `(shell)` routes → `/login?callbackUrl=`. Matcher excludes /login, /api/auth, /_next, static.
- **Defense-in-depth API guards** (`src/lib/auth.ts` `requireUser`/`requireAdmin`): `POST /api/orders` requires a session + sets `cashierId` from `session.user.id` (ignores client body — un-forgeable); **`GET /api/orders`** requires a session (was leaking the ledger+PII); `/api/users` GET/POST + `[id]` PATCH require admin (ADMIN or MANAGER). Middleware is UX redirect only; route handlers are the real boundary (CVE lesson).
- **Real session role replaces the client demo:** `<SessionProvider>` (AuthSessionProvider) in root layout; `RoleProvider` derives role from `useSession()` (ADMIN/MANAGER→admin, CASHIER→seller via `authRole.ts`); **DEMO RoleToggle removed**; `AdminOnly` uses the real role; **NavRail logout** button → `signOut({callbackUrl:"/login"})`.
- **/login wired:** real `signIn("credentials", {redirect:false})` + error states (generic "อีเมลหรือรหัสผ่านไม่ถูกต้อง" for bad-creds AND inactive — anti-enumeration); reads `?callbackUrl`/`?next` (same-origin); DEMO badge removed.
- **env:** real `AUTH_SECRET` in git-ignored `.env`; `.env.example` documents the name (`AUTH_SECRET="CHANGE_ME"`). No schema/migration (JWT sessions need no Session table).
- **e2e:** `tests/e2e/helpers/auth.ts` `loginAs()` (exact-label password selector) + prepended to all protected-route tests; checkout logs in first.

## Verification (orchestrator, independent)
- `npm run type-check` ✅ · `npm run build` ✅ (next 14.2.35; Middleware registered; **edge bundle has no bcrypt/Prisma-engine/Node-jwt** — verified).
- **Live smoke** (ephemeral DB + `next start`): unauth `/pos..**/docs` → **307 → /login?callbackUrl**; `/login` 200 (no loop); unauth `POST /api/orders` → **401**, `GET /api/orders` → **401** (FIX A), `GET /api/users` → **401**; `/api/products` 200 (phase-2, intentionally open).
- **Negative login** (Auth.js CSRF flow): wrong pw → rejected (`?error=CredentialsSignin`, no session); **inactive seller.malee → rejected** (isActive enforced); valid admin/admin123 → success.
- **cashierId integrity:** e2e checkout order `POS-20260621-0001` cashier = admin (from session), not null/forged.
- **Playwright e2e: 9/9 PASS** (login → 8-route smoke + checkout happy-path under auth).
- Dev DB (`localhost:5432`) re-seeded with hashed passwords so host `npm run dev` login works. Ephemeral smoke torn down; `.env` untouched (real AUTH_SECRET stays local).

## Adversarial SECURITY review (3-dim workflow) — 4/4 confirmed fixed
- **HIGH** GET /api/orders unauthenticated (ledger+customer-PII leak) → added `requireUser()` gate (FIX A).
- **HIGH** middleware imported the Node `@/auth` (Prisma+bcrypt+DB jwt callback) into the **Edge** runtime → authenticated nav 500 (also the e2e failure root cause) → rewired to `NextAuth(authConfig)` edge-safe (FIX B).
- **MEDIUM** e2e `loginAs` password selector matched the show/hide toggle (strict-mode) → exact-label (FIX C).
- **LOW** `authorize` skipped bcrypt for unknown email (timing oracle) → constant-time DUMMY_HASH compare (FIX D).

## Deviations / notes
- `src/middleware.ts` (not root `middleware.ts`) — required: with `app/` under `src/`, Next only registers `src/middleware.ts`.
- Generic login error (no inactive-specific message) = intentional anti-enumeration; prompt deactivation still enforced (jwt isActive re-check at the API layer).
- Inert Prisma edge-*stub* remains in the middleware bundle via a transitive `import { Role }` value-import in `authRole.ts` (harmless — no engine/DB/bcrypt). Optional future cleanup: `import type { Role }`.

## ⚠️ User action required (host dev)
1. **Restart `npm run dev`** — new deps (next-auth, bcryptjs) + `next@14.2.35` + middleware require a fresh dev server (the running one is stale).
2. Ensure **`AUTH_SECRET`** is set in `.env` (already added). Dev DB re-seeded → log in at `/login` with **admin@krs-pos.local / admin123** (or seller.aroon@krs-pos.local / seller123).

## Remaining (production-readiness, future phases)
- **Phase 2:** server-side RBAC on ALL remaining APIs (products/shift/sync-jobs/stock-movements/customers), MANAGER specifics, `lastLoginAt`, login rate-limiting.
- **Phase 3:** account lockout (failed-attempt counter + lockedUntil), audit log (login/logout/fail), admin session list/terminate, CSRF review, set-password-on-first-login for admin-created users (currently placeholder, cannot log in).
- Other deferred production-readiness items (Decimal end-to-end, idempotency, atomic stock, real KRS transport, Zod, ESLint/CI) remain separate.
- Recommend a `process/features/auth/` folder + a phase plan if continuing.

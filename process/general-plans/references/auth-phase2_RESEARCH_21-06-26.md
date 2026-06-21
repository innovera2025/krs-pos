# Auth Phase 2 Research — server RBAC on remaining APIs + login rate-limit

- Date: 2026-06-21 · follows Auth Phase 1 (shipped+committed).
- Infra exists: `src/lib/auth.ts` `requireUser()` / `requireAdmin()` (return `{session}` or `{response}`; idiom `const g=await requireX(); if("response" in g) return g.response;`). `requireAdmin` already accepts MANAGER (authRole MANAGER→admin). No `requireRole`. Role model: admin=ADMIN+MANAGER, seller=CASHIER; NAV_ACCESS pos/sales/shift=both, products/users/data/docs=admin.
- Phase-1 already guarded: orders GET+POST (requireUser, cashierId from session), users GET/POST/[id] (requireAdmin).
- **Phase 2 = apply guards to the 12 remaining route/methods + add login rate-limit.** Mechanical but security-sensitive (correct role per route; sellers must still POS).

## ★ Per-route RBAC matrix (complete)
| Route | Method | Guard | Why |
|---|---|---|---|
| /api/products | GET | **requireUser** | cashiers need product grid for POS |
| /api/products | POST | **requireAdmin** | products = admin nav; IA c=0 |
| /api/products/[id] | PATCH | **requireAdmin** | edit product = admin |
| /api/stock-movements | POST | **requireAdmin** | receive-stock/GRN = admin (inventory) |
| /api/sync-jobs | GET | **requireAdmin** | KRS Data Link = admin |
| /api/sync-jobs | POST | **requireAdmin** | pull/insert-all = admin |
| /api/sync-jobs/[id] | PATCH | **requireAdmin** | retry/skip = admin |
| /api/sync-jobs/failed-count | GET | **requireUser** (D2) | NavRail fetches for all; data badge hidden from sellers anyway; NavRail already tolerates non-ok (`res.ok?json:null` + catch) → safe either way |
| /api/shift | GET | **requireUser** | shift = both roles (cashier closes shift) |
| /api/shift | POST | **requireUser** | both roles open/close |
| /api/customers | GET | **requireUser** | customer picker used at POS checkout by cashier (IA c=1) |
| /api/orders/[id] | PATCH (refund/void/request-tax) | **requireUser** (D1) | Sales History actions = both roles (IA c=1, FLOW_ROWS CASHIER tag); domain rules (COMPLETED/synced-lock/tax-customer) already enforce business safety |

Unauth (no cookie) → all 401. `/api/auth/[...nextauth]` stays open (Auth.js, excluded from middleware matcher). No schema change.

## Login rate-limiting
New `src/lib/rateLimit.ts` — **in-memory fixed-window counter**, key `ip:email` (`x-forwarded-for` ?? "unknown"), `MAX_ATTEMPTS=10` / `WINDOW_MS=15min`. Hook in `src/auth.ts` `authorize`: check `isRateLimited(key)` at top → if locked return null (or `throw new CredentialsSignin("RATE_LIMITED")` for a distinct message); count FAILURES only; clear on success. In-memory = per-process (fine for single-store; Redis = future/multi-instance = Phase 3). Middleware can't rate-limit (edge, no Prisma; /api/auth excluded from matcher) → authorize hook is the place.

## MANAGER
No change — authRole MANAGER→admin already flows through requireAdmin + middleware authorized. MANAGER == ADMIN everywhere in phase 2.

## Decisions (recommendations)
- **D1** orders/[id] refund/void/request-tax → **requireUser** (both roles per Simple POS) vs admin-only. Rec: requireUser.
- **D2** failed-count → **requireUser** (simpler; NavRail unaffected) vs requireAdmin (also safe). Rec: requireUser.
- **D3** rate-limit threshold → **10 attempts / 15-min window**.
- **D4** rate-limit key → **ip:email** (vs ip-only = shared-terminal lockout risk; email-only = targeted lockout).
- **D5** rate-limit response → generic (CredentialsSignin) vs **distinct "ลองใหม่ภายหลัง" message**. Rec: distinct (better UX) via `throw new CredentialsSignin("RATE_LIMITED")`.

## Files + regression + verify
**New:** `src/lib/rateLimit.ts`. **Modified:** the 10 route files above + `src/auth.ts` (rate-limit hook). No schema/deps (optional `lru-cache` vs plain Map — Map fine).
**Regression guard — SELLER must still POS:** as CASHIER (aroon): GET products/customers/shift + POST shift + POST orders + PATCH orders/[id] (refund) → **200/201**; POST products/PATCH products/stock-movements/sync-jobs(all)/users → **403**. NavRail: seller rail = pos/sales/shift only, no data badge, no console error. `auth()` adds 1 DB read (isActive) per guarded request — acceptable single-store.
**Verify:** type-check + build; live smoke as **admin** (all guarded → 200/201) AND **seller** (POS routes 200, admin routes 403) AND **unauth** (401); rate-limit smoke (11 wrong → lock; success resets); add an e2e seller-scope test (seller 403 on an admin API).

## Readiness
**Ready for EXECUTE.** Matrix complete (11/12 unambiguous; D1/D2 = the 2 with clear recs). Rate-limit = 1 new file + authorize hook. No schema/deps. Confirm D1–D5 then execute; primary risk = over-gating GET products/customers/shift (would break seller POS) — covered by the seller regression smoke.

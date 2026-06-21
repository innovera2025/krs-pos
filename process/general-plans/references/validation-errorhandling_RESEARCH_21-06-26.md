# KRS POS — Phase 1 (remaining): Input Validation + Error Handling + Env
## Research Reference Report

**Date:** 2026-06-21  
**Scope:** root themes #3 (input validation), #4 (error handling/observability), #6 (env/boot) from `process/general-plans/references/pos-security-gap-audit_20-06-26.md`  
**Status:** Research-only — no files modified

---

## 1. What Is Already Correct (Do NOT Churn)

The following routes and helpers are fully hardened. Execute must not re-implement or refactor these.

| Route / File | Evidence | Notes |
|---|---|---|
| `POST /api/orders` (`orders/route.ts:235–737`) | Full try/catch at :463; per-field typed guards; server recompute from DB prices; session-sourced cashierId; satang split-sum exact match; P2002/P2025 typed; `{error,code}` on every exit path | THE reference implementation — Zod must WRAP, not replace |
| `PATCH /api/orders/[id]` (`orders/[id]/route.ts:59–397`) | Two try/catch blocks; action enum gate; isAdminRole RBAC; state-machine pre-checks; P2025→404; domain error classes | Complete |
| `PATCH /api/products/[id]` (`products/[id]/route.ts:19–191`) | Strict `typeof` per-field; length caps (name≤200, barcode≤64); category existence pre-check; P2025→404, P2002→409 BARCODE_TAKEN | Reference for the POST create path |
| `GET /api/customers` (`customers/route.ts:23–61`) | try/catch wraps entire body :27; q trimmed; response select-narrowed to 6 safe fields | Complete |
| `GET /api/shift` + `POST /api/shift` (`shift/route.ts:162–336`) | try/catch at :166 and :247; action enum; countedCash validated BEFORE round2(); SHIFT_ALREADY_OPEN / NO_OPEN_SHIFT 409 codes | Complete except openingFloat coercion (see gaps) |
| `POST /api/sync-jobs` (`sync-jobs/route.ts:62–117`) | try/catch at :84; action enum; sanitised 500 | Complete (thin route, low surface) |
| `PATCH /api/sync-jobs/[id]` (`sync-jobs/[id]/route.ts:28–138`) | try/catch at :61; P2025→404; status gates | Complete except reason length cap (see gaps) |
| `POST /api/stock-movements` (`stock-movements/route.ts:17–101`) | try/catch at :62; P2025→404; qty integer+positive+Int4 cap; reference length≤200 | Complete |
| `GET /api/users` + `POST /api/users` (`users/route.ts:35–185`) | try/catch; P2002→409 EMAIL_TAKEN; USER_PUBLIC_SELECT (password never returned); bcrypt isolated | Complete except password max-length (see gaps) |
| `PATCH /api/users/[id]` (`users/[id]/route.ts:49–212`) | variant dispatch; per-variant isolated try/catch via handlePatchError; P2025→404 | Complete except password max-length (see gaps) |
| `GET /api/audit-logs` (`audit-logs/route.ts:18–59`) | try/catch at :42; action param → 400 BAD_ACTION on unknown (stricter than list-filter convention) | Complete except actorId length (low, see gaps) |
| `src/app/error.tsx` + `src/app/(shell)/error.tsx` | Both boundaries exist, Taste-styled, Thai copy, console.error in useEffect | Do NOT rebuild |
| `{error, code}` response shape | Consistent across ALL routes that have error handling — zero shape drift | Established contract |
| `requireUser` / `requireAdmin` idiom (`src/lib/auth.ts`) | `{session}|{response}` discriminated return; consumed uniformly on all 13 routes | Do not change |
| docker-compose.yml secrets | POSTGRES_USER/PASSWORD from env (lines 6–9); port 5432 not published; db healthcheck present | Already fixed from gap-audit |

---

## 2. Verified Gaps

### 2A — Error Handling: Missing try/catch (Bare Prisma Calls)

These are the only routes where a DB exception currently produces a raw Next.js 500 with no `{error,code}` body and no `console.error`.

| Severity | Route | Location | Blast Radius |
|---|---|---|---|
| **HIGH** | `GET /api/orders` | `orders/route.ts:79–85` — `prisma.order.findMany` + `serializeOrder` map both unguarded | Sales History page (/sales) goes blank with no typed error |
| **HIGH** | `GET /api/products` | `products/route.ts:14–19` — `prisma.product.findMany` unguarded | POS checkout grid (/pos) cannot load; cashier cannot ring up any sale |
| **HIGH** | `POST /api/products` | `products/route.ts:89–106` — `prisma.product.create` unguarded | P2002 duplicate SKU/barcode → raw 500 instead of typed 409 |
| **MEDIUM** | `GET /api/sync-jobs` | `sync-jobs/route.ts:43–48` — `prisma.syncJob.findMany` unguarded | /data KRS tab list fails silently |
| **MEDIUM** | `GET /api/sync-jobs/failed-count` | `sync-jobs/failed-count/route.ts:23–26` — `prisma.syncJob.count` unguarded | NavRail badge (fetched on every page mount) crashes for all signed-in users |

**Contradiction note:** The investigator findings for the orders route disagreed on whether `GET /api/orders` (`:67–86`) should be in scope. The prompt states "treat as REFERENCE and do not churn." Direct file read confirms `GET /api/orders` at `:79–85` has NO try/catch — the POST path below it is the reference. The GET is an anomaly and is in scope for a try/catch addition. The prompt means: do not change the POST validation logic; the GET error-handling gap is a legitimate fix.

### 2B — Input Validation Gaps

| Severity | Route | Location | Gap | Correct Pattern |
|---|---|---|---|---|
| **HIGH** | `POST /api/products` | `:62` `Number(price)` | Accepts string coercion (`"50"` → 50, `[50]` → 50). PATCH uses `typeof body.price !== "number"` (strict) | Replace `Number(price)` with `typeof price !== "number"` guard |
| **HIGH** | `POST /api/products` | `:47–57` | `name` and `sku` have no length cap. PATCH caps name at 200, barcode at 64. Inconsistency: can CREATE with 10,000-char name but not UPDATE it | Add: name ≤ 200, sku ≤ 100, barcode ≤ 64 |
| **HIGH** | `POST /api/products` | `:99–102` | `categoryId` is NOT existence-checked. PATCH pre-checks → 400 CATEGORY_NOT_FOUND. A bad categoryId may throw P2025 (unhandled) or create an orphaned record | Replicate PATCH pattern: pre-check category before create |
| **MEDIUM** | `POST /api/shift` (open) | `shift/route.ts:262–268` | `openingFloat = round2(Number(body.openingFloat ?? 0))` — NaN silently becomes 0 (round2 returns 0 for non-finite); no max-value cap (Decimal(10,2) max = 99,999,999.99). The CLOSE path correctly validates countedCash BEFORE round2 at :305–311 | Mirror the CLOSE pattern: `Number.isFinite(Number(body.openingFloat))` check before round2; add ≤ 99,999,999.99 cap |
| **MEDIUM** | `PATCH /api/sync-jobs/[id]` (skip) | `sync-jobs/[id]/route.ts:110–118` | `reason` is trimmed but has no max-length — arbitrarily long string written to SyncJob.response (TEXT column) | Add: reason ≤ 500 chars (stock-movements reference field cap is 200; 500 is generous for a human skip reason) |
| **MEDIUM** | `POST /api/users` + `PATCH /api/users/[id]` | `users/route.ts:121–130`; `users/[id]/route.ts:112–118` | Password has min-length check (≥8) but NO max-length. bcrypt silently truncates input at 72 bytes — passwords >72 chars authenticate with only first 72 bytes (silent security mis-feature). Also: very long password triggers excessive CPU at BCRYPT_COST=12 | Cap password at ≤ 72 characters; return 400 BAD_PASSWORD |
| **MEDIUM** | `GET /api/customers` | `customers/route.ts:29–36` | `q` param trimmed but no length cap — arbitrary-length ILIKE pattern sent to Postgres | Truncate or reject `q > 200 chars`; silent truncation (`q.slice(0, 200)`) acceptable for search field |
| **LOW** | `GET /api/audit-logs` | `audit-logs/route.ts:38–40` | `actorId` param: non-empty string or undefined, no format/length check. Passed as Prisma equality filter (parameterized — low injection risk, but inconsistent) | Add ≤ 40 chars check (CUID length) → 400 BAD_ACTOR_ID |
| **LOW** | `POST /api/products` | `:95–98` | `barcode` has no length cap at CREATE time (PATCH caps at 64). Can create a product with a 1,000-char barcode then cannot update it | Add barcode ≤ 64 in POST |
| **LOW** | `POST /api/users` | `users/route.ts:102–108` | `email` has no length cap. EMAIL_RE is loose (`/.+@.+\\..+/`). Very long email accepted and stored | Add email ≤ 254 (RFC 5321 max) |

### 2C — Env / Boot Gaps

| Severity | Item | Location | Gap |
|---|---|---|---|
| **HIGH** | No `src/lib/env.ts` fail-fast module | Does not exist | `DATABASE_URL`: missing → app boots successfully, fails every API call with cryptic Prisma error. `AUTH_SECRET`: missing → silent JWT error at first session access, not at boot. Neither triggers a clear startup message. No Zod in package.json (confirmed: package.json lists no `zod` in dependencies or devDependencies) |
| **MEDIUM** | No `/api/health` endpoint | Does not exist | docker-compose.yml `app` service has NO healthcheck stanza (confirmed). The `db` service does have a `pg_isready` healthcheck (lines 14–20). Docker/LB cannot distinguish a booted-but-broken app from a healthy one. No lightweight target for uptime monitors |
| **LOW** | `AUTH_TRUST_HOST` undocumented | `.env.example` | Not in .env.example. Relevant when app is behind reverse proxy without AUTH_URL. Deployment-time failure mode, not a code bug |

### 2D — Observability Deferral (Confirmed Out of Scope This Phase)

The following are confirmed present (already done) or confirmed deferred:

- **error.tsx boundaries**: BOTH `src/app/error.tsx` and `src/app/(shell)/error.tsx` exist (confirmed by file read). Thai-first, Taste-styled. Do NOT touch.
- **pino structured logging**: deferred. Rationale — single-store, single-instance, Docker-supervised deployment. console.error + `docker logs` covers current operational surface. Cross-cutting change (transport config, middleware request-ID, per-route logger injection) belongs in a dedicated observability phase.
- **Sentry / x-request-id correlation**: deferred with same rationale.
- **withErrorHandler wrapper**: deferred this phase. The 4–5 uncovered bare-Prisma routes are faster to fix with inline try/catch (4–6 lines each) than introducing a new HOC. The existing inline pattern is already consistent in the hardened routes; a wrapper adds churn risk on the reference routes (orders). Revisit after all bare calls are fixed.

---

## 3. Zod Adoption Strategy

### 3.1 Installation

Zod is NOT in package.json. It belongs in `dependencies` (not devDependencies) because `src/lib/env.ts` will run at server boot and the Dockerfile does not use `output: 'standalone'` — `node_modules` is copied as-is into the runner stage.

Confirmed: package.json line 21–29 lists no `zod`.

### 3.2 Schema Location

New directory: `src/lib/schemas/` — one file per domain:

| File | Schemas |
|---|---|
| `src/lib/schemas/product.ts` | `ProductPostBodySchema`, `ProductPatchBodySchema` |
| `src/lib/schemas/shift.ts` | `ShiftPostBodySchema` (discriminated union on action) |
| `src/lib/schemas/user.ts` | `CreateUserBodySchema`, `PatchUserBodySchema` |
| `src/lib/schemas/syncJob.ts` | `SyncJobPatchBodySchema` |
| `src/lib/schemas/order.ts` | `OrderPostBodySchema`, `OrderPatchBodySchema` — ORDER LAST, WRAP-ONLY |

`src/types/index.ts` hand-written DTOs describe the **response shape** (wire format with string money). Zod schemas describe the **request shape**. These serve different directions and coexist. No forced unification this phase.

### 3.3 safeParse→400 Pattern

```
const result = Schema.safeParse(await req.json());
if (!result.success) {
  return NextResponse.json(
    { error: "Validation failed", code: "VALIDATION", issues: result.error.issues },
    { status: 400 }
  );
}
// Build Prisma data exclusively from result.data — never spread result.data into Prisma
```

### 3.4 Orders Route: WRAP Mode

The orders POST body has two categories:
- **Shape inputs** Zod validates: `items`, `paymentLines`, `discountType`, `discountValue`, `customerId`, `taxRequested`, `idempotencyKey`
- **Fields the server intentionally ignores** (not in schema, stripped by Zod default `.strip()` mode): `subtotal`, `discount`, `tax`, `total`, `amountPaid`, `change`, `cashierId`

The satang recompute (`computeOrderTotals`), PAYMENT_MISMATCH check, and amountPaid-from-session all run AFTER Zod parse and are untouched.

Non-trivial guards that require post-parse handling rather than pure Zod schema:
- 2dp discountValue check (`Math.round(discountValue * 100) !== discountValue * 100`) — can be `.superRefine()` or remain as manual post-parse check
- paymentLines count cap (MAX_PAYMENT_LINES = 20) — `z.array().max(20)` is clean but emits a `too_big` Zod issue, not the existing `TOO_MANY_PAYMENTS`/422 code the client expects

### 3.5 Enum Guards

`isOrderStatus`, `isSyncStatus`, `isSyncJobStatus`, `isAuditAction`, `isRole` are all local to their respective route files. Two options: `z.nativeEnum(PrismaEnum)` (imports `@prisma/client` into schema files — fine server-side but adds bundle weight if schemas are shared with client components) vs `z.enum([...])` (explicit, no Prisma import in schema files). Decision is open (see section 5).

### 3.6 Migration Order (Lowest Risk First)

1. `POST /api/products` — fixes Number() coercion and length-cap inconsistencies; validates the pattern before touching more complex routes
2. `POST /api/shift` — discriminated union on action; fixes openingFloat coercion
3. `PATCH /api/sync-jobs/[id]` — adds reason max-length; validates discriminated union
4. `POST /api/sync-jobs` — simple action enum
5. `POST /api/stock-movements` — fixes Number() coercion on qty
6. `POST /api/users` — name/email/role/password with password max-length
7. `PATCH /api/users/[id]` — multi-variant discriminated union + password max-length
8. `PATCH /api/products/[id]` — already solid; migrate for schema sharing with forms
9. `PATCH /api/orders/[id]` — add Zod for action enum shape
10. `POST /api/orders` — LAST; WRAP-ONLY; keep all post-parse money/satang logic untouched

GET routes (orders, sync-jobs, customers, audit-logs, shift, failed-count) use query-param enum guards only. The current enum-guard pattern is adequate for GET params and does not require Zod.

---

## 4. Env Module Design

### 4.1 Edge Runtime Constraint (Verified)

`src/middleware.ts` runs in the Edge runtime. `src/auth.config.ts` is explicitly kept edge-safe (no Prisma/bcrypt imports). An `env.ts` module that imports Zod and validates at module load CANNOT be imported from either file.

Correct import chain: `env.ts` → `src/lib/prisma.ts` (one import line) + `src/auth.ts` (one import line). These are both Node-only server modules already. Middleware and auth.config.ts must NOT import env.ts.

### 4.2 Variables to Validate

| Variable | Source | Required | Validation |
|---|---|---|---|
| `DATABASE_URL` | `prisma/schema.prisma:10` (Prisma reads) | REQUIRED | non-empty string; starts with `postgres://` or `postgresql://` |
| `AUTH_SECRET` | Auth.js internal (implicit) | REQUIRED | non-empty string; length ≥ 16 |
| `NODE_ENV` | `src/lib/prisma.ts:10,13` | optional | enum `['development','test','production']`, default `'development'` |
| `POSTGRES_USER/PASSWORD/DB` | `docker-compose.yml` only | NOT app vars | Do not validate in env.ts — compose-internal |
| `AUTH_URL` | Auth.js internal | optional | documented in .env.example as commented-out |
| `AUTH_TRUST_HOST` | Auth.js internal | not used | Not in codebase; .env.example comment addition only |

### 4.3 Health Endpoint

New file: `src/app/api/health/route.ts`

- No auth gate (convention: public; an attacker learns nothing from `db: ok`)
- `GET`: runs `prisma.$queryRaw\`SELECT 1\`` (uses Prisma — consistent with codebase; tests the actual connection pool)
- Returns `{ status: 'ok', db: 'ok', timestamp }` with 200, or `{ status: 'error', db: 'unreachable' }` with 503 on catch

docker-compose.yml `app` service: add healthcheck stanza (curl-based, targeting `/api/health`, start_period ≥ 20s to allow Next.js startup).

---

## 5. Per-Route Validation and Error-Handling Summary Table

| Route | Auth | JSON parse guard | Body validation | try/catch | P-code mapping | Status |
|---|---|---|---|---|---|---|
| `GET /api/orders` | requireUser | n/a | enum guards (ignore-unknown) | **MISSING** (findMany+map) | n/a | **GAP** |
| `POST /api/orders` | requireUser | yes | full multi-stage + server recompute | yes | P2002→200/409; P2025 | **REFERENCE** |
| `PATCH /api/orders/[id]` | requireUser + isAdminRole | yes | action enum; param id nonempty | yes (2 blocks) | P2025→404 | Complete |
| `GET /api/products` | requireUser | n/a | none needed | **MISSING** (findMany) | n/a | **GAP** |
| `POST /api/products` | requireAdmin | yes | name/sku/price/stock present-string; price via Number() coercion | **MISSING** (create) | none | **3 GAPS**: coercion, length-caps, no try/catch, no P2002 |
| `PATCH /api/products/[id]` | requireAdmin | yes | strict typeof; length caps; category pre-check | yes | P2025→404, P2002→409 | Complete |
| `GET /api/customers` | requireUser | n/a | q trimmed (no length cap) | yes | n/a | MINOR GAP (q length) |
| `GET /api/shift` | requireUser | n/a | none needed | yes | n/a | Complete |
| `POST /api/shift` | requireUser | yes | action enum; openingFloat via Number() coercion + round2 (NaN→0 silent) | yes | n/a | GAP (openingFloat coercion) |
| `GET /api/sync-jobs` | requireAdmin | n/a | isSyncJobStatus (ignore-unknown) | **MISSING** (findMany) | n/a | **GAP** |
| `POST /api/sync-jobs` | requireAdmin | yes | action enum | yes | n/a | Complete |
| `PATCH /api/sync-jobs/[id]` | requireAdmin | yes | action enum; id nonempty; reason trimmed (no length cap) | yes | P2025→404 | MINOR GAP (reason length) |
| `GET /api/sync-jobs/failed-count` | requireUser | n/a | none needed | **MISSING** (count) | n/a | **GAP** |
| `POST /api/stock-movements` | requireAdmin | yes | productId string; qty Number() coercion + isInteger; reference≤200 | yes | P2025→404 | Complete (Number() coercion acceptable here — isInteger guard is sufficient) |
| `GET /api/users` | requireAdmin | n/a | none needed | yes | n/a | Complete |
| `POST /api/users` | requireAdmin | yes | name≤200; email regex (no length cap); isRole; password≥8 (no max cap) | yes (bcrypt + create separately) | P2002→409 | GAPS (email length, password max) |
| `PATCH /api/users/[id]` | requireAdmin | yes | variant dispatch; password≥8 (no max cap) | yes per-variant | P2025→404 | GAP (password max) |
| `GET /api/audit-logs` | requireAdmin | n/a | action→400 BAD_ACTION (stricter); actorId nonempty (no length) | yes | n/a | MINOR GAP (actorId length) |

---

## 6. Unresolved Questions (For Owner Decisions)

1. **Zod enum strategy**: `z.nativeEnum(PrismaEnum)` imports `@prisma/client` into schema files (fine server-side; adds bundle weight if schemas ever reach client components) vs `z.enum([...])` (explicit, no Prisma in schema files). Client reuse of schemas is planned for product-create and user-create forms.

2. **orders POST 2dp guard placement**: keep `Math.round(discountValue * 100) !== discountValue * 100` as a manual post-parse check (easier to comment in Thai) vs move to `z.number().superRefine(...)` (single source of truth in schema). Both are correct.

3. **orders POST paymentLines count cap**: `z.array(PaymentLineSchema).max(20)` (clean, but emits `too_big`/400 Zod issue) vs keep as manual post-parse check with existing `TOO_MANY_PAYMENTS`/422 code. The 422 vs 400 distinction may matter to the client form.

4. **q length in GET /api/customers**: silent truncation `q.slice(0, 200)` (more user-friendly, search field convention) vs return 400 BAD_QUERY (consistent with validation pattern everywhere else).

5. **GET /api/orders try/catch scope**: outer try/catch sufficient (catches both findMany and serializeOrder map failures as one INTERNAL 500) vs per-item failsafe (catches individual serializeOrder errors, returns partial list). Partial-list behavior adds complexity; a single outer catch is the pattern used in all other list GETs.

---

## 7. Scope Boundaries

**In scope this phase:**
- Fix 5 bare-Prisma call sites with inline try/catch (GET orders, GET products, POST products create, GET sync-jobs, GET sync-jobs/failed-count)
- Fix POST products validation gaps (coercion, length caps, categoryId existence check, P2002 mapping)
- Fix POST shift openingFloat coercion
- Fix reason length cap in PATCH sync-jobs/[id]
- Fix password max-length cap in POST users + PATCH users/[id]
- Add q length cap in GET customers (silent truncation preferred for search UX)
- Add `zod` to dependencies; create `src/lib/schemas/` directory; apply Zod to routes in migration order above
- Create `src/lib/env.ts` (Node-only; import from prisma.ts + auth.ts)
- Create `src/app/api/health/route.ts` + add app-service healthcheck to docker-compose.yml

**Explicitly out of scope this phase:**
- Structured logging (pino), Sentry, x-request-id — deferred to observability phase
- withErrorHandler HOC — deferred (inline fixes first, wrapper later)
- `output: 'standalone'` in next.config.mjs — orthogonal; deferred
- Auth.js, RBAC, rate-limit, lockout — already done (P2)
- Financial-correctness money/satang logic — already done (prior phase)
- bcrypt low-severity: actorId length in GET audit-logs, email length in POST users — low priority, include only if Zod migration covers those routes anyway
- docker-compose AUTH_SECRET env passthrough — not currently wired; low priority
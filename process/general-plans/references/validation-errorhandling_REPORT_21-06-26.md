# Phase 1 (remaining) REPORT — Input validation (Zod) + error handling + env + health

- Date: 2026-06-21 · Research: `validation-errorhandling_RESEARCH_21-06-26.md` · gap-audit root themes #3 (validation), #4 (error handling), #6 (env/boot). (The auth/RBAC half of gap-audit Phase 1 was already done in the auth program.)
- **No Prisma schema change / no migration** — all code + config.
- Owner decisions (ALL = research recommendation): **D1** orders POST = Zod **WRAP** (shape-only; money logic untouched); **D2** `z.nativeEnum`/`z.enum` in Node-only `src/lib/schemas/`; **D3** `src/lib/env.ts` Full (fail-fast on DATABASE_URL/AUTH_SECRET, warn on missing AUTH_URL in prod); **D4** paymentLines cap stays manual (422 TOO_MANY_PAYMENTS).
- Status: ✅ **type-check + build + Vitest 42/42 + e2e 14/14 + live smoke + env fail-fast proof + 3-dim adversarial review (11 confirmed → all addressed)** — all green.

## What was built
- **Zod** (zod 4.4.3) + `src/lib/schemas/` (Node-only): `_shared.ts` (`parseBody → 400 {error, code:"VALIDATION", issues}`), `product`, `shift`, `syncJob`, `stockMovement`, `order`, `auditLog`. Applied WRAP-style at route boundaries (validate shape; keep each route's existing domain guards + coded errors).
- **`src/lib/env.ts`** — Zod fail-fast at boot: `DATABASE_URL` (non-empty, `postgres` prefix) + `AUTH_SECRET` (≥16) **throw**; `NODE_ENV` optional enum; `AUTH_URL`/`AUTH_TRUST_HOST` documented; `console.warn` (not throw) if `AUTH_URL` absent in production. Imported only from `src/lib/prisma.ts` + `src/auth.ts` (Node) — never edge/client. `.env.example` documents `AUTH_TRUST_HOST` (placeholder only, no real secret).
- **Error handling** — added try/catch to the bare-Prisma routes (GET orders, GET/POST products, GET sync-jobs, GET failed-count) → typed `{error,code}` + `console.error`, P2002→409 / P2025→404; no raw 500s.
- **`POST /api/products`** hardened: strict `typeof price` (no `Number()` coercion), length caps (name≤200/sku≤100/barcode≤64), categoryId existence pre-check (→400 CATEGORY_NOT_FOUND), P2002→409 (SKU_TAKEN/BARCODE_TAKEN).
- **Validation caps** added: shift openingFloat (finite + ≤Decimal max before round2), sync-jobs reason ≤500, users password ≤72 / email ≤254, customers `q` truncate ≤200, audit-logs actorId ≤40, orders items ≤MAX_ITEMS / customerId ≤40 / discountValue ≤Decimal max.
- **`GET /api/health`** (public, cheap `SELECT 1` → 200 `{status:ok}` / 503) + a `healthcheck` stanza on the app service in `docker-compose.yml` (db already had one). `src/app/error.tsx` + `(shell)/error.tsx` already existed (untouched).

## Verification (orchestrator, independent — ephemeral Postgres + live server)
- type-check + build + Vitest 42/42 + e2e 14/14.
- **env fail-fast:** short `AUTH_SECRET` → throws; missing `DATABASE_URL` → throws (message points to `.env.example`); valid env → boots.
- **Validation 400s:** products price-as-string / name-10000 → 400 VALIDATION; bad categoryId → 400 CATEGORY_NOT_FOUND; users password>72 → 400 BAD_PASSWORD; sync-jobs reason>500 → 400 BAD_REASON; audit-logs actorId>50 → 400 BAD_ACTOR_ID; customers q>200 → 200 (truncate); orders items>50 → **422 TOO_MANY_ITEMS**; customerId>40 → **400 BAD_CUSTOMER**; discountValue 1e8 → 400 BAD_DISCOUNT.
- **Error handling:** malformed JSON → 400 BAD_REQUEST (not 500); duplicate SKU → 409 SKU_TAKEN (not 500); GET products/orders → 200.
- **/api/health:** 200 `{status:ok, db:ok}`, public.
- **Regression:** checkout still 201 `total:"65.00"` (orders WRAP did not touch money); normal product create 201; normal GRN 201.

## Adversarial review (3 dims × verify) — 11 confirmed, all addressed
1. **(HIGH) orders `items` array uncapped** → DoS (thousands of items → ~2 DB statements/item in one tx). Fixed: manual `MAX_ITEMS=50` guard → **422 TOO_MANY_ITEMS** (mirrors paymentLines).
2-4. **(MED ×3) bare-Prisma pre-checks outside try/catch** (orders idempotency `findUnique`, products POST + PATCH category `findUnique`) → raw 500. Fixed: wrapped → sanitized `{code:"INTERNAL"}` 500.
5. **(MED) stock-movements `reference` double-validated** — Zod `.max(200)` shadowed the manual `BAD_REFERENCE`. Fixed: removed the Zod cap; manual guard authoritative (preserves the code).
6. **(LOW) dead `src/lib/schemas/user.ts`** (never wired; misleading comment) → deleted; users routes keep their complete manual validation.
7. **(LOW) products/[id] PATCH dead Zod `safeParse`** (logically shadowed) → removed the no-op; manual per-field checks remain.
8-9. **(LOW) orders `discountValue` / `customerId` uncapped** → added caps (BAD_DISCOUNT / BAD_CUSTOMER).
- **Orchestrator reconciliation (post-review re-smoke):** the items + customerId fixes initially added a Zod `.max()` that *shadowed* the manual coded guards (returned generic VALIDATION 400 instead of TOO_MANY_ITEMS 422 / BAD_CUSTOMER 400). Removed those Zod `.max()` so the **manual coded guards are the single authoritative cap** (same principle as the stock-movements fix). Re-verified live: 422 TOO_MANY_ITEMS / 400 BAD_CUSTOMER.

## Deviations / residuals
- **Users routes stay manually validated** (their schema was deleted as dead code) — complete + preserves BAD_EMAIL/BAD_ROLE/BAD_PASSWORD codes. Wiring Zod there is a future tidy-up (would need superRefine to preserve codes).
- **`ProductPatchBodySchema`** is now an unused export in `product.ts` (harmless; left to stay surgical).
- **`[env]` warning during `npm run build`** — env.ts's intended D3 `console.warn` (AUTH_URL absent under NODE_ENV=production at build time). A warning, not an error; harmless. In real prod AUTH_URL is set (or Auth.js infers).

## User action (host dev)
No DB change — just **restart `npm run dev`**. (Boot now fail-fasts if `.env` is missing `DATABASE_URL`/`AUTH_SECRET`; the dev `.env` already has both.) New: every route returns typed `{error,code}` 4xx on bad input (never a raw 500), and `GET /api/health` is available for liveness checks.

## Remaining (gap-audit roadmap)
- **Phase 3:** Vitest coverage expansion + **CI (GitHub Actions)** + gitleaks; observability (pino structured logs + correlation IDs + Sentry); deploy hardening (`output:"standalone"`, least-priv DB role, resource limits).
- **Phase 4:** full tax invoice (running no. + TIN + VAT), backups/PITR + DR, PDPA + data retention, offline/PWA, a11y.
- **Deferred review items:** Customer PII scoping on order responses (→ PDPA), shift `findFirst` outside the checkout tx, orders idempotency body-match (only if the API is exposed externally), and wiring Zod into the users routes.

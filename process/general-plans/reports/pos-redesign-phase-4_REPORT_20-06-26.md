# POS Redesign — Phase 4 REPORT (Catalog/stock + Users & Roles + RBAC stub)

- Date: 2026-06-20
- Plan: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (Phase 4, 20 functions + deferred `branchId`)
- Research: `process/general-plans/reports/pos-redesign-phase-4_RESEARCH_20-06-26.md`
- Approved approach: **Full faithful (full-stack)** — 2nd tracked migration + new APIs + client RoleContext + 2 screens
- Status: ✅ **type-check + build + tracked-migration + live smoke (users CRUD, receive-stock, product edit, all validation edge cases, page render, P0/P2/P3 regression) ALL verified**
- Scope: Products & Inventory screen + Users & Roles screen + role gating. Real auth/session/login enforcement = **production-readiness** (cross-program, not built).

## ⚠️ Load-bearing caveat — RBAC is a CLIENT DEMO stub, NOT security
Faithful to Simple POS's demo role toggle. The server enforces **nothing**: every API route and admin page is reachable by URL regardless of role. NavRail filtering + `AdminOnly` page guard + the role toggle are UX only. Real enforcement (session, server-side RBAC, route middleware) is owned by the **production-readiness** program. Loud `// TODO(production-readiness)` markers left throughout.

## What was built (20 Phase-4 functions + branchId)

**Schema (`prisma/schema.prisma`) + 2nd tracked migration `20260620124520_phase4_catalog_stock_users`:**
- `User.isActive Boolean @default(true)` — activate/deactivate without destructive delete (`state-user-active-inactive`).
- **`branchId String @default("BR-01")`** on `User` + `Order` + `Product` — the Phase-1-deferred `domain-multi-branch-ready` data model. Single-branch deployments use the `BR-01` default.
- New `enum StockMovementType { RECEIVE SALE ADJUST }` + `model StockMovement` (`id`, `productId`→Product cascade, `type`, `qty Int`, `reference?`, `branchId @default("BR-01")`, `createdAt`); `Product.movements StockMovement[]`. RECEIVE = goods-received (GRN, +stock); SALE/ADJUST reserved for future wiring.
- Migration is additive only (defaulted columns + new table/enum) → non-breaking. Verified the migration SQL applies cleanly on a fresh DB and the DB exposes `isActive`, `branchId`×3, the `StockMovement` table, and the 3-value enum.

**API (4 new route files, all typed `{error, code}`, no auth — TODO production-readiness):**
- `GET /api/users` — list; `select` id/name/email/role/isActive/branchId/createdAt — **`password` is never selected or returned**.
- `POST /api/users` — create: NAME_REQUIRED 400 · BAD_EMAIL 422 · BAD_ROLE 422 · NAME_TOO_LONG 400 · EMAIL_TAKEN 409. Placeholder (non-functional) password + `isActive:true`; returns user **without password** (201).
- `PATCH /api/users/[id]` — set `isActive` (BAD_ACTIVE 400 · NOT_FOUND 404). Returns user (no password).
- `PATCH /api/products/[id]` — partial edit (name/price/stock/categoryId/barcode/isActive) with per-field type+range validation: BAD_NAME · BAD_PRICE · BAD_STOCK · CATEGORY_NOT_FOUND · BAD_BARCODE · BAD_ACTIVE (400) · NOT_FOUND 404 · BARCODE_TAKEN 409.
- `POST /api/stock-movements` — receive (GRN): `$transaction` increments `Product.stock` (`{ increment: qty }`) **and** writes a RECEIVE `StockMovement` atomically. BAD_PRODUCT · BAD_QTY · BAD_REFERENCE (400) · PRODUCT_NOT_FOUND 404. Returns `{ product, movement }` (201).

**RBAC stub (client demo):**
- `src/components/RoleProvider.tsx` — `useRole()` → `{ role, setRole, hydrated }`; default `admin`, localStorage-persisted, `hydrated` flips true after the localStorage read (avoids SSR mismatch + the protected-content flash). Mounted in root `layout.tsx` wrapping `ToastProvider` (layout stays a Server Component).
- `src/lib/roleAccess.ts` — `NAV_ACCESS`/`canAccess`: pos/sales/shift = both roles; data/products/users/docs = admin only.
- `src/components/NavRail.tsx` — role-filtered nav + bottom DEMO role toggle (ผู้ขาย/Admin).
- `src/components/AdminOnly.tsx` — renders nothing until `hydrated`, then redirects a seller to `/pos` (no flash, no premature fetch) or renders children for admin. Wraps `/products` + `/users`; reusable for `/data`/`/docs`.

**Screens (Taste-styled, admin-guarded):**
- `src/app/(shell)/products/page.tsx` — table (SKU · category-tinted monogram · name · category · price · VAT 7% · stock · status ขายอยู่/สต็อกต่ำ/หมด), search, low-stock count, **รับสินค้าเข้า** (ReceiveStockModal → stock-movements), **เพิ่มสินค้า** (ProductFormModal → POST) + row edit (PATCH).
- `src/app/(shell)/users/page.tsx` — role-permission summary cards (Seller vs Admin), user table (initials avatar · name · email · role badge · branch · status + activate/deactivate toggle), filter chips ทั้งหมด/ผู้ขาย/Admin (→ ALL/CASHIER/ADMIN), **เพิ่มผู้ใช้** (AddUserModal w/ name+email validation).
- Supporting: `src/components/{products/{productMeta,ReceiveStockModal,ProductFormModal},users/{userMeta,AddUserModal}}`.

**Seed (`prisma/seed.ts`):** kept admin; added 2 CASHIER sellers (อรุณ active · มาลี `isActive:false`) with placeholder passwords. All rows default `branchId=BR-01`.

## Verification (orchestrator, independent)
- `npm run type-check` — **PASS** · `npm run build` — **PASS** (17 routes; 6 new API handlers registered; `/products` 6.75 kB, `/users` 4.54 kB).
- **Tracked migration** applied on a fresh ephemeral Postgres → DB exposes `User.isActive`, `branchId` on User/Order/Product, `StockMovement` table, `StockMovementType` = RECEIVE/SALE/ADJUST. Seed → 17 products / 4 categories / 3 users.
- **Live smoke** (`next start` clean build + real DB), all expected codes confirmed:
  - Users: GET 200 (3 users, **no password**, keys incl. branchId) · POST valid 201 (no password, branchId BR-01) · bad email 422 · missing name 400 · bad role 422 · dup email 409 · name>200 400 · PATCH deactivate 200 · non-bool 400 · unknown id 404.
  - Stock: receive +25 → 201, stock **21→46**, movement `RECEIVE/25/PO-TEST-001/BR-01` · qty 0/2.5/3e9 → 400 · reference>200 → 400 · unknown product 404. Failed-validation calls wrote **no** movement (stock unchanged).
  - Product edit: price 99.5 → 200 · price `""` → 400 · stock `null` → 400 · price overflow → 400 · bad categoryId → 400 CATEGORY_NOT_FOUND · name>200 → 400 · valid name+category → 200 · unknown product 404.
  - Pages: `/products` `/users` `/pos` → 200 (rail SSR'd, admin content hydrates client-side via AdminOnly, no error overlay).
  - DB after: users 4, StockMovement 1 (RECEIVE), target stock 46.
- **Regression:** `/pos` 200 with VAT / ตะกร้าว่าง / ยอดสุทธิ markers (P2/P3 intact); `GET /api/orders` 200 (P0 cashier-select fix intact); shell/rail/login untouched. Ephemeral DB + smoke server torn down; `.env` untouched; `.next` cleaned.

## Adversarial review + fixes (13-agent workflow `wk3a66y5d`)
5 review dimensions × adversarial verify → **8 raw findings, 7 confirmed (1 critical · 1 medium · 5 low), 1 refuted** (a stale-snapshot "no migration" claim, false — the migration existed). **All 7 fixed and re-verified by live smoke:**
- **CRITICAL** — `USER_PUBLIC_SELECT` selected `branchId` but the `User` model had no such field (TS missed it: a named `as const` select bypasses excess-property checking). Every `/api/users` call threw `PrismaClientValidationError` → 500 → the whole Users & Roles screen was non-functional. **Fix:** added `branchId` to the `User` model (faithful to multi-branch-ready; the screen + DTO already expected it) and regenerated the single Phase-4 migration to include it.
- **MEDIUM** — PATCH product `Number("")`/`Number(null)` === 0 silently zeroed price/stock. **Fix (A):** require a real JSON `number` before assigning.
- **LOW** — qty/stock Int4 overflow → 500 (was uncaught). **Fix (B):** cap `> 2_147_483_647` → 400.
- **LOW** — price Decimal(10,2) overflow → 500. **Fix (C):** cap `> 99_999_999.99` → 400.
- **LOW** — bad `categoryId` returned misleading "Product not found" 404. **Fix (D):** `category.findUnique` pre-check → 400 CATEGORY_NOT_FOUND.
- **LOW** — `AdminOnly` flashed the admin screen + fired its data fetch for one frame before redirecting a seller (hydration gap). **Fix (E):** `hydrated` flag — render nothing until hydrated.
- **LOW** — unbounded free-text length. **Fix (F):** name ≤200, barcode ≤64, reference ≤200 → 400.

## Deviations / notes
- `branchId` extended to `User` (not only Order/Product as the research draft scoped) — required because the users screen + DTO + API select already assumed it; this is the faithful multi-branch-ready model and was folded into the same Phase-4 migration (regenerated, not a 3rd migration).
- AdminOnly now renders admin-page content client-side only (after hydration) — acceptable for internal admin screens; eliminates the seller flash.

## Production-readiness (deferred, not regressed)
Real auth/session + **server-side** RBAC + route middleware (the client RBAC is non-enforcing) · password hashing + first-login flow (add-user uses a placeholder) · Decimal-safe money recompute · idempotency keys · concurrency-hardened/audited stock mutation · categories API endpoint (the form currently derives categories from fetched products). All marked TODO; none regressed.

## Next
- Mark Phase 4 ✅ done in plan/timeline (this report's commit).
- **Phase 5** (Sales History + Shift Close) is next — begin with its own RESEARCH on approval.

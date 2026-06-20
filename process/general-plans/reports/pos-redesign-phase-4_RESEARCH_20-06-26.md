# POS Redesign — Phase 4 RESEARCH (Catalog/stock + Users & Roles + RBAC)

- Date: 2026-06-20
- Plan: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (Phase 4, 20 functions) — also applies the **Phase-1-deferred `branchId`** migration.
- Depends on: Phase 1 + Phase 3 (done). **Cross-program: real RBAC enforcement depends on the `production-readiness` auth program (not built).**
- Scope: Products & Inventory screen + Users & Roles screen + role gating. NOT in scope: real auth/session/login (production-readiness), KRS sync (P6).

## 1. Current state
- **NavRail** (`src/components/NavRail.tsx`): role-filter **STUBBED to admin** — all 7 nav items always render; no role state/context anywhere.
- **`/products`, `/users`**: trivial placeholder cards.
- **`User`** model: `id, email(unique), name, role(Role @default CASHIER), password(required), orders, timestamps` — **no `isActive`**. `enum Role { ADMIN, MANAGER, CASHIER }` (Simple POS uses seller/admin; map seller→CASHIER, admin→ADMIN).
- **`Product`**: standard; `GET /api/products` (active+category), `POST /api/products` (create) exist. **No** PUT/PATCH, **no** stock-movement endpoint, **no** users API.
- **No `branchId`** on any model (deferred from Phase 1).

## 2. Target (Simple POS, Taste-styled — no Taste mock for these screens → port)
- **Products & Inventory** (admin): table (SKU · monogram · name · category · price · VAT · stock · status), search, low-stock alert, **รับสินค้าเข้า (receive stock / GRN)**, **เพิ่มสินค้า** (add modal) + edit.
- **Users & Roles** (admin): role-permission summary cards (Seller vs Admin), user table (avatar/name/email/role/branch/last-active/status + toggle), filter chips (all/seller/admin), **add-user modal** (name/email/role + validation), **activate/deactivate**.
- **Role gating**: Simple POS uses a **demo role toggle** (`setRoleSeller`/`setRoleAdmin` in the sidebar) → `navAccess`: pos/sales/shift = [admin,seller]; data/products/users/docs = [admin]. Seller sees only POS/Sales/Shift.

## 3. ⚠️ Phase 4 is FULL-STACK + has an auth dependency — decisions

| # | Gap | Options | Recommendation |
|---|---|---|---|
| **A** | RBAC needs a logged-in user + role; **no auth exists** | (a) client **role-switcher stub** (exactly like Simple POS's demo toggle) → NavRail filter + page guards, server NOT enforced · (b) wait for production-readiness auth | **(a) stub** — faithful to Simple POS (it's also a demo toggle); **flag loudly that it is NOT security**; real middleware/session enforcement = production-readiness |
| **B** | Schema additions | `User.isActive Boolean @default(true)`; `branchId String @default("BR-01")` on Order+Product (deferred P1); new **`StockMovement`** model (+`StockMovementType` enum RECEIVE/SALE/ADJUST) | **add all 3** via the 2nd tracked migration (DB available) |
| **C** | add-user needs a `password` (required, non-null) but there's no auth | (a) set a generated placeholder + `TODO(production-readiness)` first-login/hash · (b) make `password` nullable | **(a) placeholder** (no extra schema churn; real cred flow = production-readiness) |
| **D** | Role values: Simple POS seller/admin vs schema ADMIN/MANAGER/CASHIER | map **seller→CASHIER, admin→ADMIN** (MANAGER unused for now) | confirm mapping |

→ Phase 4 needs a **Prisma migration** + **new API routes** + **a client RoleContext** + 2 screens. (DB verified working in P2/P3.)

## 4. Function-by-function (20 + branchId)
**Products:** `screen-products-inventory` · `action-products-search` (name/EN/sku) · `action-add-product-button` (→ ProductForm modal; `POST /api/products` exists, add edit) · `action-receive-stock` (GRN → +stock + StockMovement) · `flow-product-stock` · `state-product-row-monogram` (first Thai char tile).
**Users:** `screen-users-roles` · `overlay-add-user-modal` · `action-open-add-user`/`action-set-nu-fields`/`action-save-user` (validate name + email)/`action-close-add-user` · `action-user-filter-chips` (all/seller/admin) · `action-toggle-user-status` + `state-user-active-inactive` (needs `User.isActive`).
**RBAC:** `action-set-role-seller`/`action-set-role-admin` (demo toggle) · `rolegate-seller-vs-admin` (NavRail filter + page guard) · `rolegate-seller-permissions`/`rolegate-admin-permissions` (capability summary cards).
**Deferred-from-P1:** `domain-multi-branch-ready` → `branchId` migration here.

## 5. Files likely to touch
- **New** `src/components/RoleProvider.tsx` (client context `useRole()` + setter; default admin) — mounted in root/shell layout (client boundary like ToastProvider).
- `src/components/NavRail.tsx` — consume `useRole()`, filter `NAV_ITEMS` by `navAccess`; add the role toggle (sidebar/user card).
- `src/app/(shell)/products/page.tsx` + `src/app/(shell)/users/page.tsx` — rewrite (Taste tables/cards/modals); `src/components/{products,users}/*`.
- An admin **page guard** (client hook/wrapper) → redirect seller off admin routes (note: client-only, bypassable).
- **`prisma/schema.prisma`** — `User.isActive`; `branchId` on Order+Product; `StockMovement` model + enum. **+ 2nd tracked migration.**
- **API** — `src/app/api/users/route.ts` (GET/POST), `src/app/api/users/[id]/route.ts` (PATCH isActive), `src/app/api/products/[id]/route.ts` (PUT/PATCH edit), `src/app/api/stock-movements/route.ts` (POST receive) — or fold receive into products.
- `prisma/seed.ts` — seed a few users (1 admin + 2 sellers, active/inactive) + set `branchId`; optionally backfill.

**Must NOT touch:** `/login`, Phase 6 (customer/tax/sync), Phase 5 (sales/shift). Keep P1–3 intact.

## 6. Risks
1. **RBAC is a client stub** — a seller can still reach admin routes by URL; the API does not enforce roles. **Real enforcement (middleware + session role + server checks) = production-readiness.** Must be labelled in the UI/code (no false sense of security).
2. **add-user password** — placeholder plaintext (same plaintext-cred issue, hashing = production-readiness). Never a real credential.
3. **Migration #2** — additive (isActive default true, branchId default BR-01, new StockMovement) → non-breaking; needs DB.
4. **Stock mutation** — receive-stock increments stock (real mutation, unlike P2/P3 display); guard qty as positive int; log StockMovement. Atomic/concurrency = production-readiness.
5. **Don't regress P1–3** — shell/rail (NavRail gains role filter), pos/payment/receipt untouched.

## 7. UI-only vs full-stack — verdict
**Full-stack** (migration + new APIs + RoleContext + 2 screens), with RBAC enforcement explicitly **stubbed/visual** pending production-readiness auth.

## 8. Recommended execution order
1. Migration (User.isActive, branchId on Order+Product, StockMovement + enum) → `prisma migrate dev`.
2. APIs: users (GET/POST/PATCH), products edit (PUT/PATCH), stock-movement (receive).
3. RoleProvider + NavRail role filter + page guard + role toggle.
4. Products screen (table/search/add/edit/receive/monogram/low-stock).
5. Users screen (cards/table/filter/add-modal/toggle).
6. seed users + branchId; type-check + build + live smoke (migration, receive-stock, add-user, role toggle hides admin nav).

## 9. Plan/timeline updates
- None structural. After EXECUTE: mark P4 ✅ done; note schema additions (isActive, branchId, StockMovement) + that **RBAC enforcement is stubbed pending production-readiness auth**, add-user password is a placeholder.

## Readiness
**Phase 4 is ready for EXECUTE — full-stack** (migration + APIs + RoleContext + 2 screens). The load-bearing caveat: **RBAC is a demo stub, not security** (faithful to Simple POS; real enforcement = production-readiness). Decisions A–D (esp. stub-RBAC + the 3 schema additions + add-user placeholder password) need a go-ahead before implementation. DB available.

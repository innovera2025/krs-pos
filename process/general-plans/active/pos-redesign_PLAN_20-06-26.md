# KRS POS Redesign — Development Plan

- Status: 🔨 IN PROGRESS — **Phases 1–3 committed** (P3 = payment/receipt/hold + first tracked migration; build + live-smoke verified); `/login` UI stub; Phases 4–7 planned.
- Created: 2026-06-20 · last finalized: 2026-06-20
- Plan type: COMPLEX (multi-phase program — **7 phases**: P1–P6 build + P7 cross-cutting hardening)
- Owner program: POS redesign (relates to the `production-readiness` security/correctness program)
- Companion: visual timeline at `process/general-plans/references/pos-redesign-timeline_20-06-26.html`
- Sources of truth:
  - **`design/Simple POS.dc.html`** — complete function / screen / state / flow **inventory** (the SOURCE OF TRUTH; nothing here may be dropped).
  - **`design/KRS POS Taste Redesign.html`** — the **approved visual redesign direction** (Joi/Taste: look, layout, components, copy).
  - **`design/_ds/` (pguard)** — **reference / aesthetic only**, NOT KRS POS product truth.
  - Current Next.js app (`src/app/**`, `prisma/schema.prisma`) — the implementation baseline we build on.

> How this plan was built: an adversarially-verified multi-agent inventory of all three sources. 130 functions were first inventoried from `Simple POS.dc.html`; a completeness critic found **35 more**, for **165 total functions** across **7 screens**. Every one is mapped below to exactly one phase (single-assignment by `matrix.phase`, identical to the HTML companion) — coverage **165/165** (no function dropped).

## Current status snapshot

- ✅ **Phase 1 (shell/rail/theme/routing) — COMMITTED** (feat/design/docs commits) incl. `/login` UI stub + favicon + review-loop bug-fix pass (Modal a11y/Escape/focus-trap, money() guards, contrast, reduced-motion, toast live-region, nav landmark).
- ✅ **Phase 2 (`/pos` checkout core) — committed; build + pricing (32/32) + live DB smoke verified.** Taste 3-col register, integer-satang VAT-inclusive totals + proportional discount, per-line/bill discount (฿/%), 17-item seed.
- ✅ **Phase 3 (payment + receipt/print + hold) — committed; build + tracked-migration + live pay→order smoke verified.** Payment modal (6 methods/split/cash+change/ref), 80mm receipt (print/QR/new-sale-only), hold bill; schema `PaymentType` +EWALLET/OTHER + `PaymentLine` model + posNo `POS-YYYYMMDD-####`.
- 🧭 **8 routes live:** `/login` (UI stub) · `/pos` (old/partial checkout, DB-dependent) · `/products` `/users` `/sales` `/shift` `/data` `/docs` (placeholders) · `/` → `/pos` redirect.
- ⏸️ **Deferred:** `domain-multi-branch-ready` (branchId) → Phase 4 (needs a DB). Real auth/RBAC → `production-readiness` program (see Login addendum + §8).

---

## 1. Goal & strategy

Rebuild KRS POS so it **preserves every function/state/flow in `Simple POS.dc.html`** while presenting them in the **approved visual language of `KRS POS Taste Redesign.html`**, implemented incrementally on top of the **current Next.js + Prisma + PostgreSQL** app.

Three facts shape the sequencing:

1. **The Taste prototype only fully builds ONE of the 7 screens — POS Checkout.** The other 6 are hinted via rail icons only. **~122 of 165 functions are NOT shown in Taste** and must be *ported* into the Taste language (see §7), not dropped.
2. **The current app is a single subtotal-only checkout page**, but its Prisma schema carries dormant capability — `Role`, `OrderStatus`, `discount`, `tax`, `paymentType`, `cashierId` — defined but unused. Much of the work is *wiring up dormant capability*.
3. **The current stack is PostgreSQL/Prisma; Simple POS assumes MySQL + an external “KRS” DB.** Keep PostgreSQL as the system of record; treat “KRS Data Link” as an **integration/sync surface** (Phase 6), not a DB swap.

## 2. Rules & guardrails

- **Do not drop any Simple POS function.** The §6 per-phase tables list all 165 (single-assignment).
- **`design/_ds/` (pguard) is reference/aesthetic only** — never a KRS POS requirement (no map pins, no guard live-status).
- **LATENT functions count.** Three data-tab features (account-mapping tables, sync-mode cards, stock-method cards) are computed-but-never-rendered in the prototype — still in scope, build as **real** controls (Phase 6).
- **Security & correctness come from the sibling `production-readiness` program.** Auth/RBAC, Zod validation, Decimal-safe money/stock, idempotency, audit, migrations — see §8. Consume, do not re-implement.
- **Verification gate for every phase:** `npm run type-check` and `npm run build` must pass (lint not configured). Plus per-phase functional checks.
- **No UI/app code is written until a phase is explicitly approved** and entered via the phase-program loop (§11).

## 3. Screen map (7 screens)

| Screen | TH / EN | Role | Purpose |
|---|---|---|---|
| `pos` | ขายหน้าร้าน / POS Checkout | both | Fast tablet/web checkout: browse/search/scan products, build cart, apply discounts, pick customer, take payment (cash/transfer/QR/card/e-wallet, split), print/s |
| `sales` | ประวัติการขาย / Sales History | both | Search/filter past bills; view sale detail drawer; reprint receipt; refund (credit note), void (pre-sync only), request tax invoice. Both roles. |
| `shift` | ปิดรอบขาย / Shift Close | both | Z-report: gross sales, sales-by-payment-method, refunds/discounts/output-VAT, cash counting with expected vs counted variance, close shift + generate daily acco |
| `data` | การเชื่อมข้อมูล KRS / KRS Data Link | admin | Admin-only KRS DB integration: Connection (host/port/SSL/test/insert), Field Mapping (2-way POS↔KRS), Data Flow (sync queue, pull/insert, retry/skip), Live Data |
| `products` | สินค้าและสต็อก / Products & Inventory | admin | Admin-only product/stock management: list with SKU/category/price/VAT/stock/status, low-stock alerts, receive stock (GRN), add product. Admin only. |
| `users` | จัดการผู้ใช้และสิทธิ์ / Users & Roles | admin | Admin-only user management: role permission summary (Seller vs Admin), user table, add user (name/email/role), activate/deactivate. Admin only. |
| `docs` | เอกสารออกแบบระบบ / Design Spec Package | admin | Admin-only product design documentation hub (overview, IA, flows, screen list, components, tokens, copy, accounting UX rules, 2 visual directions, dev notes). R |

## 4. Visual language to adopt (from the Taste redesign)

Follow `KRS POS Taste Redesign.html` for the new UI:

- **Layout:** 3-column register — 76px forest-gradient **rail** · flexible **workspace** (header + status pills + search/barcode + category panel + product grid) · 408px **cart/payment** panel. Collapses ≤1120px / ≤760px.
- **Palette:** forest `#0e3b2e` / forest-2 `#14513f` · brand green `#1fa971` · mint `#dff8ec` · amber accent `#f59e0b` · white surfaces on `#eef3f7`. Structure from 1px hairline borders.
- **Type:** IBM Plex Sans Thai (UI) + IBM Plex Mono (money/IDs). Thai-first bilingual microcopy.
- **Components (11):** rail, header+status strip, search/barcode, category panel, product cards (low-stock + in-cart), cart lines+qty, discount row, **VAT-7%-inclusive** totals, hold/clear bill, pay modal, toast. Receipt 80mm = build per Simple POS (Taste hints only).
- **Caveat:** where Taste is simplified (3 pay tiles, no split/change), **Simple POS behavior wins** (6 methods, split, change-due) — restyled into Taste.

## 5. Gap summary (all 165 functions)

**In Taste:** 🟢 17 · 🟡 32 · 🔴 116   ·   **In current app:** 🟢 6 · 🟡 19 · 🔴 140

**Gap type:** 12 `redesign-existing` · 80 `build-new-ui` · 72 `full-stack-new` · 1 `backend-needed`

## 6. Phased roadmap

Seven phases (P1–P6 build + P7 cross-cutting hardening). Each is one pass of the phase-program loop; every gate requires `npm run type-check` + `npm run build`.

| Phase | Status | Title | Depends on | # functions | Gap profile |
|---|---|---|---|---|---|
| **P1** | ✅ done (committed) | Design-system foundation + app shell, rail, theme, routing | none | 8 | 4 redesign-existing, 3 build-new-ui, 1 backend-needed |
| **P2** | ✅ done (committed) | Checkout core redesigned — product grid, cart, discounts, VAT-inclusive totals | P1 | 19 | 8 redesign-existing, 11 build-new-ui |
| **P3** | ✅ done (committed) | Payment + receipt/print + hold bill — complete the sell-to-receipt flow | P2 | 28 | 27 build-new-ui, 1 full-stack-new |
| **P4** | ▶ next | Catalog/stock management + Users & Roles + RBAC enforcement | P1, P3 | 20 | 12 build-new-ui, 8 full-stack-new |
| **P5** | ⏳ planned | Shift open/close + Z-report + Sales History with refund/void/reprint | P3, P4 | 23 | 11 build-new-ui, 12 full-stack-new |
| **P6** | ⏳ planned | KRS Data Link (sync/offline) + Customer/member + tax invoice + Design Spec docs | P2, P3, P4, P5 | 67 | 51 full-stack-new, 16 build-new-ui |
| **P7** | ⏳ planned | Integration hardening, responsive QA, regression, polish | P2, P3, P4, P5, P6 | — | cross-cutting / QA |

### Phase 1 — Design-system foundation + app shell, rail, theme, routing

- **Status:** ✅ done (committed)
- **Depends on:** nothing (can start first)
- **Note:** COMMITTED (feat/design/docs commits). `domain-multi-branch-ready` (branchId) **deferred to Phase 4** (needs a DB) — the other 7 functions are done.
- **Goal:** Establish the approved Taste visual language as a reusable token/component layer and replace the bare header with a routed app shell so every later screen drops into a consistent frame. Add multi-branch schema groundwork early so no later migration is forced. No POS behavior changes yet beyond restyling chrome.
- **Verification gate:** npm run type-check + npm run build pass. Manual: app renders the forest-gradient rail with the 7 nav items (role-filter stubbed to admin), clicking each rail item routes to a placeholder screen, toast primitive shows + auto-dismisses at ~2.2s, money() helper renders ฿ with mono tabular nums, shared Modal/Drawer close on backdrop click via stopPropagation guard, and Prisma migration adds branchId (default BR-01) to relevant entities without breaking existing /api/products + /api/orders.
- **Functions in this phase (8):**

| Function (id) | What it is | Screen | In Taste | In app | Gap | Done? |
|---|---|---|---|---|---|---|
| `overlay-toast` | Toast notification | global | 🟢 yes | 🟡 partial | redesign-existing | ✅ |
| `nav-sidebar` | Sidebar navigation | global | 🟢 yes | 🔴 no | redesign-existing | ✅ |
| `action-nav-go` | Navigate to view (go) | global | 🟡 partial | 🔴 no | build-new-ui | ✅ |
| `state-toast-feedback` | Toast feedback state | global | 🟢 yes | 🟡 partial | redesign-existing | ✅ |
| `domain-currency-baht` | Currency ฿ THB formatting | global | 🟢 yes | 🟡 partial | redesign-existing | ✅ |
| `domain-multi-branch-ready` | Multi-branch-ready data model | global | 🟡 partial | 🔴 no | backend-needed | ⏸️ deferred→P4 |
| `action-stop-propagation` | Modal/drawer inner-click guard (stop) | global | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `domain-nav-en-and-titles-mismatch` | Nav labels vs view titles divergence | global | 🔴 no | 🔴 no | build-new-ui | ✅ |

### Phase 2 — Checkout core redesigned — product grid, cart, discounts, VAT-inclusive totals

- **Status:** ✅ done (committed)
- **Depends on:** Phase 1
- **Note:** committed; build + **pricing-tested (32/32)** + live DB smoke ✅. Seed 17/4. See `pos-redesign-phase-2_REPORT_20-06-26.md`.
- **Goal:** Rebuild the POS Checkout as the Taste 3-column register on top of the current app: category panel + searchable/barcode product grid (17-item catalog, low/out-of-stock styling, in-cart badge), full cart with per-line + bill discounts and a faithful VAT-inclusive computeTotals (proportional discount allocation + clamping). End state: a fully interactive cart that computes correct totals but stops at the pay button.
- **Verification gate:** npm run type-check + npm run build pass. Manual: search filters by name/EN/SKU; category chips filter the grid; adding a product shows in-cart badge; +/-/trash adjust and remove lines; per-line and bill discounts (฿ and %) recompute totals; VAT shows as 'VAT 7% (รวมในราคา)' extracted inclusive with proportional bill-discount allocation (preVat = total − vat); low-stock (<=10) cards render amber, out-of-stock blocked; seed expanded to 17 products / 4 categories; empty-cart and no-results states render in Taste style.
- **Functions in this phase (19):**

| Function (id) | What it is | Screen | In Taste | In app | Gap | Done? |
|---|---|---|---|---|---|---|
| `screen-pos-checkout` | POS Checkout (ขายหน้าร้าน) | pos | 🟢 yes | 🟡 partial | redesign-existing | ✅ |
| `action-product-search` | Product search / barcode scan (onSearch) | pos | 🟢 yes | 🟢 yes | redesign-existing | ✅ |
| `action-category-filter` | Category filter (setActiveCat) | pos | 🟢 yes | 🔴 no | redesign-existing | ✅ |
| `action-add-to-cart` | Add product to cart (add) | pos | 🟢 yes | 🟢 yes | redesign-existing | ✅ |
| `action-cart-inc` | Increase line qty (inc) | pos | 🟢 yes | 🟢 yes | redesign-existing | ✅ |
| `action-cart-dec` | Decrease line qty (dec) | pos | 🟢 yes | 🟢 yes | redesign-existing | ✅ |
| `action-cart-remove` | Remove cart line (removeLine) | pos | 🟡 partial | 🟡 partial | build-new-ui | ✅ |
| `action-line-discount` | Per-line item discount (lineDiscount) | pos | 🟡 partial | 🔴 no | build-new-ui | ✅ |
| `action-bill-discount` | Bill-level discount (onBillDisc) | pos | 🟢 yes | 🔴 no | build-new-ui | ✅ |
| `action-toggle-disc-type` | Toggle discount type ฿/% (toggleDiscType) | pos | 🟡 partial | 🔴 no | build-new-ui | ✅ |
| `action-cancel-bill` | Cancel / clear bill (cancelBill) | pos | 🟢 yes | 🔴 no | build-new-ui | ✅ |
| `state-cart-empty` | Empty cart state | pos | 🟢 yes | 🟢 yes | redesign-existing | ✅ |
| `state-no-products-found` | No products match search | pos | 🟢 yes | 🟢 yes | redesign-existing | ✅ |
| `state-product-in-cart` | Product in-cart indicator | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `state-low-out-of-stock` | Low/out-of-stock state | pos | 🟡 partial | 🔴 no | build-new-ui | ✅ |
| `domain-vat-7-inclusive` | VAT 7% inclusive of price | global | 🟢 yes | 🔴 no | build-new-ui | ✅ |
| `display-seed-catalog` | Seed product catalog (17 items, 4 categories) | pos | 🟢 yes | 🟡 partial | build-new-ui | ✅ |
| `domain-vat-proportional-discount-allocation` | VAT recomputed with proportional discount allocation | global | 🟡 partial | 🔴 no | build-new-ui | ✅ |
| `domain-stock-default-50` | Default stock fallback = 50 for unmapped ids | products | 🔴 no | 🔴 no | build-new-ui | ✅ |

### Phase 3 — Payment + receipt/print + hold bill — complete the sell-to-receipt flow

- **Status:** ✅ done (committed)
- **Depends on:** Phase 2
- **Note:** committed; FULL-stack — `PaymentType` +EWALLET/OTHER + `PaymentLine` model + first tracked migration; orders API (paymentLines, posNo `POS-YYYYMMDD-####`, typed validations); payment modal + 80mm receipt + hold. Live smoke ✅ (POST 201, posNo, PaymentLine persisted). Decimal/idempotency/atomic-stock = production-readiness. See `pos-redesign-phase-3_REPORT_20-06-26.md`.
- **Goal:** Wire the full payment lifecycle: payment modal with all 6 methods, split payment, cash panel with quick-cash + change-due, reference no, validation banner, real posNo sequence, stock decrement, then the 80mm receipt modal (print + email/share + faux QR + sync badge) whose only exit is New Sale. Hold/cancel behavior ported faithfully.
- **Verification gate:** npm run type-check + npm run build pass. Manual: pay button (disabled on empty cart) opens modal prefilled with a cash line = total; selecting among 6 methods works; split lines add/remove and must sum to total within 0.01 (else payError); cash panel shows quick-cash buttons + change-due; confirm generates POS-YYYYMMDD-#### (distinct from accountingDocNo, shown '— รอออกเอกสาร —'), decrements stock, opens the 80mm receipt; receipt prints via window.print() (@page 80mm), shows qty×price line detail + QR to rcpt.krspos.co/{shortId} + pending sync badge; receipt closes ONLY via New Sale; payment modal closes only via X (no backdrop); hold clears with toast, cancel no-ops on empty.
- **Functions in this phase (28):**

| Function (id) | What it is | Screen | In Taste | In app | Gap | Done? |
|---|---|---|---|---|---|---|
| `overlay-payment-modal` | Payment modal (วิธีชำระเงิน) | pos | 🟡 partial | 🔴 no | build-new-ui | ✅ |
| `overlay-receipt` | Receipt modal (ใบเสร็จ 80mm) | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `action-hold-bill` | Hold / park bill (holdBill) | pos | 🟡 partial | 🔴 no | build-new-ui | ✅ |
| `action-open-payment` | Open payment (openPayment) | pos | 🟢 yes | 🔴 no | build-new-ui | ✅ |
| `action-set-pay-method` | Select payment method (setPayMethod) | pos | 🟡 partial | 🔴 no | build-new-ui | ✅ |
| `action-set-pay-amount` | Set split-line amount (setPayAmount) | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `action-add-pay-line` | Add split-payment line (addPayLine) | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `action-remove-pay-line` | Remove split-payment line (removePayLine) | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `action-cash-received` | Cash received + quick-cash (onCashReceived/setCash) | pos | 🟡 partial | 🔴 no | build-new-ui | ✅ |
| `action-pay-reference` | Payment reference no (onPayRef) | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `action-confirm-payment` | Confirm payment (confirmPayment) | pos | 🟡 partial | 🟡 partial | build-new-ui | ✅ |
| `action-print-receipt` | Print receipt 80mm (printReceipt) | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `action-email-receipt` | Email/share receipt link (toastEmail) | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `action-new-sale` | Start new sale (newSale) | pos | 🟡 partial | 🟡 partial | build-new-ui | ✅ |
| `state-payment-validation-error` | Payment validation error | pos | 🟡 partial | 🟡 partial | build-new-ui | ✅ |
| `state-cash-change-display` | Cash change display | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `flow-sell-to-receipt` | Flow: sell → cart → discount → pay → change → receipt/print | pos | 🟡 partial | 🟡 partial | build-new-ui | ✅ |
| `domain-receipt-80mm` | 80mm thermal receipt format | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `domain-separate-pos-acct-numbers` | Separate POS no vs accounting doc no | global | 🟡 partial | 🔴 no | full-stack-new | ✅ |
| `display-receipt-sync-badge` | Receipt sync-status badge | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `display-faux-qr` | Receipt QR code (digital receipt link) | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `action-close-payment-modal` | Close payment modal (closePayment / X) | pos | 🟡 partial | 🔴 no | build-new-ui | ✅ |
| `action-close-receipt-newsale-only` | Receipt modal dismissal is New-Sale-only (no X, no backdrop) | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `display-receipt-line-detail` | Receipt line-item detail format (qty × unit price) | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `state-pay-method-locked-line` | Locked split-payment line logic | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `domain-posno-seq-formula` | New POS number sequence formula (sales.length + 42) | pos | 🟡 partial | 🟡 partial | build-new-ui | ✅ |
| `domain-receipt-shortid` | Receipt shortId = last 6 of posNo | pos | 🔴 no | 🔴 no | build-new-ui | ✅ |
| `state-cancel-vs-hold-difference` | Hold vs Cancel behavioral difference | pos | 🟡 partial | 🔴 no | build-new-ui | ✅ |

### Phase 4 — Catalog/stock management + Users & Roles + RBAC enforcement

- **Status:** ▶ next
- **Depends on:** Phase 1, Phase 3
- **Goal:** Build the two admin-only management screens and turn the dormant Role enum into real enforcement. Products screen (search, monogram rows, add/edit ProductForm, receive-stock GRN + movement). Users screen (role summary cards, filter chips, add-user modal + validation, activate/deactivate). RBAC: navAccess filters the rail, route guards + redirect, real session, and the demo role-switch.
- **Verification gate:** npm run type-check + npm run build pass. Manual: as Admin the rail shows all 7 items; switching to Seller hides data/products/users/docs and redirects off any admin view to POS; Products screen lists rows with category-tinted Thai-char monograms, low-stock badge, search by name/EN/SKU, add-product form creates via POST /api/products, receive-stock generates a GRN and bumps the lowest-stock item; Users screen shows Seller/Admin permission summary cards, filter chips, add-user modal validates name + email format and prepends the user, and the row toggle flips active/inactive (no hard delete). Requires PUT/PATCH product endpoints, POST/PATCH user endpoints, and User.isActive added to schema.
- **Functions in this phase (20):**

| Function (id) | What it is | Screen | In Taste | In app | Gap | Done? |
|---|---|---|---|---|---|---|
| `screen-products-inventory` | Products & Inventory (สินค้า/สต็อก) | products | 🔴 no | 🟡 partial | build-new-ui | — |
| `screen-users-roles` | Users & Roles (จัดการผู้ใช้) | users | 🔴 no | 🟡 partial | build-new-ui | — |
| `overlay-add-user-modal` | Add User modal (เพิ่มผู้ใช้ใหม่) | users | 🔴 no | 🔴 no | build-new-ui | — |
| `action-set-role-seller` | Switch to Seller role (setRoleSeller) | global | 🔴 no | 🔴 no | build-new-ui | — |
| `action-set-role-admin` | Switch to Admin role (setRoleAdmin) | global | 🔴 no | 🔴 no | build-new-ui | — |
| `action-receive-stock` | Receive stock / GRN (receiveStock) | products | 🔴 no | 🔴 no | full-stack-new | — |
| `action-add-product-button` | Add product button | products | 🔴 no | 🟡 partial | build-new-ui | — |
| `action-products-search` | Products search (onProdQuery) | products | 🔴 no | 🔴 no | build-new-ui | — |
| `action-user-filter-chips` | User role filter chips (setUserFilter) | users | 🔴 no | 🔴 no | build-new-ui | — |
| `action-open-add-user` | Open add-user modal (openAddUser) | users | 🔴 no | 🔴 no | build-new-ui | — |
| `action-set-nu-fields` | Edit new-user fields (setNu) | users | 🔴 no | 🔴 no | build-new-ui | — |
| `action-save-user` | Save new user (saveUser) | users | 🔴 no | 🔴 no | full-stack-new | — |
| `action-toggle-user-status` | Activate/deactivate user (toggleUserStatus) | users | 🔴 no | 🔴 no | full-stack-new | — |
| `state-user-active-inactive` | User active/inactive state | users | 🔴 no | 🔴 no | full-stack-new | — |
| `rolegate-seller-vs-admin` | Role-gated menu access (navAccess) | global | 🔴 no | 🔴 no | full-stack-new | — |
| `rolegate-seller-permissions` | Seller permission set | users | 🔴 no | 🔴 no | full-stack-new | — |
| `rolegate-admin-permissions` | Admin permission set | users | 🔴 no | 🔴 no | full-stack-new | — |
| `flow-product-stock` | Flow: product CRUD + stock movement | products | 🔴 no | 🟡 partial | full-stack-new | — |
| `action-close-add-user` | Close add-user modal (closeAddUser / cancel / backdrop) | users | 🔴 no | 🔴 no | build-new-ui | — |
| `state-product-row-monogram` | Products table monogram = first char of Thai name | products | 🔴 no | 🔴 no | build-new-ui | — |

### Phase 5 — Shift open/close + Z-report + Sales History with refund/void/reprint

- **Status:** ⏳ planned
- **Depends on:** Phase 3, Phase 4
- **Goal:** Add the shift lifecycle and the sales history surface that consume real orders. Shift: open-shift, sales-by-payment-method breakdown, refunds/discounts/output-VAT cards, cash counting with variance, close + daily summary (DS). Sales History: searchable/filterable table, sale-detail drawer, refund (credit note), void (pre-sync only), reprint, with no-destructive-delete + synced-bill-lock domain rules. Seed 6 bills to exercise action gating.
- **Verification gate:** npm run type-check + npm run build pass. Manual: Sales History lists real orders, searches by posNo/customer, filter chips (all/paid/refunded/voided/failed/tax) work, row opens a detail drawer with contextual actions; Refund sets status REFUNDED via confirm and issues a credit note; Void (only when not yet synced) sets CANCELLED + totals 0; reprint reopens the 80mm receipt (using payment-lines fallback for seeded bills); drawer closes on backdrop/X and auto-closes after an action. Shift screen shows sales-by-payment-method breakdown, refunds/discounts/output-VAT, cash-count variance (green/amber/red), and Close generates a DS-dated daily summary success card. Seed includes 6 varied bills. Requires Shift model + close/refund/void endpoints.
- **Functions in this phase (23):**

| Function (id) | What it is | Screen | In Taste | In app | Gap | Done? |
|---|---|---|---|---|---|---|
| `screen-sales-history` | Sales History (ประวัติการขาย) | sales | 🔴 no | 🟡 partial | build-new-ui | — |
| `screen-shift-close` | Shift Close (ปิดรอบขาย) | shift | 🔴 no | 🔴 no | full-stack-new | — |
| `overlay-sale-detail-drawer` | Sale Detail drawer | sales | 🔴 no | 🔴 no | build-new-ui | — |
| `action-sales-search` | Sales search (onSalesQuery) | sales | 🔴 no | 🔴 no | build-new-ui | — |
| `action-sales-filter-chips` | Sales filter chips | sales | 🔴 no | 🔴 no | build-new-ui | — |
| `action-open-sale-detail` | Open sale detail (openSaleDetail) | sales | 🔴 no | 🔴 no | build-new-ui | — |
| `action-refund-sale` | Refund sale + credit note (refundSale) | sales | 🔴 no | 🔴 no | full-stack-new | — |
| `action-void-sale` | Void sale (voidSale) | sales | 🔴 no | 🔴 no | full-stack-new | — |
| `action-print-from-history` | Reprint from history (printFromHistory) | sales | 🔴 no | 🔴 no | build-new-ui | — |
| `action-counted-cash` | Enter counted cash (onCounted) | shift | 🔴 no | 🔴 no | full-stack-new | — |
| `action-close-shift` | Close shift + daily summary (closeShift) | shift | 🔴 no | 🔴 no | full-stack-new | — |
| `state-sale-status` | Sale status enum | sales | 🔴 no | 🟡 partial | build-new-ui | — |
| `state-sales-empty` | Sales table empty state | sales | 🔴 no | 🔴 no | build-new-ui | — |
| `state-shift-closed` | Shift closed state | shift | 🔴 no | 🔴 no | full-stack-new | — |
| `state-variance` | Cash variance state | shift | 🔴 no | 🔴 no | full-stack-new | — |
| `flow-shift-lifecycle` | Flow: open shift → sell → close shift / daily summary | shift | 🟡 partial | 🔴 no | full-stack-new | — |
| `flow-sales-history-reprint-refund` | Flow: sales history → reprint / refund / void / tax invoice | sales | 🔴 no | 🔴 no | full-stack-new | — |
| `domain-no-destructive-delete` | No destructive delete (void/refund only) | global | 🔴 no | 🟡 partial | full-stack-new | — |
| `domain-synced-bills-locked` | Synced bills locked from direct edits | global | 🔴 no | 🔴 no | full-stack-new | — |
| `display-payment-method-breakdown` | Sales-by-payment-method breakdown (shift) | shift | 🔴 no | 🔴 no | full-stack-new | — |
| `action-close-sale-detail` | Close sale detail drawer (closeSaleDetail + backdrop) | sales | 🔴 no | 🔴 no | build-new-ui | — |
| `display-receipt-payment-fallback` | Receipt payment-lines fallback | pos | 🔴 no | 🔴 no | build-new-ui | — |
| `display-seed-sales-dataset` | Seed sales dataset (6 bills with statuses/sync/acct numbers) | sales | 🔴 no | 🟡 partial | build-new-ui | — |

### Phase 6 — KRS Data Link (sync/offline) + Customer/member + tax invoice + Design Spec docs

- **Status:** ⏳ planned
- **Depends on:** Phase 2, Phase 3, Phase 4, Phase 5
- **Goal:** Deliver the admin KRS integration surface and the customer-dependent features, then port the remaining latent/doc functions so nothing is dropped. Build the offline-resilient SyncJob queue (IndexedDB, backoff, idempotency, state machine) feeding the 4 data tabs (Connection, Mapping incl. the LATENT account/sync-mode/stock-method tables+cards, Data Flow, Live Data) and the sync detail drawer + sidebar failed badge. Add Customer model -> customer picker, tax-info state, request-tax-invoice flow, and wire live/offline status + receipt sync badge to real connection. Finish with the static Design Spec docs hub.
- **Verification gate:** npm run type-check + npm run build pass. Manual: KRS Data Link (admin-only) renders all 4 tabs; Connection tab tests connection (status connected/testing/disconnected) + insert-test-row (green in Live Data) + editable fields + SSL toggle updating the conn-string; Mapping tab renders outbound + inbound tables AND the previously-latent account-mapping tables + sync-mode cards + stock-method cards (all clickable/wired), with incomplete mapping (vat_code) blocking sync via FIELD_MAP_MISMATCH; Data Flow tab shows clickable sync-count cards filtering the jobs table, pull/insert-all-pending, and a sync detail drawer with retry/skip; sidebar data badge equals the failed-job count and nulls when none; sales still complete while 'offline' (queued) proving sell-first. Customer picker selects member/walk-in with tax badge; requesting a tax invoice is blocked for walk-in and queues a tax_invoice job otherwise; receipt sync badge + live/offline pill reflect real connection state. Design Spec docs hub renders all 10 panels. Seed adds 8 sync jobs (failed badge = 2). Requires Customer model + SyncJob model + sync API.
- **Functions in this phase (67):**

| Function (id) | What it is | Screen | In Taste | In app | Gap | Done? |
|---|---|---|---|---|---|---|
| `screen-krs-data-link` | KRS Data Link (การเชื่อมข้อมูล) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `screen-data-connection-tab` | Connection tab (เชื่อมต่อ) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `screen-data-mapping-tab` | Field Mapping tab (จับคู่ฟิลด์) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `screen-data-flow-tab` | Data Flow tab (การไหลของข้อมูล) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `screen-data-livedata-tab` | Live Data tab (ตรวจข้อมูล) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `screen-design-spec-hub` | Design Spec hub (เอกสารดีไซน์) | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `overlay-customer-picker` | Customer Picker modal (เลือกลูกค้า) | pos | 🟡 partial | 🔴 no | full-stack-new | — |
| `overlay-sync-detail-drawer` | Sync Detail drawer | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-open-customer-picker` | Open customer picker (openCustPicker) | pos | 🟡 partial | 🔴 no | full-stack-new | — |
| `action-customer-search` | Customer search (onCustQuery) | pos | 🔴 no | 🔴 no | full-stack-new | — |
| `action-pick-customer` | Pick customer (pickCustomer) | pos | 🔴 no | 🔴 no | full-stack-new | — |
| `action-pick-walkin` | Pick walk-in (pickWalkIn) | pos | 🟡 partial | 🔴 no | build-new-ui | — |
| `action-tax-toggle` | Request tax invoice toggle (toggleTax) | pos | 🔴 no | 🔴 no | full-stack-new | — |
| `action-request-tax-invoice` | Request tax invoice from history (requestTax) | sales | 🔴 no | 🔴 no | full-stack-new | — |
| `action-db-test-connection` | Test KRS connection (testConnection) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-db-insert-test-row` | Insert test row (insertTestRow) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-db-edit-fields` | Edit connection fields (setDb) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-db-toggle-ssl` | Toggle SSL/TLS (toggleDbSsl) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-db-set-table` | Select Live Data table (setDbTable) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-pull-from-krs` | Pull data from KRS (pullFromKRS) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-insert-all-pending` | Insert all pending to KRS (insertAllPending) | data | 🟡 partial | 🔴 no | full-stack-new | — |
| `action-sync-card-filter` | Sync status card filter (setSyncFilter) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-open-sync-detail` | Open sync detail (openSyncDetail) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-retry-sync` | Retry sync job (retrySync) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-skip-sync` | Skip sync job with reason (skipSync) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-toggle-stock-sync` | Toggle realtime stock sync (toggleStockSync) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-set-stock-method` | Set stock accounting method (setStockMethod) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-set-sync-mode` | Set sync mode (setSyncMode) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-set-data-tab` | Switch KRS data tab (setDataTab) | data | 🔴 no | 🔴 no | build-new-ui | — |
| `action-docs-tab` | Switch design-spec tab (setDocsTab) | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `state-live-stock-status` | Live/offline stock status (liveOn) | pos | 🟡 partial | 🔴 no | build-new-ui | — |
| `state-sync-status` | Sync status enum (SyncStatusBadge) | data | 🟡 partial | 🔴 no | full-stack-new | — |
| `state-sync-queue` | Sync queue / pending jobs | data | 🟡 partial | 🔴 no | full-stack-new | — |
| `state-sync-empty` | Sync table empty state | data | 🔴 no | 🔴 no | full-stack-new | — |
| `state-db-connection` | DB connection status (connected/testing/disconnected) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `state-mapping-incomplete` | Field-mapping incomplete state | data | 🔴 no | 🔴 no | full-stack-new | — |
| `state-customer-has-tax` | Customer tax-info state | pos | 🔴 no | 🔴 no | full-stack-new | — |
| `flow-sync-to-krs` | Flow: sync to KRS (map field → insert / pull / fix failed) | data | 🟡 partial | 🔴 no | full-stack-new | — |
| `domain-sell-first-accounting-async` | Sell-first, accounting-async (POS keeps selling) | global | 🟡 partial | 🔴 no | full-stack-new | — |
| `domain-tax-invoice-requires-tax-customer` | Tax invoice requires customer with tax ID | pos | 🔴 no | 🔴 no | full-stack-new | — |
| `domain-mapping-blocks-sync` | Incomplete mapping blocks sync | data | 🔴 no | 🔴 no | full-stack-new | — |
| `domain-realtime-stock-sync` | Realtime stock sync to KRS | data | 🟡 partial | 🔴 no | full-stack-new | — |
| `domain-accounting-providers` | External accounting providers / KRS integration | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-outbound-field-map` | Outbound field-map table (POS→KRS) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-inbound-field-map` | Inbound field-map table (KRS→POS) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-account-mappings` | Account mapping tables (product/payment/tax/inventory) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-sync-mode-options` | Sync-mode option cards | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-stock-method-options` | Stock-method option cards | data | 🔴 no | 🔴 no | full-stack-new | — |
| `action-close-customer-picker` | Close customer picker (closeCustPicker + backdrop) | pos | 🔴 no | 🔴 no | full-stack-new | — |
| `action-close-sync-detail` | Close sync detail drawer (closeSyncDetail + backdrop) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-account-mapping-tables-LATENT` | Account mapping tables are computed but NOT rendered (latent) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-sync-mode-cards-LATENT` | Sync-mode option cards computed but NOT rendered (latent) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-stock-method-cards-LATENT` | Stock-method option cards computed but NOT rendered (latent) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-docs-overview-panel` | Design Spec — Overview panel | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `display-docs-ia-matrix` | Design Spec — IA / Sitemap permission matrix | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `display-docs-flows-panel` | Design Spec — Key user flows panel | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `display-docs-screen-list` | Design Spec — Screen list (MVP) panel | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `display-docs-component-inventory` | Design Spec — Component inventory panel | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `display-docs-tokens-panel` | Design Spec — Design tokens panel | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `display-docs-copy-panel` | Design Spec — UX copy (TH/EN) panel | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `display-docs-rules-panel` | Design Spec — Accounting UX rules panel | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `display-docs-visual-directions` | Design Spec — 2 Visual directions panel | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `display-docs-impl-notes` | Design Spec — Implementation notes panel | docs | 🔴 no | 🔴 no | build-new-ui | — |
| `state-live-status-fields-extra` | Live-status extra fields (liveSub) + tri-state styling tokens | global | 🟡 partial | 🔴 no | build-new-ui | — |
| `display-db-preview-row-builders` | Live Data per-table synthetic row builders | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-seed-sync-jobs` | Seed sync-jobs dataset (8 jobs, types, errors, responses) | data | 🔴 no | 🔴 no | full-stack-new | — |
| `display-sidebar-failed-badge-source` | Sidebar 'data' nav red badge = failed-job count | global | 🟡 partial | 🔴 no | full-stack-new | — |

### Phase 7 — Integration hardening, responsive QA, regression, polish

- **Status:** ⏳ planned
- **Depends on:** Phase 2, Phase 3, Phase 4, Phase 5, Phase 6
- **Goal:** Cross-cutting quality pass across all routes — responsive reflow (mobile rail collapse + Taste breakpoints), API error states, accessibility/contrast, performance, route-level browser smoke, and regression against all prior phases. No new Simple POS functions; make everything already built robust. Addresses deferred review items (responsive rail, POS a11y labels, login focus modality).
- **Verification gate:** npm run type-check + npm run build pass (+ optional Playwright e2e on the checkout flow). Responsive QA across all 7 routes + /login; a11y/contrast pass; error.tsx route boundaries; browser smoke of every route; regression checks on earlier phases.
- **Scope:** cross-cutting — no new Simple POS functions; hardens & QAs everything built in P1–P6.

## 7. Uncovered in Taste — must be PORTED, not dropped (122)

Simple POS functions **not drawn in the Taste prototype** — real requirements, re-created in the Taste language. Each is assigned to a phase above.

| Function (id) | What it is | Screen | Phase |
|---|---|---|---|
| `screen-sales-history` | Sales History (ประวัติการขาย) | sales | P5 |
| `screen-shift-close` | Shift Close (ปิดรอบขาย) | shift | P5 |
| `screen-krs-data-link` | KRS Data Link (การเชื่อมข้อมูล) | data | P6 |
| `screen-data-connection-tab` | Connection tab (เชื่อมต่อ) | data | P6 |
| `screen-data-mapping-tab` | Field Mapping tab (จับคู่ฟิลด์) | data | P6 |
| `screen-data-flow-tab` | Data Flow tab (การไหลของข้อมูล) | data | P6 |
| `screen-data-livedata-tab` | Live Data tab (ตรวจข้อมูล) | data | P6 |
| `screen-products-inventory` | Products & Inventory (สินค้า/สต็อก) | products | P4 |
| `screen-users-roles` | Users & Roles (จัดการผู้ใช้) | users | P4 |
| `screen-design-spec-hub` | Design Spec hub (เอกสารดีไซน์) | docs | P6 |
| `overlay-receipt` | Receipt modal (ใบเสร็จ 80mm) | pos | P3 |
| `overlay-sale-detail-drawer` | Sale Detail drawer | sales | P5 |
| `overlay-sync-detail-drawer` | Sync Detail drawer | data | P6 |
| `overlay-add-user-modal` | Add User modal (เพิ่มผู้ใช้ใหม่) | users | P4 |
| `action-set-role-seller` | Switch to Seller role (setRoleSeller) | global | P4 |
| `action-set-role-admin` | Switch to Admin role (setRoleAdmin) | global | P4 |
| `action-set-pay-amount` | Set split-line amount (setPayAmount) | pos | P3 |
| `action-add-pay-line` | Add split-payment line (addPayLine) | pos | P3 |
| `action-remove-pay-line` | Remove split-payment line (removePayLine) | pos | P3 |
| `action-pay-reference` | Payment reference no (onPayRef) | pos | P3 |
| `action-tax-toggle` | Request tax invoice toggle (toggleTax) | pos | P6 |
| `action-print-receipt` | Print receipt 80mm (printReceipt) | pos | P3 |
| `action-email-receipt` | Email/share receipt link (toastEmail) | pos | P3 |
| `action-customer-search` | Customer search (onCustQuery) | pos | P6 |
| `action-pick-customer` | Pick customer (pickCustomer) | pos | P6 |
| `action-sales-search` | Sales search (onSalesQuery) | sales | P5 |
| `action-sales-filter-chips` | Sales filter chips | sales | P5 |
| `action-open-sale-detail` | Open sale detail (openSaleDetail) | sales | P5 |
| `action-refund-sale` | Refund sale + credit note (refundSale) | sales | P5 |
| `action-void-sale` | Void sale (voidSale) | sales | P5 |
| `action-request-tax-invoice` | Request tax invoice from history (requestTax) | sales | P6 |
| `action-print-from-history` | Reprint from history (printFromHistory) | sales | P5 |
| `action-db-test-connection` | Test KRS connection (testConnection) | data | P6 |
| `action-db-insert-test-row` | Insert test row (insertTestRow) | data | P6 |
| `action-db-edit-fields` | Edit connection fields (setDb) | data | P6 |
| `action-db-toggle-ssl` | Toggle SSL/TLS (toggleDbSsl) | data | P6 |
| `action-db-set-table` | Select Live Data table (setDbTable) | data | P6 |
| `action-pull-from-krs` | Pull data from KRS (pullFromKRS) | data | P6 |
| `action-sync-card-filter` | Sync status card filter (setSyncFilter) | data | P6 |
| `action-open-sync-detail` | Open sync detail (openSyncDetail) | data | P6 |
| `action-retry-sync` | Retry sync job (retrySync) | data | P6 |
| `action-skip-sync` | Skip sync job with reason (skipSync) | data | P6 |
| `action-set-stock-method` | Set stock accounting method (setStockMethod) | data | P6 |
| `action-set-sync-mode` | Set sync mode (setSyncMode) | data | P6 |
| `action-set-data-tab` | Switch KRS data tab (setDataTab) | data | P6 |
| `action-receive-stock` | Receive stock / GRN (receiveStock) | products | P4 |
| `action-add-product-button` | Add product button | products | P4 |
| `action-products-search` | Products search (onProdQuery) | products | P4 |
| `action-user-filter-chips` | User role filter chips (setUserFilter) | users | P4 |
| `action-open-add-user` | Open add-user modal (openAddUser) | users | P4 |
| `action-set-nu-fields` | Edit new-user fields (setNu) | users | P4 |
| `action-save-user` | Save new user (saveUser) | users | P4 |
| `action-toggle-user-status` | Activate/deactivate user (toggleUserStatus) | users | P4 |
| `action-docs-tab` | Switch design-spec tab (setDocsTab) | docs | P6 |
| `action-counted-cash` | Enter counted cash (onCounted) | shift | P5 |
| `action-close-shift` | Close shift + daily summary (closeShift) | shift | P5 |
| `action-close-customer-picker` | Close customer picker (closeCustPicker + backdrop) | pos | P6 |
| `action-close-receipt-newsale-only` | Receipt modal dismissal is New-Sale-only (no X, no backdrop) | pos | P3 |
| `action-close-sale-detail` | Close sale detail drawer (closeSaleDetail + backdrop) | sales | P5 |
| `action-close-sync-detail` | Close sync detail drawer (closeSyncDetail + backdrop) | data | P6 |
| `action-close-add-user` | Close add-user modal (closeAddUser / cancel / backdrop) | users | P4 |
| `action-stop-propagation` | Modal/drawer inner-click guard (stop) | global | P1 |
| `state-product-in-cart` | Product in-cart indicator | pos | P2 |
| `state-cash-change-display` | Cash change display | pos | P3 |
| `state-sale-status` | Sale status enum | sales | P5 |
| `state-sync-empty` | Sync table empty state | data | P6 |
| `state-sales-empty` | Sales table empty state | sales | P5 |
| `state-db-connection` | DB connection status (connected/testing/disconnected) | data | P6 |
| `state-shift-closed` | Shift closed state | shift | P5 |
| `state-variance` | Cash variance state | shift | P5 |
| `state-mapping-incomplete` | Field-mapping incomplete state | data | P6 |
| `state-customer-has-tax` | Customer tax-info state | pos | P6 |
| `state-user-active-inactive` | User active/inactive state | users | P4 |
| `state-pay-method-locked-line` | Locked split-payment line logic | pos | P3 |
| `rolegate-seller-vs-admin` | Role-gated menu access (navAccess) | global | P4 |
| `rolegate-seller-permissions` | Seller permission set | users | P4 |
| `rolegate-admin-permissions` | Admin permission set | users | P4 |
| `flow-shift-lifecycle` | Flow: open shift → sell → close shift / daily summary | shift | P5 |
| `flow-product-stock` | Flow: product CRUD + stock movement | products | P4 |
| `flow-sales-history-reprint-refund` | Flow: sales history → reprint / refund / void / tax invoice | sales | P5 |
| `domain-receipt-80mm` | 80mm thermal receipt format | pos | P3 |
| `domain-no-destructive-delete` | No destructive delete (void/refund only) | global | P5 |
| `domain-tax-invoice-requires-tax-customer` | Tax invoice requires customer with tax ID | pos | P6 |
| `domain-synced-bills-locked` | Synced bills locked from direct edits | global | P5 |
| `domain-mapping-blocks-sync` | Incomplete mapping blocks sync | data | P6 |
| `domain-accounting-providers` | External accounting providers / KRS integration | data | P6 |
| `domain-currency-baht` | Currency ฿ THB formatting | global | P1 |
| `domain-receipt-shortid` | Receipt shortId = last 6 of posNo | pos | P3 |
| `display-payment-method-breakdown` | Sales-by-payment-method breakdown (shift) | shift | P5 |
| `display-outbound-field-map` | Outbound field-map table (POS→KRS) | data | P6 |
| `display-inbound-field-map` | Inbound field-map table (KRS→POS) | data | P6 |
| `display-account-mappings` | Account mapping tables (product/payment/tax/inventory) | data | P6 |
| `display-sync-mode-options` | Sync-mode option cards | data | P6 |
| `display-stock-method-options` | Stock-method option cards | data | P6 |
| `display-receipt-sync-badge` | Receipt sync-status badge | pos | P3 |
| `display-faux-qr` | Receipt QR code (digital receipt link) | pos | P3 |
| `display-account-mapping-tables-LATENT` | Account mapping tables are computed but NOT rendered (latent) | data | P6 |
| `display-sync-mode-cards-LATENT` | Sync-mode option cards computed but NOT rendered (latent) | data | P6 |
| `display-stock-method-cards-LATENT` | Stock-method option cards computed but NOT rendered (latent) | data | P6 |
| `display-docs-overview-panel` | Design Spec — Overview panel | docs | P6 |
| `display-docs-ia-matrix` | Design Spec — IA / Sitemap permission matrix | docs | P6 |
| `display-docs-flows-panel` | Design Spec — Key user flows panel | docs | P6 |
| `display-docs-screen-list` | Design Spec — Screen list (MVP) panel | docs | P6 |
| `display-docs-component-inventory` | Design Spec — Component inventory panel | docs | P6 |
| `display-docs-tokens-panel` | Design Spec — Design tokens panel | docs | P6 |
| `display-docs-copy-panel` | Design Spec — UX copy (TH/EN) panel | docs | P6 |
| `display-docs-rules-panel` | Design Spec — Accounting UX rules panel | docs | P6 |
| `display-docs-visual-directions` | Design Spec — 2 Visual directions panel | docs | P6 |
| `display-docs-impl-notes` | Design Spec — Implementation notes panel | docs | P6 |
| `display-receipt-line-detail` | Receipt line-item detail format (qty × unit price) | pos | P3 |
| `display-receipt-payment-fallback` | Receipt payment-lines fallback | pos | P5 |
| `display-db-preview-row-builders` | Live Data per-table synthetic row builders | data | P6 |
| `display-seed-sync-jobs` | Seed sync-jobs dataset (8 jobs, types, errors, responses) | data | P6 |
| `display-seed-sales-dataset` | Seed sales dataset (6 bills with statuses/sync/acct numbers) | sales | P5 |
| `domain-posno-seq-formula` | New POS number sequence formula (sales.length + 42) | pos | P3 |
| `domain-receipt-shortid` | Receipt shortId = last 6 of posNo | pos | P3 |
| `state-live-status-fields-extra` | Live-status extra fields (liveSub) + tri-state styling tokens | global | P6 |
| `domain-vat-proportional-discount-allocation` | VAT recomputed with proportional discount allocation | global | P2 |
| `domain-stock-default-50` | Default stock fallback = 50 for unmapped ids | products | P2 |
| `domain-nav-en-and-titles-mismatch` | Nav labels vs view titles divergence | global | P1 |
| `domain-realtime-stock-sync` | Realtime stock sync to KRS | data | P6 |
| `nav-sidebar` | Sidebar navigation | global | P1 |

## 8. Cross-program dependencies (with `production-readiness`)

- **Real auth + RBAC** (prod-readiness Phase 1) — required before redesign **Phase 4** role-gating is real; also unblocks the `/login` backend (see addendum) + route-protection middleware.
- **Zod input validation** — backs every new form/endpoint (product/user/payment/refund).
- **Decimal-safe money + atomic stock decrement** — underpins **P2** (VAT/discount totals), **P3** (payment/change), **P5** (refund/reconciliation). Do not ship float money.
- **Idempotency + audit trail** — underpins **P3** (double-submit) and **P5/P6** (no destructive delete, void/refund, sync queue).
- **Migration discipline** — versioned `prisma migrate` for branchId/Customer/Shift/StockMovement/SyncJob.

## 9. Risks & open questions

1. **KRS integration target undefined** (MySQL KRS + PEAK/FlowAccount/Xero/QuickBooks) → Phase 6 builds against a stub/provider abstraction.
2. **Customer/member model absent** → Phase 6 needs a new `Customer` model + tax fields.
3. **pguard vs KRS brand** — `design/_ds` is pguard; approved KRS look is the Taste file. Do not derive a KRS design system from pguard without owner approval.
4. **Receipt/tax-invoice legality** — 80mm + Thai ใบกำกับภาษี (sequential numbering, 7% VAT) per Revenue Dept rules.
5. **Auth not real yet** — `/login` is a stub; route protection/RBAC depend on production-readiness.

## 10. Blast radius / touchpoints

- **UI:** `src/app/**` (shell/layout done; routed screens; shared component library; `error.tsx`).
- **New API routes:** users, shift, refund/void, stock-movement, sync-jobs, customers (per phase).
- **Schema (Prisma):** `branchId`, `Customer`, `Shift`, `StockMovement`, `SyncJob`, `User.isActive`, + wire dormant `discount`/`tax`/`paymentType`/`OrderStatus` — via tracked migrations.
- **Seed:** expand to 17 products / 4 categories + sample sales/sync/users.

## 11. How to execute (resume handoff)

Run **one phase at a time** via `process/development-protocols/phase-programs.md`:

1. RESEARCH (re-read this plan + both design files + code drift).
2. Execution approval.
3. EXECUTE only that phase’s functions.
4. VALIDATE (type-check + build + functional checks).
5. Regression-check earlier phases, durable report, commit, inter-phase UPDATE PROCESS.

**Loop:** Research → Approval → Execute → Validate → Regression → Report → Commit → Next phase.

---

## Addendum (2026-06-20) — Login screen (new requirement, not in Simple POS)

`screen-login` was NOT in `Simple POS.dc.html` (which used a demo role-switcher, not real auth). It is a real product requirement and a critical security gap. Tracked here so it is not lost:

- **UI: DONE** — `src/app/login/page.tsx` (Taste split-screen sign-in, **outside** the `(shell)` rail). Submit is a **stub** (client-validate → toast → `router.push('/pos')`); a visible "เดโม / Demo" badge marks it non-functional.
- **Auth backend: DEFERRED to `production-readiness` Phase 1** — password hashing, session (Auth.js/Lucia), httpOnly cookie, RBAC, and **route-protection middleware** gating `(shell)` + redirect to `/login`. Until then `/login` does not authenticate.
- **Related:** rail logout + the redesign `rolegate-*` functions (Phase 4) depend on this auth backend.

## Appendix A — Simple POS states (62)

`cart-empty` · `cart-has-items` · `product-in-cart` · `no-products-match-search` · `low-stock (<=10)` · `out-of-stock (0)` · `stock-flash-on-update` · `live-realtime (DB connected)` · `live-connecting (DB testing)` · `live-offline (DB disconnected)` · `payment-method-active` · `split-payment-multiple-lines` · `cash-line-present (show cash panel)` · `change-due` · `payment-error-amount-mismatch` · `payment-error-insufficient-cash` · `payment-error-tax-without-tax-customer` · `tax-requested` · `tax-warning (customer lacks tax info)` · `sale-paid` · `sale-refunded` · `sale-voided` · `sync-pending` · `sync-synced` · `sync-daily (in daily summary)` · `sync-failed` · `sync-retrying` · `sync-skipped` · `sync-queue-has-pending` · `sync-table-empty` · `sales-table-empty` · `db-connected` · `db-testing` · `db-disconnected` · `mapping-complete` · `mapping-incomplete (sync blocked)` · `shift-open` · `shift-counting` · `shift-closed` · `variance-balanced` · `variance-over` · `variance-short` · `stock-sync-on` · `stock-sync-off` · `stock-method-perpetual` · `stock-method-periodic` · `sync-mode-realtime` · `sync-mode-daily` · `sync-mode-manual` · `role-seller (limited menus)` · `role-admin (all menus)` · `user-active` · `user-inactive` · `add-user-validation-error` · `customer-walk-in` · `customer-selected` · `customer-has-tax` · `modal-open (customer-picker/payment/receipt/add-user)` · `drawer-open (sale-detail/sync-detail)` · `toast-visible (auto-dismiss 2.2s)` · `accounting-doc-issued` · `accounting-doc-pending (— รอออกเอกสาร —)`

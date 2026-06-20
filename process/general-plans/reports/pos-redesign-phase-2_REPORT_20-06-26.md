# POS Redesign — Phase 2 REPORT (Checkout core redesign)

- Date: 2026-06-20
- Plan: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (Phase 2)
- Research: `process/general-plans/reports/pos-redesign-phase-2_RESEARCH_20-06-26.md`
- Status: ✅ **build-verified + pricing-tested** · ⏳ live `/pos` DB smoke pending (no Docker/DB available here)
- Scope: `/pos` checkout core only — **no Phase 3** (payment modal / receipt / hold-bill); pay-button entry point preserved.

## What was built (19 Phase-2 functions)

Rewrote `/pos` into the Taste 3-column register (rail preserved). Function coverage:

- `screen-pos-checkout` — Taste 3-col layout (category panel · product grid · cart).
- `action-product-search` — case-insensitive filter on name + SKU + category name; **Enter on exact SKU = scan-to-cart**.
- `action-category-filter` — chips (ทั้งหมด + derived categories) via name→{slug,icon} map (`components/pos/categoryMeta.ts`).
- `action-add-to-cart` / `-cart-inc` / `-cart-dec` / `-cart-remove` — add (inc-if-present) + toast; +/− steppers; explicit remove; dec re-clamps per-line discount.
- `action-line-discount` — per-line ฿ discount, clamped to `[0, lineGross]`.
- `action-bill-discount` + `action-toggle-disc-type` — bill discount with **฿/% toggle** (percent clamp 100, amount clamp subtotal).
- `action-cancel-bill` — clears cart + discounts + toast.
- `state-cart-empty` / `state-no-products-found` / loading / error — all four states render (no blank screen).
- `state-product-in-cart` — ✓ + qty badge on the product card.
- `state-low-out-of-stock` — `stock<=10` amber; `stock===0` shows "หมด" + disables add.
- `display-seed-catalog` — `prisma/seed.ts` expanded to **4 categories / 17 products** (edited, not applied — needs DB).
- `domain-vat-7-inclusive` + `domain-vat-proportional-discount-allocation` — `lib/pricing.ts`.
- `domain-stock-default-50` — defensive 50 fallback if a payload omits stock.

## Money math — integer satang (the highest risk, mitigated)

`src/lib/pricing.ts` is pure and does **all arithmetic in integer satang** (baht→satang once at the boundary via `bahtToSatang = Math.round(Number(price)*100)`); display via `formatSatang` → `money(satang/100)`. No float math on baht totals.

- VAT-inclusive per line: `lineVat = round(lineFinal * 7 / 107)`; `vatSatang = Σ lineVat`.
- Bill discount allocated proportionally by line net; rounding remainder added to the largest line so `Σ alloc === billDiscountSatang`.
- **Invariant `subtotalSatang − billDiscountSatang === totalSatang` is exact.**

**Independent verification (orchestrator, via `tsx`):** 8 baskets (no-discount, bill amount, bill percent, per-line, combined, percent>100 clamp, amount>subtotal clamp, empty) × 4 invariants = **32/32 checks passed**. (Full Decimal end-to-end remains a production-readiness P2 item; satang keeps Phase 2 exact in the meantime.)

## Files
- **Created:** `src/lib/pricing.ts`, `src/components/pos/{categoryMeta.ts,CategoryPanel.tsx,ProductCard.tsx,CartLine.tsx,TotalsBar.tsx}`
- **Edited:** `src/app/(shell)/pos/page.tsx` (rewrite), `src/lib/money.ts` (+`formatSatang`), `src/types/index.ts` (`CartItem.lineDiscountSatang`, `CategorySlug`, `DiscountType`), `prisma/seed.ts` (4 cats / 17 products)

## Verification
- `npm run type-check` — **PASS**
- `npm run build` — **PASS** (`/pos` = 9.53 kB; all 15 routes compile)
- `lib/pricing.ts` invariants — **32/32 PASS** (tsx)
- ⏳ **Live `/pos` smoke not run** — no Docker/DB in this environment. To smoke: `docker compose up -d db` → `cp .env.example .env` (set vars) → `npm run prisma:generate && npm run db:push && npm run prisma:seed` (applies the 17-item catalog) → `npm run dev` → exercise browse/search/category/cart/discount/VAT.

## Regression (vs Phase 0 / Phase 1)
- **PASS (static):** all routes still build; shell/rail/routing untouched. `git diff` confirms **no changes** to `prisma/schema.prisma`, `src/app/api/**`, `src/lib/prisma.ts`, `(shell)/layout.tsx`, `NavRail`, `ToastProvider`, `Modal`, `/login`.
- Phase 0 password-leak fix intact (orders route untouched). Pay button preserves the existing cash-checkout entry point (POST `/api/orders`).

## Deviations / notes (none material)
1. Product grid uses `repeat(auto-fill, minmax(184px,1fr))` (adapts to width) rather than a hard 3-col — preserves the Taste 184px card minimum.
2. Per-line VAT sum can differ from `round(total*7/107)` by ≤1 satang on odd splits — this is the specified algorithm; the load-bearing `subtotal−disc=total` invariant is exact.
3. Server-side inclusive-tax recompute + idempotency are intentionally **deferred to Phase 3 / production-readiness** (`// TODO(phase3)` left on the pay path).

## Next
- Mark Phase 2 ✅ done in plan + timeline (this report's commit).
- **Phase 3** (payment + receipt/print + hold bill) is the next phase — begin with its own RESEARCH on approval.
- Before sign-off: run the live DB smoke when a database is available.

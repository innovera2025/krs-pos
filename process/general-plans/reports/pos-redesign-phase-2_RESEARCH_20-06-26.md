# POS Redesign — Phase 2 RESEARCH (Checkout core redesign)

- Date: 2026-06-20
- Plan of record: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (Phase 2)
- Canonical timeline: `process/general-plans/references/pos-redesign-timeline_20-06-26.html`
- Scope: `/pos` checkout core only — **no Phase 3 payment/receipt** (preserve the pay-button entry point only)
- This is research only — no implementation files were modified.

## 1. Current state (Phase 1 baseline)

`src/app/(shell)/pos/page.tsx` is the **relocated OLD** checkout (blue/slate Tailwind), rendered inside the new forest rail shell:
- Loads products via `fetch("/api/products")` (AbortController added) → DB-dependent; on failure shows Thai "load failed".
- Client search filters **name + sku only** (no EN, no category).
- Product grid: plain cards (name, sku, `฿price.toFixed(2)`, stock) — no low-stock styling, no in-cart badge, no category panel.
- Cart: add (inc-if-present), `updateQty(±1)` (removes at 0). **No** explicit remove, **no** per-line discount, **no** bill discount, **no** VAT.
- Totals: `subtotal = Σ Number(price)*qty` (float), labelled "รวมทั้งสิ้น". No VAT, no discount.
- Pay button "ชำระเงิน" → `checkout()` POSTs `/api/orders` (cash, `amountPaid=subtotal`). **This is the entry point to preserve.**

Supporting baseline (do NOT change in Phase 2): rail/shell/routing, `ToastProvider` (`useToast`), `Modal`, `money()` (guarded), theme tokens, IBM Plex.

Schema (`prisma/schema.prisma`, unchanged in P2): `Product { price Decimal(10,2), stock Int @default(0), isActive, categoryId → Category{name} }`. API `GET /api/products` returns active products incl. `category`.

Seed (`prisma/seed.ts`): **6 products / 3 categories** (เครื่องดื่ม/ขนม/ทั่วไป) — does NOT match the Taste 17-item / 4-category catalog.

## 2. Target state (Taste + Simple POS behavior)

Taste 3-column register for `/pos`: **category panel (168px) + searchable product grid + cart with discounts + VAT-inclusive totals**, forest/mint/accent, IBM Plex mono money, low-stock + in-cart states.

**Critical:** the Taste mock is *simplified* (`vat = total*7/107`, bill discount amount-only, no per-line discount, no proportional allocation). Per the plan caveat, **Simple POS behavior wins** — Phase 2 implements the fuller Simple POS math: per-line discount + bill discount (฿ **or** %) + **proportional discount allocation** + VAT-inclusive per line.

## 3. Function-by-function mapping (19 = 18 + screen)

| Function (Simple POS) | Current | Target / how | Where |
|---|---|---|---|
| `screen-pos-checkout` | old 2-pane | Taste 3-col register | rewrite `(shell)/pos/page.tsx` |
| `action-product-search` | name+sku | name+EN+sku (case-insens.); Enter on exact SKU = add-to-cart (scan) | page + filter util |
| `action-category-filter` | none | chips: ทั้งหมด + 4 cats (icon+TH+EN); derive from product categories via name→slug/icon map | `CategoryPanel` |
| `action-add-to-cart` | yes | click card adds (inc if present) + toast `เพิ่ม {name} แล้ว` | page |
| `action-cart-inc` | yes (±) | + stepper | `CartLine` |
| `action-cart-dec` | yes (±, remove at 0) | − stepper, remove at 0 | `CartLine` |
| `action-cart-remove` | none (dec-to-0 only) | explicit trash/remove control | `CartLine` |
| `action-line-discount` | none | per-line discount (฿) entry; clamp 0..lineGross | `CartLine` + pricing |
| `action-bill-discount` | none (sends 0) | bill discount input | `TotalsBar` + pricing |
| `action-toggle-disc-type` | none | ฿/% toggle (percent clamp 100, amount clamp subtotal) | `TotalsBar` |
| `action-cancel-bill` | none | "ยกเลิกบิล" clears cart + discount + toast | `TotalsBar`/cart actions |
| `state-cart-empty` | basic text | Taste empty illustration ("ตะกร้าว่าง…") + pay disabled | `Cart` |
| `state-no-products-found` | basic text | "ไม่พบสินค้า · No matching products" | grid |
| `state-product-in-cart` | none | in-cart ✓ badge + qty on product card | `ProductCard` |
| `state-low-out-of-stock` | none | low (`stock<=10`, amber) + out-of-stock (`stock===0`, disable add) styling | `ProductCard` |
| `display-seed-catalog` | 6/3 | expand seed → **17 products / 4 categories** matching Taste (drink/food/dessert/goods) | `prisma/seed.ts` (seed, not schema) |
| `domain-vat-7-inclusive` | none | VAT = afterDiscount × 7/107 (prices VAT-inclusive) | `lib/pricing.ts` |
| `domain-vat-proportional-discount-allocation` | none | allocate bill discount across lines proportionally; per-line VAT = lineFinal×7/107; Σ = total VAT | `lib/pricing.ts` |
| `domain-stock-default-50` | n/a (stock always Int) | defensive: default 50 only if stock is null/undefined in the API payload | mapping util |

## 4. UI-only vs backend

**Phase 2 = UI-only + seed expansion. No schema change, no API change.**
- All checkout UI/logic operates on whatever `GET /api/products` returns.
- The 17-item catalog requires the **seed** (`prisma/seed.ts`) expanded to 17/4 — a seed edit, NOT schema. **Applying** it needs a running DB (`docker compose up -d db` → `db:push` → `prisma:seed`); `type-check`/`build` do not.
- Category chips/icons: schema `Category` has only `name`; derive a stable `slug`+icon in the UI via a name→{slug,icon} map keyed on the seed's 4 category names (เครื่องดื่ม/อาหาร/ขนมหวาน/ของใช้).
- Pay button: keep the **existing** cash-checkout entry point (POST `/api/orders`) so `/pos` stays functional; the real payment modal/receipt is Phase 3.

## 5. Files likely to touch

- `src/app/(shell)/pos/page.tsx` — rewrite (client component; Taste 3-col).
- `src/components/pos/` — new: `CategoryPanel.tsx`, `ProductGrid.tsx`/`ProductCard.tsx`, `Cart.tsx`/`CartLine.tsx`, `TotalsBar.tsx` (granularity at execute-agent's discretion).
- `src/lib/pricing.ts` — **new**, pure, **integer-satang** math (VAT-inclusive + per-line/bill discount + proportional allocation). Avoids JS float drift; structured so production-readiness can swap to Decimal.
- `src/lib/money.ts` — reuse; may add a `formatSatang` helper.
- `src/types/index.ts` — extend `CartItem` (qty, lineDiscount) / category slug if needed.
- `prisma/seed.ts` — expand to 17 products / 4 categories (seed only).
- (avoid broad `globals.css` edits; prefer Tailwind tokens added in Phase 1.)

**Must NOT touch:** `prisma/schema.prisma`, `src/app/api/**`, `src/lib/prisma.ts`, `(shell)/layout.tsx`, `NavRail`, `ToastProvider`, `Modal`, `/login`.

## 6. Risks

1. **Money math / VAT-inclusive (highest):** float drift. **Mitigation:** do all arithmetic in **integer satang** (`Math.round(price*100)`) in `lib/pricing.ts`, round once, format via `money()`. Invariant: `subtotal − billDiscount === total` and `Σ lineVat === round(total×7/107)`. (Full Decimal end-to-end remains a production-readiness P2 item; satang keeps P2 exact in the meantime.)
2. **JS float vs Decimal/satang:** API serializes Decimal → number/string; coerce to satang immediately, never `Number()`-math on baht floats for totals.
3. **Stock display vs real mutation:** Phase 2 only **displays** stock + low/out states. **No stock decrement** — that stays in the existing checkout POST (Phase 3 hardens it). Out-of-stock disables add (client-side only).
4. **API/DB dependency:** `/pos` needs a DB. Must keep graceful **loading / empty / error** states (no blank screen). Seed apply needs DB; note in report.
5. **Preserve Phase 1:** render inside shell `<main>` using `h-full` (not `h-screen` — already corrected); do not touch rail/routing/providers; reuse `useToast()`.
6. **Category mapping:** Category has only `name`; rely on a name→slug/icon map. If seed category names differ from the map, chips lose icons → keep a generic fallback icon.

## 7. Verification checklist (Phase 2 gate)

- `npm run type-check` ✅ · `npm run build` ✅ (lint not configured)
- `/pos` renders Taste 3-col (rail preserved); search filters name/EN/SKU; category chips filter
- add card → in-cart badge + toast; +/−/remove adjust cart; empty + no-result states
- per-line discount + bill discount (฿/%) recompute; **VAT-inclusive totals foot** (`subtotal−disc=total`, `vat=total×7/107`)
- low (`<=10`) amber + out-of-stock (`0`) disable-add styling
- pay button disabled on empty cart; preserved entry point still completes a sale (existing POST)
- a11y: search + qty controls labelled (closes deferred review item)
- manual smoke with DB: `docker compose up -d db` → `db:push` → `prisma:seed` (17 items) → `npm run dev`

## 8. Recommended execution order

1. `lib/pricing.ts` (pure satang math) — foundation, unit-testable.
2. `prisma/seed.ts` → 17/4 catalog.
3. `(shell)/pos/page.tsx` + `components/pos/*` — category panel → product grid (states) → cart (lines, discounts) → totals bar (VAT, bill discount ฿/%, cancel) → preserve pay-button entry.
4. type-check + build → manual smoke → report → commit.

## 9. Plan / timeline updates needed

- None structural. Phase 2 scope matches the plan. After EXECUTE, mark Phase 2 status `▶ next → ✅ done` (build-verified) in the plan/timeline and note seed expansion (6→17 products, 3→4 categories) as a P2 deliverable.

## Readiness

**Phase 2 is READY for EXECUTE.** Scope is UI-only + a seed edit; no schema/API/migration. The one real hazard (money math) is mitigated by integer-satang arithmetic in a pure `lib/pricing.ts`. DB is required only to *apply* the seed and run a live smoke; `type-check`/`build` validate without it.

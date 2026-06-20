# Phase 5 Research — Shift Open/Close + Z-Report + Sales History (Refund/Void/Reprint)

- Date: 2026-06-20
- Plan: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (Phase 5, 23 functions)
- Depends on: Phase 3 (orders/payments) + Phase 4 (branchId, users). Cross-program: real refund integrity/audit/sync-lock/Decimal/auth = `production-readiness` (not built).
- Scope: Sales History (search/filter/detail-drawer/refund/void/reprint) + Shift Close (Z-report/cash-count/variance/daily summary). Customer/tax-invoice + real KRS sync = **Phase 6**.

## 1. Current state
- **Order**: `id, orderNumber(unique posNo), status OrderStatus@default(COMPLETED), subtotal/tax/discount/total/amountPaid/change Decimal(10,2), paymentType, branchId@default("BR-01"), cashierId?, payments PaymentLine[], items OrderItem[], createdAt, updatedAt`.
- **`OrderStatus` enum (exact)**: `PENDING · COMPLETED · REFUNDED · CANCELLED`. **No `VOIDED`** (Simple POS treats void ≠ cancelled).
- **No `Shift` model. No `syncStatus`/`accountingDocNo`/`taxRequested` on Order** (Simple POS shows sync state + TAX-/CN- doc numbers + tax flag — none persisted yet).
- `GET /api/orders`: 50 most-recent, includes `items.product` + `cashier{id,name}` — **omits `payments`** (needed for sales list + reprint).
- `POST /api/orders`: posNo `POS-YYYYMMDD-####` (Asia/Bangkok via `bangkokDateParts()`), server-recomputes per-line price only; bill totals trusted from client (TODO production-readiness).
- `/sales` + `/shift`: pure placeholders.
- **Reusable**: `Modal`, `ReceiptModal` (reprint — needs payment fallback), `useToast`, `money`/`formatSatang`, `pricing.ts`, `paymentMeta.methodLabel()`, `bangkokDateParts()`. `OrderDTO` already declares `payments`.

## 2. Target (Simple POS, Taste-ported — no Taste mock for /sales or /shift)
**/sales:** table (posNo · time · customer·acctDoc · amount · status · sync · actions); search by posNo/customer; 6 filter chips (all/paid/refunded/voided/sync-failed/tax). Status badges paid(green)/refunded(amber)/voided(slate). Sale-detail **right drawer** (440px, slideIn, backdrop close): status+sync, total/VAT/method/acctDoc, walk-in warning; actions ขอใบกำกับ(P6)/คืนเงิน(if paid)/ยกเลิก(if paid & !synced)/พิมพ์. Refund→status refunded + credit-note toast (total preserved/negative). Void→status voided, total/vat→0, sync→skipped (only if !synced). Reprint→ReceiptModal w/ `pays || [{label:method, amount:total}]` fallback. Empty state.
**/shift:** dark KPI gross-sales card (shift id `SH-…`, open time, txn count); by-payment-method table (label/count/amount); 3 cards refunds(−)/discounts(−)/output-VAT; cash-counting panel (opening float + cash sales − cash refunds = expected; counted input; variance green=balanced/amber=over/red=short); close → "สรุปบัญชีรายวัน DS-YYYYMMDD" success state. **Both screens must be ported into Taste** (Panel/Table/Badge/Chip/Drawer + forest dark KPI).
**Seed dataset (6 bills, POS-20260616-0036..0041):** paid/synced+TAX doc+transfer; paid/daily+cash; paid/sync-failed+tax-flag+QR; **refunded −฿65 + CN doc**; **voided ฿0 skipped**; paid/daily+card.

## 3. ⚠️ Full-stack decisions

| # | Gap | Options | Recommendation |
|---|---|---|---|
| **A** | No `Shift` model; Simple POS tracks shift id + open time + opening float + daily summary | (A1) Shift model **without** FK on Order → Z-report aggregates by **Asia/Bangkok day window**; **POST /api/orders untouched** (no P3 regression) · (A2) add `shiftId?` on Order → per-shift-accurate but **modifies the P3 checkout POST** | **A1** — faithful enough (open float/counted cash/variance/close-summary all work), zero checkout regression risk. A2 only if true multi-shift-per-day accuracy is required now |
| **B** | `OrderStatus` has no `VOIDED`; void≠cancelled in Simple POS | add `VOIDED` to enum (keep `CANCELLED`); refund→`REFUNDED`, void→`VOIDED`+zero totals | **add `VOIDED`** (status-transition only, append-only, **no DELETE** ever — `domain-no-destructive-delete`). Credit-note as a separate doc = P6/accounting |
| **C** | Z-report sums (gross, by-method, refunds, discounts, VAT, cash, variance) | aggregate stored `Decimal` via Prisma `aggregate`/`groupBy`, **serialize as String** (not `Number()`); satang where computed | **Prisma Decimal→String** (matches P3 precedent; full Decimal-recompute = production-readiness). No separate go-ahead needed |
| **D** | Seed needs sync state + doc numbers + tax flag; void-lock needs sync state | add `syncStatus`(enum/String @default pending) + `accountingDocNo?` + `taxRequested Boolean@default(false)` on Order | **add all 3** (nullable/defaulted → POST /api/orders unaffected). `syncStatus` is a **stub field** so the void-lock rule works; real sync lifecycle = P6 |

→ Phase 5 = **migration #3** (Shift + ShiftStatus enum + VOIDED + 3 Order fields) + new APIs (shift open/close+Z-report, order refund/void PATCH) + GET orders adds `payments` + 2 screens + seed.

## 4. Cross-program boundaries
**In-scope now:** status transitions (refund/void) with server pre-checks; `syncStatus`/`accountingDocNo`/`taxRequested` fields + seed; Shift model + open/close + Z-report aggregation; cash-count/variance (client-computed); sales table/filter/search/drawer; reprint w/ payment fallback; GET orders `payments`.
**Production-readiness (NOT P5):** real KRS sync + syncStatus lifecycle; credit-note as accounting document; Decimal end-to-end recompute; idempotency on refund/void; real void-lock tied to sync confirmation; auth-gated + audited refund/void (who/when); atomic stock reversal on refund.

## 5. Files likely to touch
- **schema + migration #3**: `Shift` model + `ShiftStatus` enum; `VOIDED` on `OrderStatus`; `syncStatus`(+enum?)/`accountingDocNo?`/`taxRequested` on Order. `prisma migrate dev --name phase5_shift_sales_status`.
- **seed**: 6 order upserts (`where:{orderNumber}`) + PaymentLine rows (incl. negative refund total, zeroed void).
- **API new**: `src/app/api/orders/[id]/route.ts` (PATCH refund/void w/ pre-checks); `src/app/api/shift/route.ts` (POST open/close + GET current shift + Z-report aggregates).
- **API modified**: `src/app/api/orders/route.ts` GET → add `payments:true` + optional status/sync filter.
- **screens/components**: rewrite `src/app/(shell)/{sales,shift}/page.tsx`; `src/components/sales/{SaleDetailDrawer, SalesTable, FilterChips}.tsx`; `src/components/shift/{ShiftSummaryCard, PaymentMethodBreakdown, CashCountingPanel, KpiCards}.tsx`.
- **ReceiptModal**: add payment fallback when `payments` empty.
- **types**: OrderStatus values, SyncStatus, extend OrderDTO (syncStatus/accountingDocNo/taxRequested/payments).

## 6. Risks
1. **Refund/void integrity** — pre-checks (refund: status COMPLETED; void: COMPLETED & sync≠synced) must be **server-side** in PATCH; route is open (no auth → production-readiness).
2. **Negative refund total** (`−65.00`) — Decimal supports it; `money()` sign-before-฿ handles display; gross-sales aggregate must exclude REFUNDED/VOIDED.
3. **`domain-no-destructive-delete`** — no DELETE route ever; comment loudly.
4. **Money aggregates** — serialize Decimal as String, not `Number()`, to avoid float drift across many bills.
5. **Regression** — PATCH `[id]` + shift routes are NEW files (no impact on GET/POST); GET adding `payments` matches existing `OrderDTO`; new Order fields are defaulted → checkout POST unaffected. A1 avoids touching POST entirely.
6. **Timezone** — shift/day windows in **Asia/Bangkok** (reuse `bangkokDateParts()`); Z-report filters `createdAt` within the Bangkok day (A1) or shift window (A2).
7. **Reprint fallback** — `ReceiptModal` currently maps `order.payments` with no fallback → add `pays || [{method,total}]` so seeded bills print.

## 7. Verdict + execution order
**Full-stack** (12 fn) + build-new-UI (11 fn). Order: (1) schema+migration #3 → (2) seed 6 bills → (3) GET orders +payments → (4) PATCH orders/[id] refund/void → (5) shift open/close+Z-report API → (6) /sales screen+drawer+reprint → (7) /shift screen → (8) type-check+build+live migration/smoke.

## 8. Readiness
**Ready for EXECUTE.** Two decisions need an explicit go-ahead: **A** (Shift↔Order linkage — recommend **A1**, no Order FK, zero checkout regression) and **B** (add **`VOIDED`** enum value). C and D follow P3 precedent / are additive-defaulted. Recommended bundle: **A1 · add VOIDED (B1) · Prisma-Decimal→String (C) · 3 new Order fields (D)** — minimum schema footprint covering all 23 functions, nothing dropped.

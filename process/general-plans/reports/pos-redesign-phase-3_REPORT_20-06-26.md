# POS Redesign — Phase 3 REPORT (Payment + receipt/print + hold bill)

- Date: 2026-06-20
- Plan: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (Phase 3, 28 functions)
- Research: `process/general-plans/reports/pos-redesign-phase-3_RESEARCH_20-06-26.md`
- Approved approach: **FULL faithful (full-stack)** — schema migration + API + UI
- Status: ✅ **build + type-check + tracked-migration + live `/pos` pay→order smoke ALL verified**
- Scope: payment + receipt/print + hold bill. Customer picker / tax invoice / real KRS sync = **Phase 6** (omitted intentionally).

## What was built (28 Phase-3 functions)

**Schema (`prisma/schema.prisma`) + tracked migration:**
- `enum PaymentType` → **6 values** (added `EWALLET`, `OTHER`).
- New model **`PaymentLine`** (`orderId`→Order cascade, `method PaymentType`, `amount Decimal(10,2)`, `reference?`, `createdAt`); `Order.payments PaymentLine[]` relation (kept `paymentType` as the primary/dominant method).
- First **tracked migration** `prisma/migrations/20260620114227_init_with_payments/` (baselines the schema incl. PaymentLine) + `migration_lock.toml` — repo now uses `prisma migrate` (aligns with production-readiness migration discipline).

**API (`src/app/api/orders/route.ts` POST):**
- Accepts `items`, `paymentLines:[{method, amount, reference?}]`, VAT-inclusive `subtotal/discount/tax/total/amountPaid/change` (baht), `cashierId?`.
- **posNo `POS-YYYYMMDD-####`** (count-of-today + 1, pad4) — replaces `ORD-${Date.now()}`.
- Validations → typed `{error, code}`: NO_ITEMS 400 · BAD_ITEM 400 · NO_PAYMENT 422 · PAYMENT_MISMATCH 422 (split sum ≠ total >0.01) · INSUFFICIENT_CASH 422 (cash & amountPaid<total) · PRODUCT_NOT_FOUND 404 · INTERNAL 500 (sanitized).
- Persists order + `PaymentLine` rows in one `$transaction` + stock decrement; primary `paymentType` = CASH if any cash line else first line.
- `// TODO(production-readiness)` left for Decimal-safe recompute, idempotency, atomic conditional stock, DB-sequence posNo (not regressed).

**UI:**
- `PaymentModal.tsx` — 6 method tiles, split add/remove, locked-line targeting, cash panel (quick-cash พอดี/฿100/฿500/฿1,000 + change-due), reference, payError, confirm-when-valid; X preserves payLines.
- `ReceiptModal.tsx` + `FauxQR.tsx` — 80mm thermal (`.print-receipt`), KRS header/branch/posNo/datetime/cashier, line detail (qty×price), subtotal/VAT/total, payment lines, change, sync badge "queued" (P6 placeholder), faux QR → `rcpt.krspos.co/{posNo.slice(-6)}`, print/email/**New-Sale-only** dismissal.
- `globals.css` — `@media print` 80mm `@page` + visibility isolation.
- `pos/page.tsx` — pay button opens PaymentModal (Phase-2 stub removed) → receipt; **hold bill** + cancel-bill (different toasts, both clear).
- `paymentMeta.ts` (method labels/icons), `pricing.ts` (+`sumPaySatang`/`remainingPaySatang`), `types/index.ts` (PayMethod/PayLine/OrderDTO).

## Verification (orchestrator, independent)
- `npm run type-check` — **PASS** · `npm run build` — **PASS** (`/pos` 14.8 kB)
- **Tracked migration applied** on fresh Postgres → `PaymentType` = CASH,CARD,QR,TRANSFER,EWALLET,OTHER (6); `PaymentLine` table exists; products=17.
- **Live pay smoke** (`next start` clean build + real DB): `GET /api/products` 200 → **`POST /api/orders` 201** → `orderNumber=POS-20260620-0001`, `paymentType=CASH`, `payments=["CASH ฿60"]`, change 0; **DB: orders=1, paymentlines=1**, posNo correct. `GET /pos` 200 (markers VAT 7% / ยอดสุทธิ / ตะกร้าว่าง), **0 module/SSR errors**. Ephemeral DB torn down after.

## Regression (vs P0/P1/P2)
- All routes build; shell/rail/login/Phase-2 cart+totals untouched (`git diff` confirms). Phase 0 GET `/api/orders` cashier `select` fix intact. Phase 2 `lib/pricing.ts` reused (extended, not broken).

## Deviations / notes
- None material. Customer/tax-invoice payment affordances intentionally omitted (Phase 6); receipt shows fixed "ลูกค้าทั่วไป" + a "queued" sync placeholder.
- Introduced the repo's **first tracked migration** this phase (was `db push`); the migration baselines the whole schema + payment additions.

## Production-readiness (deferred, not regressed)
Decimal-safe server recompute · idempotency key (double-submit) · atomic conditional stock decrement · DB-sequence posNo (collision-safe). All marked TODO in the orders route.

## Next
- Mark Phase 3 ✅ done in plan/timeline (this report's commit).
- **Phase 4** (Catalog/stock management + Users & Roles + RBAC; applies the deferred branchId migration) is next — begin with its own RESEARCH on approval.

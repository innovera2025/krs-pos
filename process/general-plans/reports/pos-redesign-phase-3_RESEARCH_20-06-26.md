# POS Redesign — Phase 3 RESEARCH (Payment + receipt/print + hold bill)

- Date: 2026-06-20
- Plan of record: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (Phase 3, 28 functions)
- Depends on: Phase 2 (done/committed/live-smoke-verified)
- Scope: complete the **sell → pay → receipt** flow + hold bill. **Customer picker / tax invoice are Phase 6** (this plan's structure), NOT Phase 3.
- Research only — no files modified.

## 1. Current state

- **`/pos` pay button (Phase 2):** `pay()` POSTs `/api/orders` with `{ items, paymentType:"CASH", amountPaid: total }` and a `// TODO(phase3)` marker. It's the preserved entry point — Phase 3 replaces it with the payment modal.
- **`POST /api/orders`:** float math; `tax = (subtotal − discount) * (taxRate/100)` (**EXCLUSIVE**), `total = subtotal − discount + tax`, `change = max(0, amountPaid − total)`, `orderNumber = ORD-${Date.now()}`, `$transaction` create + **unconditional** stock decrement, `paymentType as never`. No idempotency, no payment-lines, no posNo sequence.
- **Schema `Order`:** single `paymentType PaymentType`, `amountPaid`, `change`. **No** PaymentLine model, **no** `accountingDocNo`, **no** sync-status field.
- **`enum PaymentType` = CASH, CARD, QR, TRANSFER (4).**
- Phase 2 computes VAT **inclusive** in `lib/pricing.ts` (integer satang) — mismatches the server's exclusive tax.

## 2. Target (Simple POS payment/receipt — Taste-styled)

Payment modal (6 methods, split, cash+change, reference, validation) → confirm → 80mm receipt (print/email/QR/sync-badge/new-sale) → hold/cancel bill. Taste mock is simpler (3 methods, no split, no change-due); **Simple POS wins**.

## 3. ⚠️ Phase 3 is FULL-STACK — key decisions needed

| # | Gap | Options | Recommendation |
|---|---|---|---|
| **A** | 6 pay methods vs 4 enum (missing EWALLET, OTHER) | (a) expand `PaymentType` enum (+EWALLET,+OTHER) via migration · (b) map ewallet/other onto existing 4 (lossy) | **(a) expand enum** — small additive migration; faithful |
| **B** | Split/multi-payment vs single `paymentType` | (a) add `PaymentLine` model (orderId, method, amount) via migration · (b) JSON field on Order · (c) UI-only, persist dominant method | **(a) `PaymentLine` model** — faithful, feeds P5 by-payment-method Z-report |
| **C** | `orderNumber=ORD-Date.now()` vs `POS-YYYYMMDD-####` | (a) DB sequence/counter · (b) count-based per day · (c) keep cuid + format display | **(b) count-based** server-side (simple) — collision-safe enough for now; DB sequence is a later hardening |
| **D** | Server tax EXCLUSIVE vs client VAT-inclusive; amountPaid not validated | extend `POST /api/orders` to accept VAT-inclusive totals + paymentLines + validate `amountPaid≥total` (cash) | extend the route for Phase 3; **full Decimal recompute + idempotency stay production-readiness P2** (note, don't block) |
| **E** | `accountingDocNo` + real sync badge | defer to **Phase 6** (SyncJob); P3 receipt shows posNo + a "queued/pending" placeholder badge | **defer to P6** |

→ **Phase 3 needs a Prisma migration** (enum + PaymentLine; optionally `Order.paymentRef`) **and** `POST /api/orders` changes. DB is available (Docker verified in Phase 2 smoke), so migrations can run.

## 4. Function-by-function (28)

**Payment modal:** `action-open-payment` (open + prefill cash line=total) · `action-set-pay-method` (6 tiles cash/transfer/qr/card/ewallet/other) · `action-set-pay-amount` + `action-add-pay-line` + `action-remove-pay-line` (split; remove only if >1) · `state-pay-method-locked-line` (split targeting logic) · `action-cash-received` (quick-cash พอดี/฿100/฿500/฿1000) · `state-cash-change-display` (change when a cash line exists) · `action-pay-reference` · `state-payment-validation-error` (payError: split sum≠total, insufficient cash) · `action-confirm-payment` (**full-stack** → POST order) · `action-close-payment-modal` (X; payLines persist).

**Receipt:** `overlay-receipt` + `domain-receipt-80mm` + `display-receipt-line-detail` (80mm thermal, `@media print`) · `action-print-receipt` (`window.print()`) · `action-email-receipt` (toast share) · `display-faux-qr` + `domain-receipt-shortid` (QR → rcpt/{posNo.slice(-6)}) · `display-receipt-sync-badge` (pending/queued placeholder; real sync P6) · `action-new-sale` + `action-close-receipt-newsale-only` (receipt closes ONLY via new-sale) · `domain-separate-pos-acct-numbers` + `domain-posno-seq-formula` (posNo POS-YYYYMMDD-####; accountingDocNo P6).

**Hold/flow:** `action-hold-bill` + `state-cancel-vs-hold-difference` (hold vs cancel) · `flow-sell-to-receipt` (end-to-end).

## 5. Files likely to touch

- `src/app/(shell)/pos/page.tsx` — wire pay→modal→receipt; hold bill; remove the Phase-2 direct-checkout stub.
- `src/components/pos/` — new: `PaymentModal.tsx`, `ReceiptModal.tsx` (reuse `src/components/Modal.tsx` for backdrop/Escape/focus-trap).
- `src/lib/pricing.ts` — reuse; maybe add split-payment helpers (sum/remaining).
- `src/app/globals.css` — `@media print` 80mm receipt rules.
- **`prisma/schema.prisma`** — `PaymentType` +EWALLET/OTHER; new `PaymentLine` model; (optional `Order.paymentRef`). **+ migration.**
- **`src/app/api/orders/route.ts`** — accept paymentLines + VAT-inclusive totals + amountPaid validation + posNo sequence.
- `prisma/seed.ts` — optional (no change needed).

**Must NOT touch:** `(shell)/layout.tsx`, `NavRail`, `/login`, customer/tax (P6), sync (P6).

## 6. Risks

1. **Money correctness** — keep client satang math authoritative (`lib/pricing.ts`); server should store the client-sent inclusive totals or recompute in satang. Full Decimal end-to-end + **idempotency (double-submit)** + **atomic stock decrement** remain **production-readiness P2** — Phase 3 must not regress them and should leave clear TODOs.
2. **Migration** — additive (enum values + new table) is non-breaking; needs a running DB (`docker` ok). Use `prisma migrate dev` (tracked) per plan.
3. **80mm print** — cross-browser `@media print` + `@page size:80mm`; isolate `.print-receipt` so the rest of the app is hidden when printing.
4. **Split-payment validation** — sum of lines must equal total (satang-exact); cash line allows overpay→change, non-cash must be exact.
5. **Receipt dismissal** — Simple POS receipt closes ONLY via "new sale" (flow-forcing) — replicate exactly.
6. **Preserve P1/P2** — shell/rail/cart/totals untouched; pay button now opens the modal instead of direct POST.

## 7. UI-only vs full-stack — verdict

**Full-stack.** UI is the bulk (modal + receipt + hold), but `action-confirm-payment` requires: a **schema migration** (PaymentType enum + PaymentLine) and **`POST /api/orders` changes** (paymentLines, VAT-inclusive totals, amountPaid validation, posNo sequence). DB available → runnable.

## 8. Recommended execution order

1. Schema migration (PaymentType +EWALLET/OTHER, PaymentLine model) → `prisma migrate dev`.
2. `POST /api/orders` — accept paymentLines + inclusive totals + validate + posNo sequence (leave Decimal/idempotency TODOs).
3. `PaymentModal` (methods, split, cash/change, reference, validation) → wire `open-payment`/`confirm-payment`.
4. `ReceiptModal` (80mm, print, email, QR, sync-badge placeholder, new-sale) + `globals.css` print rules.
5. Hold bill + cancel-vs-hold.
6. type-check + build + pricing/split unit test + live smoke (pay → receipt → print preview) with DB.

## 9. Plan / timeline updates

- None structural. After EXECUTE: mark P3 ✅ done; note the schema additions (PaymentType +2, PaymentLine model) and that accountingDocNo/real-sync remain P6, Decimal/idempotency remain production-readiness.

## Readiness

**Phase 3 is ready for EXECUTE, but it is FULL-STACK** (schema migration + API + UI) — decisions A–E above (esp. enum expansion + PaymentLine model) need a go-ahead before implementation. DB is available for the migration + live smoke.

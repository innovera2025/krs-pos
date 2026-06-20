# POS Redesign — Phase 5 REPORT (Sales History + Shift Close/Z-report + refund/void/reprint)

- Date: 2026-06-20
- Plan: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (Phase 5, 23 functions)
- Research: `process/general-plans/reports/pos-redesign-phase-5_RESEARCH_20-06-26.md`
- Approved approach: **Full faithful (full-stack)**, **Decision A2 (add `shiftId` FK on Order)**
- Status: ✅ **type-check + build + 3rd tracked migration + live smoke (A2 checkout regression, refund/void domain rules, shift Z-report money, lifecycle, pages, P1–P4 regression) ALL verified**; 14-agent adversarial review → 9/9 confirmed findings fixed + re-smoked.
- Scope: Sales History + Shift Close. Customer picker / tax-invoice / real KRS sync = **Phase 6** (the ขอใบกำกับ button is an intentional disabled stub).

## What was built (23 Phase-5 functions)

**Schema (`prisma/schema.prisma`) + 3rd tracked migration `20260620134846_phase5_shift_sales_status`:**
- `enum ShiftStatus { OPEN CLOSED }`; `enum SyncStatus { PENDING DAILY SYNCED FAILED SKIPPED }`; **`VOIDED`** added to `OrderStatus` (void ≠ cancelled).
- New **`Shift`** model (`shiftNumber` unique, status, openedAt/closedAt, openingFloat, countedCash?, cashierId→User, branchId, orders Order[]).
- `Order` **(A2)**: `shiftId?` + `shift Shift?` relation (FK `ON DELETE SET NULL`); `syncStatus SyncStatus @default(PENDING)`; `accountingDocNo String?`; `taxRequested Boolean @default(false)`. `User.shifts Shift[]` back-relation. Migration is additive (defaulted columns + new model/enums) → non-breaking; verified on a fresh DB.

**API:**
- `GET /api/orders` — now includes `payments` + optional `?status=`/`?sync=` enum filters (unknown ignored), take 200.
- `POST /api/orders` **(A2, regression-sensitive)** — all P3 checkout behavior preserved (posNo, validation, `$transaction`, stock decrement, payment lines); the only addition is a null-safe lookup of the current OPEN shift to set `shiftId` (never blocks checkout when no shift is open).
- `PATCH /api/orders/[id]` (new) — `{action:"refund"|"void"}`; refund requires `COMPLETED`→`REFUNDED`; void requires `COMPLETED` **and** `syncStatus≠SYNCED` (`domain-synced-bills-locked`)→`VOIDED`+total/tax 0+`SKIPPED`. **No DELETE handler ever** (`domain-no-destructive-delete`). Typed `{error,code}`: NOT_FOUND 404, BAD_ACTION 400, INVALID_STATE 409, VOID_SYNCED_LOCKED 409.
- `GET /api/shift` — current shift + **Z-report** (grossSales/vatTotal/discounts COMPLETED-only; by-payment-method breakdown COMPLETED-only; refundsTotal; cashSales/cashRefunds; openingFloat; expectedCash). All money serialized as **String** (Decimal→String, integer-satang — no float drift). `POST /api/shift` — `{action:"open",openingFloat}` (409 SHIFT_ALREADY_OPEN) / `{action:"close",countedCash}` (409 NO_OPEN_SHIFT) → `{shift, dailySummaryNo:"DS-YYYYMMDD"}`.
- `src/lib/datetime.ts` — extracted shared Asia/Bangkok helpers (posNo behavior unchanged).

**UI (Taste-ported — no Taste mock existed for these screens):**
- `/sales` — search (posNo/customer), 6 filter chips (all/paid/refunded/voided/sync-failed/tax), Taste table (mono posNo · Bangkok time · customer·acctDoc · negative-aware amount · status + sync badges), **SaleDetailDrawer** (440px slideIn, backdrop/Esc/**Tab-trap**, keyboard-operable rows) with คืนเงิน/Void/พิมพ์(reprint)/ขอใบกำกับ(P6 stub); refund/void → toast + refetch + close; empty/loading/error states.
- `/shift` — dark forest KPI card, by-payment-method breakdown, 3 summary cards (refunds−/discounts−/VAT), cash-counting panel with integer-satang **variance** (green balanced / amber over / red short), close → DS success + **open-new-shift** affordance.
- `ReceiptModal` — payment-line fallback (`display-receipt-payment-fallback`) + shows real `accountingDocNo` on reprint.

**Seed (`prisma/seed.ts`):** 1 OPEN shift `SH-20260616-01` (float 2000) + 6 bills `POS-20260616-0036..0041` (paid/refunded/voided × sync states × doc numbers × methods), linked to the shift, each with a PaymentLine (positive tender) — idempotent upserts.

## Verification (orchestrator, independent)
- `npm run type-check` — **PASS** · `npm run build` — **PASS** (18 routes; `/sales` 6.81 kB, `/shift` 5.38 kB).
- **3rd migration** applied on a fresh ephemeral Postgres → ShiftStatus/SyncStatus enums, `VOIDED`, `Shift` table, Order fields present; seed → 6 orders/1 shift/6 orders-linked/6 payment lines.
- **Live smoke (all expected codes):**
  - **A2 checkout regression:** `POST /api/orders` → 201, posNo `POS-20260620-0001`, **linked to OPEN shift SH-20260616-01**, stock 21→20, payment line, validation (empty→400 NO_ITEMS) — P3 checkout intact.
  - **refund/void:** void COMPLETED/DAILY → VOIDED+total 0+SKIPPED · refund COMPLETED → REFUNDED · void SYNCED → **409 VOID_SYNCED_LOCKED** · refund REFUNDED / void VOIDED → 409 INVALID_STATE · bad action → 400 · unknown → 404 · **DELETE → 405** (no destructive delete).
  - **shift Z-report:** grossSales/VAT **exclude refunded+voided**; by-method **reconciles** (Σ byMethod == grossSales; byMethod CASH == cashSales) after fix; expectedCash = float+cashSales−cashRefunds; close → CLOSED+**DS-20260620**; open/close lifecycle (409 NO_OPEN_SHIFT / SHIFT_ALREADY_OPEN); counted-cash NaN → **400 BAD_COUNTED**.
  - **pages + regression:** `/sales` `/shift` render; `/pos` (VAT/ตะกร้า/ยอดสุทธิ) + `/products` + `/users` intact; all APIs 200; **0 server errors**.
- Ephemeral DB + smoke server torn down; `.env` untouched; `.next` cleaned.

## Adversarial review + fixes (14-agent workflow `w8jb39zxp`)
5 dimensions × adversarial verify → **9 raw, 9 confirmed (0 critical · 3 high · 4 medium · 2 low), 0 refuted.** All fixed + re-smoked:
- **HIGH (×3, same bug)** — Z-report by-payment-method `groupBy` lacked a status filter → summed refunded/voided PaymentLines into "Sales by payment method", contradicting grossSales/cashSales. **Fix:** `where: { order: { shiftId, status: COMPLETED } }` → byMethod now reconciles (Σ = grossSales, CASH = cashSales).
- **MEDIUM** — SaleDetailDrawer missing Tab focus-trap → added (mirrors Modal); sales rows mouse-only → `role=button`+`tabIndex`+Enter/Space; ReceiptModal hardcoded "รอออกเอกสาร" → reads `accountingDocNo` with fallback; `/shift` dead-ended after close → `loadShift()` refresh + open-new-shift affordance.
- **LOW** — counted-cash NaN silently became 0 → validate raw before round2 (→400 BAD_COUNTED); seed stored negative/zero PaymentLine amounts (contradicting runtime) → positive tender on PaymentLine, negative/zero kept only on `order.total`.

## Deviations / notes
- **A2** extends the P3 checkout POST (shift linking) — the only change is a null-safe `shift.findFirst` + `shiftId` in create; pricing/totals/stock/transaction untouched; re-verified by live checkout smoke.
- `bangkokDateParts()` extracted to `src/lib/datetime.ts` and shared — posNo behavior unchanged (verified: `POS-YYYYMMDD-####` still correct).
- by-method breakdown is COMPLETED-only "net sales by method"; refunds are tracked separately (refundsTotal + cashRefunds) for the cash-variance reconciliation.

## Production-readiness (deferred, not regressed)
Real auth/session + server-side RBAC on refund/void/shift · audit trail (who/when) + idempotency on refund/void · Decimal end-to-end checkout recompute · real KRS sync lifecycle + credit-note as accounting document + `accountingDocNo` issuance (Phase 6) · customer picker / tax-invoice request (Phase 6) · atomic stock reversal on refund. All TODO; none regressed.

## Next
- Mark Phase 5 ✅ done in plan/timeline (this report's commit).
- **Phase 6** (KRS Data Link sync/offline + Customer/member + tax invoice + Design Spec docs — 67 functions, the largest phase) is next — begin with its own RESEARCH on approval.

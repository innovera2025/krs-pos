# Financial/Inventory Correctness REPORT — Sub-phase A + B

- Date: 2026-06-21 · Research/spec: `financial-correctness_RESEARCH_21-06-26.md` · gap-audit root theme #2.
- Approved owner decisions: **scope A + B** (idempotency + orderNumber sequence deferred to Sub-phase C) · **discount = full server recompute** (client sends `discountType`+`discountValue`; server ignores all client money) · **stock restore = automatic on BOTH refund and void**.
- **Migration #6**: `20260621120000_phase_financial_correctness` (enum `ORDER_CREATED` + 7 CHECK constraints).
- Status: ✅ **type-check + build + Vitest 31/31 + Playwright e2e 14/14 + extensive live smoke + 4-dimension adversarial review (15 confirmed → 6 fixed, 9 deferred) + `pricing-tester` specialist (no correctness bugs) — all green.** Migration + fixed seed applied to the dev DB.

## What was built

### Sub-phase A — server-authoritative money + atomic stock (no migration)
- **`computeOrderTotals()`** (new, `src/lib/pricing.ts`) — server-callable, integer-satang. Inputs: DB product rows `{id, price}`, requested `{productId, quantity, lineDiscountSatang?}`, `{discountType, discountValue}`. Output: `subtotalSatang / billDiscountSatang / vatSatang / totalSatang` + per-line totals. Pure + unit-tested.
- **`POST /api/orders`** fully rewritten to be server-authoritative: recomputes ALL money from DB prices (ignores client subtotal/tax/discount/total/amountPaid/change); `amountPaid`/`change` server-computed from payment lines; payment-sum checked in satang; `amt <= 0` rejected; quantity INT4-capped; `isActive: true` product filter; **atomic conditional stock decrement** (`updateMany where stock >= qty`, assert `count === 1` → 409 `INSUFFICIENT_STOCK`); **SALE `StockMovement`** (negative qty) written inside the checkout transaction; P2002 orderNumber collision → clean 409 `ORDER_NUMBER_CONFLICT` (not a silent 500).
- **Refund/void stock restore** (`src/app/api/orders/[id]/route.ts`): ONE `$transaction` = conditional status transition (`updateMany where status=COMPLETED`, count===1 → closes the double-fire race) + per-item stock `increment` + `ADJUST StockMovement`, for BOTH refund and void. Existing guards (INVALID_STATE, VOID_SYNCED_LOCKED, admin-only, audit) preserved.
- **`serializeOrder()`** — explicit Decimal→2dp-string serializer (shared module `src/lib/orderSerialize.ts`), applied to every order response: GET, POST, and all PATCH sites.
- **`POST /api/products`** input validation (non-negative integer stock, non-negative price, try/catch on body).
- **`Product.price` type** `number` → `string` (wire format) in `src/types/index.ts`.
- **Client** (`(shell)/pos/page.tsx`) sends `discountType`/`discountValue` + per-line `lineDiscountSatang`; payment-sum gate tightened to exact satang equality (mirrors server).
- **Vitest** added (runner + `vitest.config.ts` + `"test"` script); `src/lib/pricing.test.ts` (31 tests incl. the largest-remainder allocation cases).

### Sub-phase B — DB safety net (migration #6)
- `AuditAction.ORDER_CREATED` + best-effort `logAudit` on checkout success (after commit).
- 7 CHECK constraints: `Product.stock>=0`, `Product.price>=0`, `Order.total>=0`, `OrderItem.quantity>0`, `OrderItem.unitPrice>=0`, `OrderItem.lineTotal>=0`, `PaymentLine.amount>=0`. (`StockMovement.qty` deliberately has NO check — SALE is negative.)

## Verification (orchestrator, independent — ephemeral Postgres + live server)
- Build + type-check + Vitest 31/31 + Playwright e2e 14/14 (the latter on freshly-seeded data).
- **Money recompute / anti-fraud:** underpay (client total=1 on a ฿250 cart) → `PAYMENT_MISMATCH` 422 (server recomputed 250, ignored client). `amt<=0` → `BAD_AMOUNT`.
- **Discounts:** per-line `lineDiscountSatang` (฿250−฿50 → "200.00") and bill `percent` 10% (฿130 → "117.00") produce correct satang totals; responses are 2dp strings.
- **Stock:** single oversell → 409 `INSUFFICIENT_STOCK` (stock unchanged); **concurrent double-buy of the last unit → final stock 0, never negative**; SALE ledger sum_qty negative.
- **Restore:** refund (+2) and void (+1) restore stock with `ADJUST` ledger rows; double-fire refund of a voided order → 409 `INVALID_STATE`.
- **Audit:** `ORDER_CREATED` rows written on checkout.
- **DB constraints:** direct UPDATE to negative stock / total / quantity / payment all rejected by the CHECK constraints.
- **The 6 review fixes (below) re-verified live:** refund/void PATCH now return 2dp strings; void of a SYNCED order → 409 `VOID_SYNCED_LOCKED`; 21 payment lines → 422 `TOO_MANY_PAYMENTS`; `discountValue:1.005` → 400 `BAD_DISCOUNT`.

## Adversarial review (4 dims × verify) + pricing-tester
- **`pricing-tester`:** no confirmed correctness bugs — verified discount allocation reconciles to the satang, inclusive VAT, single-transaction atomicity, duplicate-productId handling, multi-item restore, serialization.
- **Workflow review: 15 confirmed findings → 6 FIXED, 9 DEFERRED (documented).**

### Fixed (6)
1. **(MED) PATCH responses returned raw Prisma Decimals** (`"65"`/`"0"` not `"65.00"`/`"0.00"`) → Sales-History money rendering after refund/void. Fixed: shared `serializeOrder()` applied to all PATCH sites.
2. **(LOW, core math) Proportional bill-discount allocation** could break `Σ alloc === billDiscount` for N equal-net lines + small-satang discount → overstated `Order.tax` by 1–3 satang. Fixed with the **largest-remainder** method + regression/property tests.
3. **(MED) Void TOCTOU on syncStatus** — the in-transaction `updateMany` only re-checked `status`. Fixed: void's WHERE now also requires `syncStatus != SYNCED` (precise `VOID_SYNCED_LOCKED`).
4. **(LOW) Client payment gate** tolerated ±1 satang while the server is exact → confusing 422. Fixed: client now exact-match.
5. **(LOW) Payment-line caps** — no array/`reference` length bound (storage/DoS). Fixed: ≤20 lines (`TOO_MANY_PAYMENTS`), `reference` ≤100 chars.
6. **(LOW) `discountValue` sub-cent float** (`1.005` → 1-satang underdiscount). Fixed: reject >2-decimal `discountValue` (400 `BAD_DISCOUNT`).

### Deferred (9 — documented, not fixed this phase)
- **Sub-phase C (next):** no idempotency key + count-based orderNumber. `pricing-tester` quantified the remaining risk as **HIGH**: a double-submit whose two requests get *different* orderNumbers (the common case) creates a **genuine duplicate sale + double stock decrement** — the atomic decrement prevents oversell, not duplication. Collisions are caught as 409 `ORDER_NUMBER_CONFLICT` (no partial writes), but the real fix is `idempotencyKey @unique` + a DB/daily-counter orderNumber sequence.
- **(LOW) Customer PII over-exposure** — order responses include `customer: true` (phone/address) though consumers use only name/taxId; scope carefully (Thai tax invoices legally need the address). → security/PDPA pass.
- **(LOW) shift `findFirst` outside the checkout tx** (a just-closed shift can be linked) — narrow READ COMMITTED race.
- **(LOW) duplicate productId in one cart** is not merged (two lines / two SALE rows) — the UI never produces it; not a correctness bug.
- **(LOW) priceSatang×qty overflow** only at qty=INT4_MAX with price >฿41,943 — unreachable in practice.
- **(LOW) void header-field incoherence** — void zeroes total/tax but leaves subtotal/amountPaid (pre-existing; pre-void amount is in the AuditLog).

## Deviations / notes
- **Per-line discount extension:** the spec's `computeOrderTotals` contract listed only `{productId, quantity}` + bill discount, but per-line discount ("ส่วนลดรายการ") is a live feature from `Simple POS.dc.html`. Under the new server-authoritative payment-sum check it would have caused `PAYMENT_MISMATCH`, so `lineDiscountSatang` was threaded into the line contract (validated server-side, clamped to line gross) to preserve the function — a discount **input**, not a trusted amount. (CLAUDE.md: do not silently drop a Simple-POS function.)
- **Seed correction:** the demo refunded bill `POS-20260616-0038` stored a negative total (`−65`, a credit-note model) that the app's real refund handler never produces (refund keeps the positive total + status REFUNDED). Changed seed to `+65` to match the handler and `Order_total_nonneg_chk`. The dev DB was `migrate reset`-ed (it held seed-only data) → constraints + corrected seed applied; refunded demo bill is now +65.

## User action (host dev)
The dev DB (`krs-pos-db` on 127.0.0.1:5432) has been **reset + migrated + reseeded** with the new schema, constraints, and corrected seed. Just **restart `npm run dev`**. Checkout is now server-authoritative (client money values are ignored), stock can't go negative or oversell, refund/void restore stock, and every money response is a 2dp string.

## Remaining (next candidates)
- **Sub-phase C** — idempotency key + orderNumber DB sequence (HIGH: closes the duplicate-sale window). Needs 2 owner decisions (idempotency mechanism + orderNumber sequence) — both already scoped in the research.
- Then the deferred review items (Customer PII / PDPA, shift-tx race) and the rest of the gap-audit roadmap (Phase 1 Zod/error-handling/env; Phase 3 CI/observability/deploy; Phase 4 tax-invoice/backups/PDPA).

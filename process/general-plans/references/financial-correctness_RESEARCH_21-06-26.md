# Financial/Inventory Integrity — Research Report
## KRS POS · Phase: Financial/Inventory Correctness

**Date:** 2026-06-21  
**Scope:** Root theme #2 of `pos-security-gap-audit_20-06-26.md` — money representation, server-side recompute, stock integrity, idempotency, API serialization, test infrastructure  
**Method:** Direct source-file verification of all 5 investigator findings; contradictions resolved by re-reading code

---

## 1. What is Already Correct (do NOT re-implement)

| # | What | Evidence |
|---|------|----------|
| 1 | Auth gate — `requireUser()` on POST /api/orders; cashierId forced from session | `orders/route.ts:141-145` |
| 2 | items[].quantity validated as positive integer, `isFinite + isInteger + > 0` | `orders/route.ts:180-193` |
| 3 | Payment method validated against `VALID_METHODS` enum Set | `orders/route.ts:85-96` |
| 4 | Payment amount `< 0` rejected (`amt < 0` guard) | `orders/route.ts:213` |
| 5 | Server re-fetches product prices from DB for unitPrice/lineTotal — anti-tamper on per-line amounts | `orders/route.ts:317-334` |
| 6 | `cashierId` is NEVER trusted from client body; it comes from `session.user.id` | `orders/route.ts:145, 364` |
| 7 | Customer resolution + TAX_REQUIRES_TAX_CUSTOMER validated server-side | `orders/route.ts:285-311` |
| 8 | Payment sum === total cross-check (`Math.abs(paySum - totalBaht) > 0.01`) exists | `orders/route.ts:229-239` |
| 9 | Cash sufficiency check: `amountPaid + 0.01 < cashDue` guard exists | `orders/route.ts:251-256` |
| 10 | GRN (stock-movements) uses `prisma.$transaction` to atomically increment stock + create RECEIVE StockMovement | `stock-movements/route.ts:65-81` |
| 11 | GRN validates qty as positive integer with INT4 cap `2_147_483_647` | `stock-movements/route.ts:43` |
| 12 | Checkout wrapped in single `prisma.$transaction` — all-or-nothing | `orders/route.ts:350-395` |
| 13 | Refund/void INVALID_STATE 409 guard (checks `existing.status !== COMPLETED`) | `orders/[id]/route.ts:205-216` |
| 14 | Void SYNCED_LOCKED 409 guard (`syncStatus === SYNCED`) | `orders/[id]/route.ts:226-234` |
| 15 | Admin-only gate on refund/void via `isAdminRole()` | `orders/[id]/route.ts:94-102` |
| 16 | Append-only AuditLog for ORDER_REFUNDED and ORDER_VOIDED (best-effort, after commit) | `orders/[id]/route.ts:255-272` |
| 17 | Z-report uses `toSatang()` integer-satang aggregation and COMPLETED-only filter | `shift/route.ts:79-101` |
| 18 | Shift serialization explicitly calls `satangToString(toSatang(decimal))` | `shift/route.ts:65-70` |
| 19 | Client-side cart math is entirely integer-satang via `computeTotals()` | `pricing.ts:103-171` |
| 20 | VAT formula is correct inclusive extraction: `amount * 7 / 107` | `pricing.ts:24-25, 158` |
| 21 | Bill discount invariant `subtotal - billDiscount === total` enforced by construction | `pricing.ts:129-130` |
| 22 | `bahtToSatang()` handles both string and number input, guards NaN | `pricing.ts:78-85` |
| 23 | `round2()` guards non-finite input (`!Number.isFinite` → 0) | `orders/route.ts:99-102` |
| 24 | Sanitized 500 errors — never leak internals | `orders/route.ts:405-411` |
| 25 | TODO markers at `orders/route.ts:112-114, 137, 385` correctly name all known gaps | verified |

---

## 2. Confirmed Gaps — Per-Concern Table

### 2A. Money Representation & Server Recompute

| # | Severity | Title | Location | Verified? |
|---|----------|-------|----------|-----------|
| M1 | **CRITICAL** | Server trusts all 6 bill-level money values from client — no server recompute | `orders/route.ts:157-169, 356-362` | Yes — lines 356-362 store `round2(Number(subtotal/tax/discount/total/amountPaid/change))` directly from client body |
| M2 | **CRITICAL** | Payment sum check compares against client-sent `total`, not a server-computed value | `orders/route.ts:226, 232` | Yes — `totalBaht = round2(Number(total))` where `total` is from body:163 |
| M3 | **CRITICAL** | Discount from client has no sign or upper-bound server guard — `discount = subtotal` → zero-total order passes all checks | `orders/route.ts:162-163, 356-358` | Yes — no clamp or negativity check exists |
| M4 | **CRITICAL** | Zero-amount payment line accepted (`amt < 0` guard, but NOT `amt <= 0`) — combined with zero-total, enables fully fraudulent order | `orders/route.ts:213` | Confirmed — `amt < 0` check allows `amt === 0` |
| M5 | **HIGH** | `unitPrice = Number(product.price)` at server — Decimal→JS float, then `round2(float * qty)` float multiply | `orders/route.ts:327-328` | Yes |
| M6 | **HIGH** | `amountPaid` stored from client body, not recomputed from payment lines | `orders/route.ts:165, 361` | Yes |
| M7 | **HIGH** | `change` stored from client body, not server-computed as `max(amountPaid - total, 0)` | `orders/route.ts:166, 362` | Yes |
| M8 | **HIGH** | Payment line normalization uses float reduce (`normalizedPays.reduce(...)`) not satang integer addition | `orders/route.ts:229-231` | Yes |
| M9 | **HIGH** | Σ lineTotal never reconciled against stored Order.subtotal — header and line items can diverge silently | `orders/route.ts:322-362` | Yes — lineItems computed but sum never checked against body.subtotal |
| M10 | **MEDIUM** | `round2()` is float arithmetic (multiply → round → divide), not satang integer | `orders/route.ts:99-102` | Yes |
| M11 | **MEDIUM** | `taxRate` field mentioned in CLAUDE.md is a non-issue — no taxRate field exists in OrderRequestBody | `orders/route.ts:64-82` | Confirmed absent; the real issue is the `tax` amount |
| M12 | **MEDIUM** | No server-callable entry point in `src/lib/pricing.ts` — server recompute would need to duplicate or extend the existing module | `pricing.ts:1-197` | Confirmed — `pricing.ts` has no `'use client'` directive so it IS importable server-side, but lacks a function accepting Prisma Decimal product rows |

**CONTRADICTION RESOLVED — `taxRate`:** One investigator flagged CLAUDE.md mentioning `taxRate` as an untrusted value. Actual code review confirms there is no `taxRate` field in `OrderRequestBody` (`orders/route.ts:64-82`). The client sends the computed `tax` amount (a baht value), not a rate. The CLAUDE.md note is forward-looking prose. No `taxRate` gap exists in current code.

**CONTRADICTION RESOLVED — Prisma Decimal serialization:** Multiple investigators noted `NextResponse.json(order)` relies on Prisma Decimal's internal `toJSON()`. Verified: Prisma 5.x Decimal `toJSON()` returns `this.toString()`, so money fields arrive on the wire as numeric strings (e.g. `"301.33"`). The `OrderDTO` in `src/types/index.ts:126-133` types all money fields as `string | number`, which correctly acknowledges this ambiguity but does not enforce the string shape. This is a version-stability concern, not a current runtime bug — the shift route demonstrates the explicit-serialization pattern (`serializeShift()` at `shift/route.ts:48-71`) that is the preferred approach.

### 2B. Stock Integrity

| # | Severity | Title | Location | Verified? |
|---|----------|-------|----------|-----------|
| S1 | **CRITICAL** | Stock decrement is unconditional — no `WHERE stock >= qty` guard — stock can go negative | `orders/route.ts:387-391` | Yes — `tx.product.update({ data: { stock: { decrement: item.quantity } } })` with no `where` condition on stock |
| S2 | **CRITICAL** | READ COMMITTED isolation + no conditional decrement → oversell race (two concurrent checkouts of last unit both succeed) | `orders/route.ts:350` | Yes — `prisma.$transaction(fn)` with no `isolationLevel` arg; PostgreSQL defaults to READ COMMITTED |
| S3 | **HIGH** | No StockMovement SALE record created at checkout — stock ledger is incomplete (only RECEIVE is recorded) | `orders/route.ts:385-392` | Yes — only `product.update` decrement, no `stockMovement.create` with `SALE` type |
| S4 | **HIGH** | Refund and void do NOT restore stock | `orders/[id]/route.ts:219-247` | Confirmed — handler only calls `prisma.order.update` with status change; no stock increment or StockMovement record |
| S5 | **HIGH** | No DB CHECK constraint: `Product.stock >= 0` — DB is not a safety net | `prisma/migrations/20260620114227_init_with_payments/migration.sql:39` | Confirmed — all 5 migrations contain zero CHECK constraints on financial or inventory columns |
| S6 | **MEDIUM** | Checkout has no `isActive: true` filter on product fetch — deactivated products can be sold | `orders/route.ts:318-320` | Yes — `prisma.product.findMany({ where: { id: { in: productIds } } })` has no `isActive` filter |
| S7 | **MEDIUM** | item.quantity has no upper bound — `2_147_483_647` INT4 cap not checked (stock-movements route has it; checkout does not) | `orders/route.ts:182-193` | Confirmed — no upper-bound check in checkout route; `stock-movements/route.ts:43` correctly has the cap |
| S8 | **LOW** | `POST /api/products` accepts negative or fractional `stock` with no validation, no try/catch on `req.json()` | `products/route.ts:29-49` | Yes — `stock: stock ?? 0` with no integer/non-negative check |

**NOTE — Refund/void race window in PATCH:** The PATCH handler reads `existing` via `findUnique` then updates in a separate `prisma.order.update` (not a transaction). Two concurrent PATCH requests for the same order could both pass the `status !== COMPLETED` check and both commit. The current code has no `$transaction` wrapping the status-check + update pair (`orders/[id]/route.ts:191-247`). However, the second double-fire PATCH will fail gracefully at the application level because after the first update sets status to REFUNDED/VOIDED, the second `findUnique` would re-read the new status — but only if the first transaction has committed before the second `findUnique`. Under concurrent requests this window is real.

### 2C. Idempotency & orderNumber

| # | Severity | Title | Location | Verified? |
|---|----------|-------|----------|-----------|
| I1 | **CRITICAL** | No idempotency key on POST /api/orders — double-click / network retry creates duplicate order + double stock decrement | `orders/route.ts:140` (TODO at 137) | Confirmed — no `X-Idempotency-Key` or `billId` field anywhere |
| I2 | **CRITICAL** | `nextPosNo` uses count-based sequence under READ COMMITTED — concurrent checkouts produce duplicate orderNumber → P2002 → silent 500 INTERNAL | `orders/route.ts:116-127` | Yes — `tx.order.count(...)` inside READ COMMITTED transaction; no DB sequence, no advisory lock |
| I3 | **HIGH** | P2002 (unique constraint on `orderNumber`) not caught explicitly — falls through to generic 500 | `orders/route.ts:398-411` | Confirmed — catch block only handles `ProductNotFoundError` |
| I4 | **MEDIUM** | PATCH refund/void double-fire — status check + update not in a single transaction with row lock | `orders/[id]/route.ts:191-247` (comment at 23-24) | Yes — `findUnique` and `order.update` are separate Prisma calls |
| I5 | **MEDIUM** | `nextPosNo` counts ALL orders including VOIDED/REFUNDED — domain policy on whether gaps are acceptable is undocumented | `orders/route.ts:122-124` | Yes — no status filter in count |

### 2D. API Type Contract & Serialization

| # | Severity | Title | Location | Verified? |
|---|----------|-------|----------|-----------|
| T1 | **HIGH** | `Product.price` typed as `number` in TypeScript but wire format from Prisma JSON is a Decimal string (e.g. `"59.00"`) | `src/types/index.ts:5` | Yes — `price: number` at line 5; runtime receives string; `bahtToSatang` handles both accidentally |
| T2 | **HIGH** | `NextResponse.json(order)` at POST /api/orders and GET /api/orders returns raw Prisma result with Decimal fields — no explicit `.toString()` unlike the shift route | `orders/route.ts:53, 397` | Yes — no `serializeOrder()` function exists; contrast with `serializeShift()` at `shift/route.ts:48-71` |
| T3 | **MEDIUM** | `OrderDTO` types all money fields as `string | number` — ambiguous, not enforced | `src/types/index.ts:126-133` | Yes — `subtotal: string | number` etc. |

### 2E. Test Infrastructure

| # | Severity | Title | Location | Verified? |
|---|----------|-------|----------|-----------|
| V1 | **HIGH** | Vitest not installed — no unit test runner; `package.json` devDependencies contains only `@playwright/test` | `package.json` | Yes — Vitest absent; Playwright present |
| V2 | **HIGH** | `src/lib/pricing.ts` has zero tests — the single pure module with complex proportional-discount rounding logic is untested | `pricing.ts:103-171` | Yes |
| V3 | **MEDIUM** | `tests/e2e/checkout.spec.ts` covers only happy path — no double-submit, concurrent checkout, or stock-exhaustion scenarios | `tests/e2e/checkout.spec.ts` | Confirmed — single test, no concurrency cases |
| V4 | **LOW** | No audit coverage for `POST /api/orders` success — ORDER_CREATED not in AuditAction enum | `schema.prisma:139-153`; `orders/route.ts:397` | Yes — no `logAudit` call in POST success path |

---

## 3. Blast-Radius Classification

```
Sub-phase A — Pure TypeScript (no DB migration)
  Files: orders/route.ts · orders/[id]/route.ts · products/route.ts · pricing.ts · src/lib/checkout.ts (new) · types/index.ts · package.json
  Risk: zero schema change; fully reversible

Sub-phase B — DB migration only
  Files: prisma/schema.prisma · prisma/migrations/ (new migration file)
  Contents: CHECK constraints (stock >= 0, price >= 0, total >= 0, PaymentLine.amount >= 0, OrderItem.quantity > 0) + ORDER_CREATED AuditAction enum value + optional idempotencyKey field on Order
  Risk: ALTER TABLE; verify seed data has no negative stock before applying
```

---

## 4. Dependency Order Within Sub-phases

### Sub-phase A (recommended first, no migration)

1. **Install Vitest** (`package.json` devDependency) — unblocks all unit testing  
2. **Write `src/lib/pricing.ts` unit tests** — pin the existing correct behavior before touching it  
3. **Add `computeOrderTotals()` to `src/lib/pricing.ts`** — server-callable function accepting `{price: Decimal, id}[]` + `{productId, quantity}[]` + `BillDiscount`, returning satang integers (subtotalSatang, billDiscountSatang, totalSatang, vatSatang, lines with productId + priceSatang + lineTotalSatang). This function is importable by both server and client.  
4. **Refactor `POST /api/orders`**:  
   a. Call `computeOrderTotals()` after product fetch (line 317) — store server-computed values instead of client body values  
   b. Add `amt <= 0` guard on payment lines  
   c. Add item.quantity upper-bound check (`> 2_147_483_647`)  
   d. Add `isActive: true` to product `findMany`  
   e. Convert payment sum check to satang integers  
   f. Replace unconditional stock decrement with `updateMany({ where: { id, stock: { gte: qty } } })` + `count === 1` assert  
   g. Add `StockMovement.create` (type SALE) inside the transaction  
   h. Server-compute `amountPaid` and `change` from payment lines  
5. **Add stock restoration to refund/void PATCH** — wrap status-check + update in a `$transaction` with `product.update({ stock: { increment: qty } })` per item + `StockMovement.create` (type ADJUST)  
6. **Wrap PATCH status-check + update in transaction** (`updateMany` with conditional `where { status: COMPLETED }`)  
7. **Add `isActive` guard to products/route.ts POST** — `stock` must be non-negative integer  
8. **Add explicit `serializeOrder()` to orders route** — mirrors `serializeShift()` in shift/route.ts  
9. **Fix `Product.price` type in `types/index.ts`** — change `number` to `string`  
10. **Unit test `computeOrderTotals()`** and the new checkout service functions  

### Sub-phase B (migration, after A commits and passes typecheck+build)

1. Add `AuditAction.ORDER_CREATED` to schema enum + `logAudit` call in POST success path  
2. Add DB CHECK constraints (new migration):  
   - `Product.stock >= 0`  
   - `Product.price >= 0`  
   - `Order.total >= 0`  
   - `PaymentLine.amount >= 0`  
   - `OrderItem.quantity > 0`  
   - `OrderItem.unitPrice >= 0`  
   - `OrderItem.lineTotal >= 0`  
3. Optionally: `idempotencyKey String? @unique` on Order model (if owner chooses DB-table idempotency)  
4. Verify: `prisma migrate deploy` on ephemeral Postgres + typecheck + build  

### Idempotency + orderNumber sequence (Sub-phase C — separate decision)

These two gaps require owner decisions (see Section 5) before implementation can be planned. They are scoped as a follow-on sub-phase because they both require schema changes AND architectural choices that go beyond the pure-correctness fixes of A and B.

---

## 5. Unresolved / Out-of-Scope

- `taxRate` in CLAUDE.md — not a current code gap; field does not exist in `OrderRequestBody`
- Historical DB rows where subtotal/tax/discount/total were client-sent — cannot be retroactively corrected; schema needs no migration to fix
- Z-report vatTotal accuracy after the fix — once `tax` is server-computed from the satang formula, `toSatang(o.tax)` in `shift/route.ts:94` will sum the correct values; no shift-route changes needed
- Whether the Playwright e2e tests pass currently — they are authored but the runner depends on a live seeded server; this research did not execute them

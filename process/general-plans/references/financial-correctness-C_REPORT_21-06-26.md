# Financial/Inventory Correctness REPORT — Sub-phase C (idempotency + orderNumber sequence)

- Date: 2026-06-21 · follows Sub-phase A+B (`financial-correctness_REPORT_21-06-26.md`). Closes the last checkout-integrity gap that A+B's review + `pricing-tester` had quantified as **HIGH**: duplicate-sale on double-submit, and orderNumber collisions under concurrency.
- Approved owner decisions: **idempotency = `Order.idempotencyKey String? @unique`** (client UUID per attempt); **orderNumber = `DailyOrderCounter` table** (atomic per-Bangkok-day counter).
- **Migration #7**: `20260621130000_phase_idempotency_ordernumber` (add nullable `Order.idempotencyKey` + unique index; new `DailyOrderCounter{day @id, seq}`).
- Status: ✅ **type-check + build + Vitest 42/42 + e2e 14/14 + live smoke + 3-dim adversarial review (8 confirmed → 4 fixed, 2 deferred, 2 = positive confirmations) + `pricing-tester` (no issues)** — all green. Migration applied to the dev DB (additive, non-destructive).

## What was built
- **Idempotent checkout.** `POST /api/orders` accepts `idempotencyKey` (validated ≤64 chars → 400 `BAD_IDEMPOTENCY_KEY`; absent = back-compat). **Replay pre-check:** `findUnique` by key → if found, return `serializeOrder(existing)` with **200** *before* any recompute/stock/audit work — a replay never decrements stock or writes a second `ORDER_CREATED`. **Concurrent same-key** loser is caught by the `@unique` index (P2002) → its transaction rolls back → the catch re-reads the winner by key → 200 replay. No interleaving yields two orders or two decrements for one key.
- **Collision-safe orderNumber.** Replaced the count-based `nextPosNo` with `DailyOrderCounter`, bumped atomically *inside the checkout transaction* via a single race-free statement, deriving the day from the **Postgres transaction clock** (constant within a tx) so the `POS-YYYYMMDD-####` prefix, the counter key, and `Order.createdAt` all agree:
  ```sql
  INSERT INTO "DailyOrderCounter" ("day","seq")
  VALUES (to_char((now() AT TIME ZONE 'Asia/Bangkok'),'YYYYMMDD'), 1)
  ON CONFLICT ("day") DO UPDATE SET "seq" = "DailyOrderCounter"."seq" + 1
  RETURNING "day","seq"
  ```
  A rollback (e.g. `INSUFFICIENT_STOCK` after the bump) rolls back the seq too — gapless and collision-free under concurrency.
- **Client** (`(shell)/pos/page.tsx`): mints a `crypto.randomUUID()` key per checkout attempt, reuses it across retries, and clears it in `clearBill()` (success/cancel/hold) so each new sale gets a fresh key; a 200 replay is treated as success exactly like 201.
- **Pure helpers** `bangkokDayStamp` + `formatOrderNumber` (`src/lib/datetime.ts`) + 11 Vitest tests (day-boundary at Bangkok 00:00/23:59, zero-padding, >9999).

## Verification (orchestrator, independent — ephemeral Postgres + live server)
- Build + type-check + Vitest 42/42 + e2e 14/14.
- **Idempotent replay:** same key twice → 201 then **200**, ONE order, stock decremented **once**.
- **Concurrent SAME key** (2 parallel) → exactly 1 order, one 201 + one 200, stock once.
- **Concurrent DISTINCT keys** → 2 orders, **distinct sequential** `POS-20260621-####`, no 409 / no P2002.
- **DB-clock day (post-fix):** orderNumber day prefix == `createdAt` Bangkok day (`match=true`).
- `>64`-char key → 400 `BAD_IDEMPOTENCY_KEY`. Counter state increments correctly.

## Adversarial review (3 dims × verify) + pricing-tester
- **`pricing-tester`: no confirmed issues** — duplicate-sale prevention airtight (replay pre-check + unique-index P2002 fallback), counter atomic + gapless on rollback, A+B money/stock intact on the create path.
- **Review: 8 confirmed → 4 FIXED, 2 DEFERRED, 2 were positive confirmations.**

### Fixed (4)
1. **(MED) P2002 replay fell through to 409 when `err.meta.target` is undefined.** `p2002Mentions` returned false on an undefined target (possible under engine/connector failures), so a same-key loser got `409 ORDER_NUMBER_CONFLICT` instead of a 200 replay. Fixed: attempt the winner-read whenever the conflict isn't *clearly* an orderNumber collision (undefined/ambiguous target → try the key read; 200 if the winner row exists).
2. **(LOW) orderNumber day vs `createdAt` skew.** The day was derived from a JS `now` captured before the tx; a sale within ~50 ms of Bangkok midnight could disagree with the Postgres `createdAt`. Fixed: derive the day from the Postgres transaction clock inside the upsert (single source of truth).
3. **(LOW) defensive seq guard** didn't reject `seq === 0` (`POS-…-0000`). Fixed: reject `seq < 1`.
4. **(LOW) dead client vars** (`amountPaidSatang`/`changeSatang`/`nonCashSatang`) computed but unused since A+B made the server authoritative. Removed.

### Deferred (2 — documented)
- **(LOW) Replay ignores body mismatch:** reusing a key with a *different* cart returns the first order's data (Stripe-style key-only replay), not a 409. The current POS client makes this unreachable (clearBill discipline) and there is no public API; if the order API is ever exposed externally, add a request-body hash to the key check and 409 on mismatch.
- **(LOW) Audit can't distinguish a replay from a single submission** (one `ORDER_CREATED` per order — correct). An explicit replay-observed signal would be observability-only noise; skipped.

## Deviation
- During FIX 2, the now-dead JS `const now` and the unused `bangkokDayStamp` import were removed from `orders/route.ts` (the helper stays in `datetime.ts`, still used for `formatOrderNumber` + tested). In-scope cleanup, no behavior change.

## User action (host dev)
Migration #7 has been applied to the dev DB (`krs-pos-db`, additive — no reset, existing data preserved). Just **restart `npm run dev`**. Checkout is now idempotent (double-click / retry returns the same bill, never a duplicate sale) and orderNumbers are collision-free under concurrent terminals.

## Phase status
**Financial/Inventory correctness (Sub-phase A + B + C) is COMPLETE.** Gap-audit root theme #2 is closed: server-authoritative satang money, atomic non-negative stock, refund/void restore, idempotency, collision-free orderNumber, DB CHECK constraints, audit, and a Vitest harness. Remaining gap-audit roadmap: Phase 1 (Zod/error-handling/env), Phase 3 (CI/observability/deploy), Phase 4 (tax-invoice/backups/PDPA), plus the deferred review items (Customer PII/PDPA scoping, shift-tx race).

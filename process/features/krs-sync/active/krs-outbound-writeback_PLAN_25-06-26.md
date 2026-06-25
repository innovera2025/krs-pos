# KRS Phase 2 — Outbound Write-Back (POS → KRS Cash Sale)

- **Feature:** krs-sync
- **Phase:** P2 of the krs-sync phase program
- **Date:** 2026-06-25
- **Complexity:** COMPLEX
- **Plan type:** Phase execution plan (child of `krs-sync-program_PLAN_22-06-26.md`)
- **Status:** AWAITING EXECUTE PREREQUISITES (see §10)
- **Umbrella plan:** `process/features/krs-sync/active/krs-sync-program_PLAN_22-06-26.md`
- **P0 spec:** `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md`
- **Field analysis:** `process/features/krs-sync/references/krs-writeback-field-analysis_24-06-26.md`
- **Round-2 spec request:** `process/features/krs-sync/references/krs-writeback-spec-request-round2_24-06-26.md`
- **Reports:** `process/features/krs-sync/reports/`

---

## 0. Summary and Build Order

This plan implements the real POS-to-KRS cash-sale write-back. One confirmed POS checkout
produces five INSERT statements inside one KRS `mssql` transaction (RunningNumber →
SalesInvoiceHdr → SalesInvoiceDtl × N items → InventoryFlowHdr → InventoryFlowDtl × N
items) PLUS three `TheJournal` rows (DR cash / CR revenue / CR output-VAT). Account codes are
resolved at write-time from `AccountHead`. This data is what `sp_Onhand` reads; it also closes
the inbound-sync loop.

**Recommended build order (two-track):**

```
Track A — POS-side infrastructure (no KRS constants needed; buildable NOW):
  Step 1–2:   SyncJob schema extension + migration
  Step 3–4:   Outbox enqueue helper + checkout integration
  Step 5–6:   Dispatcher trigger endpoint + sidecar config
  Step 7:     Dispatcher core (claim/retry/backoff/lock/stale-reclaim)
  Step 8:     Feature-flag + sandbox connection separation
  Step 9:     Refund/void STOCK_REVERSAL SyncJob hook (stub or full)

Track B — KRS write module (blocked on prerequisites — see §10):
  Step 10:    CONFIG block + connection wrapper (sandbox ONLY)
  Step 11:    RunningNumber atomic claim
  Step 12:    SalesInvoiceHdr / SalesInvoiceDtl inserts
  Step 13:    InventoryFlowHdr / InventoryFlowDtl inserts
  Step 14:    TheJournal 3-row insert (AccountHead resolution)
  Step 15:    Idempotency guard (pre-check + SalesInvoiceHdr.Remarks anchor)
  Step 16:    Full KRS write orchestrator function

Verification:
  Step 17:    pricing-tester run (after any checkout-route touch)
  Step 18:    type-check + build
  Step 19:    Sandbox dry-run + sp_Onhand reconcile
  Step 20:    Concurrent dispatch test (double-claim proof)
```

Track A can be built, committed, and deployed independently. Track B requires the prerequisites
in §10. The two tracks converge at Step 17 verification.

---

## 1. Goals

1. On every confirmed CASH sale, create one `SyncJob` outbox row INSIDE the checkout
   Postgres `$transaction` — atomically and fail-open (checkout never blocked).
2. A dispatcher claims pending jobs with an atomic compare-and-swap, executes the KRS write,
   marks `SYNCED` or retries with exponential backoff up to `maxAttempts = 5`.
3. The KRS write opens ONE `mssql` transaction and performs the 5 inserts + 3 journal rows,
   all parameterized (`?` placeholders), anchored to `Order.orderNumber` for idempotency.
4. The feature is off by default (`KRS_OUTBOUND_ENABLED=false`); the KRS write target is a
   SEPARATE sandbox connection, never the inbound prod connection.
5. `InventoryFlowDtl` is written with `Approved=1, IsClosed=0, InOut=-1` so `sp_Onhand`
   counts the stock deduction immediately.

---

## 2. Scope

### In Scope

- `SyncJob` schema extension (additive migration `sync_job_outbox`)
- Outbox enqueue inside `src/app/api/orders/route.ts` checkout `$transaction` (minimal touch —
  one `tx.syncJob.create` call in the success path; all existing money/stock logic UNTOUCHED)
- Dispatcher: `POST /api/krs/dispatch` (bearer-secret, admin-only) + dispatcher logic module
  `src/lib/krs/dispatcher.ts`
- KRS write module: `src/lib/krs/writeback.ts` (5 inserts + 3 journal rows, all parameterized)
- CONFIG block in `src/lib/krs/writebackConfig.ts` (all vendor constants in one place)
- Sandbox-only connection wrapper (`src/lib/krs/sandboxClient.ts`)
- Feature flag `KRS_OUTBOUND_ENABLED` in `.env` + `src/lib/env.ts`
- Docker sidecar config extension (`docker-compose.yml`) for dispatch trigger
- Refund/void stock-reversal SyncJob hook (see §8 — initially a TODO stub if owner decides
  KRS self-reverses; full if owner confirms POS sends the compensating row)
- Verification: `pricing-tester`, `npm run type-check`, `npm run build`, sandbox dry-run,
  sp_Onhand reconcile

### Out of Scope (deferred to P3/P4 or separate work)

- Inbound pull changes (P3)
- GRN/stock-receive outbound (P3 extension)
- Tax invoice KRS document (separate outbound type, P3)
- NavRail badge driven by real FAILED rows (P4)
- Full `/data` sync-jobs UI replacement of the simulated actions (P4)
- Payment method other than CASH — write-back is for cash sales only in P2; card/QR/transfer
  sales still write a SyncJob but the dispatcher skips non-cash if the vendor confirms
  separate handling (owner to confirm at §10)

---

## 3. Architecture

### 3.1 Data Flow

```
POS Checkout (POST /api/orders)
  │
  ├─ Postgres $transaction (ALL OF THE FOLLOWING ARE ONE ATOMIC COMMIT):
  │   ├─ Order.create
  │   ├─ OrderItem.create × N
  │   ├─ PaymentLine.create × N
  │   ├─ Product.updateMany (atomic stock decrement)
  │   ├─ StockMovement.create × N
  │   └─ SyncJob.create  ← NEW (idempotencyKey="<orderNumber>_SALE", payload=JSON snapshot)
  │
  └─ After commit (best-effort, unchanged):
      ├─ logAudit(ORDER_CREATED)
      └─ [KRS_OUTBOUND_ENABLED=false] — no network call here; dispatcher owns it

Docker sidecar (krs-dispatch-cron) hits:
  POST /api/krs/dispatch  (Authorization: Bearer KRS_DISPATCH_SECRET)
  │
  └─ dispatcher.ts:
      ├─ ATOMIC CLAIM: UPDATE SyncJob SET lockedAt=now(),status='RETRYING'
      │   WHERE status='PENDING' AND (lockedAt IS NULL OR lockedAt < now()-10min)
      │   AND (nextAttemptAt IS NULL OR nextAttemptAt<=now())
      │   ORDER BY createdAt LIMIT 10 RETURNING id
      │
      └─ For each claimed id:
          ├─ Dedup check: SYNCED row with same idempotencyKey? → mark SKIPPED
          ├─ [KRS_OUTBOUND_ENABLED=false] → skip, keep PENDING (or mark SKIPPED)
          ├─ Open sandbox mssql transaction
          │   ├─ RunningNumber atomic claim (serializable tx)
          │   ├─ INSERT SalesInvoiceHdr
          │   ├─ INSERT SalesInvoiceDtl × N (per OrderItem)
          │   ├─ INSERT InventoryFlowHdr
          │   ├─ INSERT InventoryFlowDtl × N (Approved=1, IsClosed=0, InOut=-1)
          │   ├─ SELECT AccountHead per group × 3 → INSERT TheJournal × 3
          │   └─ COMMIT
          ├─ SUCCESS → SyncJob: status=SYNCED, lockedAt=null, response=TransactionNo
          └─ FAILURE → SyncJob: attempts++, lastError=msg, nextAttemptAt=backoff,
                       status=PENDING(retry eligible) or FAILED(maxAttempts reached),
                       lockedAt=null
```

### 3.2 Cross-Engine Invariants (non-negotiable)

- The `mssql` write is NEVER called inside or during a Prisma `$transaction`.
- The `prisma` singleton is NEVER imported inside `writeback.ts` or `sandboxClient.ts`.
- Error from the `mssql` write NEVER propagates to the checkout response.
- Two concurrent dispatcher claims against the same SyncJob: the second UPDATE returns 0 rows
  and the worker aborts that job silently (the atomic claim is the only gate).

---

## 4. Touchpoints (Every File and Why)

| File | Action | Why |
|------|--------|-----|
| `prisma/schema.prisma` | ADD 6 fields to `SyncJob` model | Outbox extension: `payload Json?`, `idempotencyKey String? @unique`, `attempts Int @default(0)`, `lastError String?`, `nextAttemptAt DateTime?`, `lockedAt DateTime?` |
| `prisma/migrations/*/migration.sql` | NEW migration `sync_job_outbox` | Applies the additive schema changes; all fields nullable or defaulted — no seed data breaks |
| `src/app/api/orders/route.ts` | ADD `tx.syncJob.create(...)` inside the `$transaction` block | Atomic outbox enqueue; the ONLY change to this file — all money/stock logic is untouched |
| `src/lib/krs/writebackConfig.ts` | CREATE | Single CONFIG block: all vendor constants (InvoiceType, SaleType, ItemType, DocuType, SourceType-Dtl, ReasonIndex/Name, inventory TransactionType, CompanyCode, Warehouse, journal constants). All TBD values are explicit `TODO_FROM_VENDOR` placeholders — NEVER guessed |
| `src/lib/krs/sandboxClient.ts` | CREATE | Opens an mssql `ConnectionPool` from SANDBOX env vars (`KRS_SANDBOX_HOST`, etc.), completely separate from the production `buildConnectionConfig()` path in `client.ts`. Pool is opened per-dispatch and always closed in `finally`. |
| `src/lib/krs/writeback.ts` | CREATE | The KRS write orchestrator: accepts a `SalePayload` (snapshot from `SyncJob.payload`), opens ONE mssql transaction on the sandbox pool, executes RunningNumber claim + 5 inserts + 3 journal rows, all parameterized. Returns `{ transactionNo: string }` on success or throws. |
| `src/lib/krs/dispatcher.ts` | CREATE | Dispatcher logic: atomic claim, dedup check, calls `writeback.ts`, handles retry/backoff/FAILED terminal. Exported `runDispatch(): Promise<DispatchResult>`. |
| `src/app/api/krs/dispatch/route.ts` | CREATE | `POST /api/krs/dispatch` — bearer-secret auth (mirrors the existing `/api/krs/auto-sync` pattern), calls `runDispatch()`, returns `{ claimed, synced, failed, skipped }`. Admin-only fallback: also accept `requireAdmin` session for manual drain from the UI. |
| `src/lib/env.ts` | MODIFY (additive) | Add `KRS_OUTBOUND_ENABLED` (default `"false"`), `KRS_DISPATCH_SECRET`, and the sandbox connection env vars (`KRS_SANDBOX_HOST`, `KRS_SANDBOX_PORT`, `KRS_SANDBOX_DB`, `KRS_SANDBOX_USER`, `KRS_SANDBOX_PASS`, `KRS_SANDBOX_SSL`, `KRS_SANDBOX_TRUST_CERT`). All optional at boot — feature is OFF by default. |
| `.env.example` | MODIFY | Document the new env var names + generation hints. No real values. |
| `docker-compose.yml` | MODIFY | Add `krs-dispatch-cron` sidecar service (mirrors `krs-cron`): runs `curl -X POST http://pos:3000/api/krs/dispatch -H "Authorization: Bearer $$KRS_DISPATCH_SECRET"` on a configurable interval (initially every 30s). |
| `src/lib/krs/index.ts` | MODIFY | Export `runDispatch` from `dispatcher.ts` + `writeKrsSale` from `writeback.ts` (for test harness use) |
| `src/app/api/orders/[id]/route.ts` | REVIEW + POSSIBLE ADD | Refund/void path — assess if/where a `STOCK_REVERSAL` SyncJob is created (see §8). If deferred, add a code comment and a TODO; no code change unless §10 owner decision is confirmed. |
| `src/lib/schemas/syncJob.ts` (or `_shared.ts`) | REVIEW | Ensure existing Zod schemas for SyncJob API don't need updating for the new fields (all fields are nullable/optional — no breaking change to API body shape) |
| `process/context/all-context.md` | UPDATE AFTER EXECUTE | Update "KRS outbound … remains deferred" note once P2 ships |

---

## 5. Public Contracts

### 5.1 `POST /api/krs/dispatch`

**Auth:** `Authorization: Bearer <KRS_DISPATCH_SECRET>` (primary, mirrors auto-sync). Also
accepts `requireAdmin` session (manual drain from UI). Both must be present — no unauthenticated
dispatch.

**Request body:** none (the dispatcher claims pending jobs itself).

**Response 200:**
```json
{ "claimed": 3, "synced": 2, "failed": 0, "skipped": 1 }
```

**Response 503:** KRS outbound disabled (`KRS_OUTBOUND_ENABLED !== "true"`):
```json
{ "error": "KRS outbound disabled", "code": "OUTBOUND_DISABLED" }
```

**Response 401/403:** auth failed.

**Response 500:** internal error (sanitized; never raw driver error).

### 5.2 `SyncJob` outbox enqueue shape (inside checkout `$transaction`)

```typescript
await tx.syncJob.create({
  data: {
    type: SyncJobType.SALE,
    direction: SyncDirection.INSERT,
    ref: orderNumber,                              // e.g. "POS-20260625-0012"
    amount: totalDecimal,                          // Order.total (Decimal — no float round-trip)
    status: SyncJobStatus.PENDING,
    provider: "KRS",
    idempotencyKey: `${orderNumber}_SALE`,         // non-null invariant (P0 spec §8.1)
    payload: orderSnapshot,                        // JSON snapshot; see §5.3
    attempts: 0,
    branchId: order.branchId ?? "BR-01",
  },
});
```

**Non-null idempotencyKey invariant** (P0 spec §8.1): the enqueue MUST assert
`idempotencyKey !== null` before calling `tx.syncJob.create`. A null key provides zero
dedup protection. Throw inside the `$transaction` if the key is null/empty — this rolls back
the whole checkout, which is the correct behavior (an order with no traceable sync row is worse
than a failed checkout that the cashier retries).

### 5.3 `SalePayload` (stored in `SyncJob.payload`)

The snapshot captures ALL POS data needed for the KRS write at dispatch time. The dispatcher
reads ONLY the snapshot — it never re-queries the POS DB at dispatch time (avoids a stale-read
if the order or product is updated between checkout and dispatch).

```typescript
type SalePayload = {
  orderNumber: string;          // e.g. "POS-20260625-0012"
  createdAt: string;            // ISO-8601, Asia/Bangkok  → VoucherDate / InOutDate
  total: string;                // Decimal string (no float) → SalesInvoiceHdr.TotalAmount
  subtotal: string;             // Decimal string           → SubTotalAmnt / TheJournal revenue
  tax: string;                  // Decimal string           → VATAmount / TheJournal VAT
  discount: string;             // Decimal string           → DiscountAmount
  amountPaid: string;           // Decimal string           → CashValue
  cashierId: string;            // User.id (SalePerson)
  cashierName: string;          // User.name (SaleName / EntryBy)
  customerId: string | null;    // Customer.id or null
  customerCode: string | null;  // Customer.taxId or "CASH" walk-in constant
  customerName: string | null;  // Customer.name or Thai walk-in label
  customerAddress: string | null;
  branchCode: string;           // ShopSettings.sellerBranchCode (SellerConfig.branchCode)
  branchName: string;           // ShopSettings.sellerBranchLabel (SellerConfig.branchLabel)
  items: Array<{
    itemCode: string;           // Product.sku
    description: string;        // Product.name
    quantity: number;           // OrderItem.quantity (integer)
    unitPrice: string;          // Decimal string — OrderItem.unitPrice
    lineTotal: string;          // Decimal string — OrderItem.lineTotal
    lineDiscount: string;       // Decimal string — per-line discount (may be "0.00")
    // mainUnits: resolved at write-time from KRS InventoryItem (see §10 prerequisite 7)
  }>;
};
```

**Money discipline:** every money field in `SalePayload` is a **Decimal string** (e.g.
`"1234.50"`). The dispatcher passes them to mssql as string parameters bound as `DECIMAL(10,2)`.
No `Number()` round-trips anywhere in the money path.

### 5.4 KRS write atomicity contract

The KRS write module (`writeback.ts`) opens ONE `mssql` transaction (BEGIN TRANSACTION /
COMMIT). All inserts — RunningNumber update, SalesInvoiceHdr, SalesInvoiceDtl × N,
InventoryFlowHdr, InventoryFlowDtl × N, TheJournal × 3 — execute inside that single
transaction. A failure in any insert rolls back all of them. The POS `SyncJob` row is NOT
affected by the mssql rollback (cross-engine independence).

---

## 6. Schema Migration (`sync_job_outbox`)

### 6.1 `SyncJob` extension (additive fields)

The current `SyncJob` model has: `id, type, direction, ref, amount, status, provider, error,
response, branchId, createdAt, updatedAt` (from `prisma/schema.prisma` L43–56).

Add the following to `model SyncJob` in `prisma/schema.prisma`:

```prisma
  // Outbox extension (krs-sync P2 — additive; all nullable/defaulted for back-compat)
  payload          Json?      // Snapshot of the POS sale at enqueue; dispatcher reads this, not live DB
  idempotencyKey   String?    @unique  // "<orderNumber>_<jobType>" — @unique allows multiple NULLs
  attempts         Int        @default(0)
  lastError        String?    // Last attempt's error string (distinct from `error`, which is the terminal reason)
  nextAttemptAt    DateTime?  // Retry gate: null = immediately eligible; future = waiting
  lockedAt         DateTime?  // Dispatch lock: set to now() on claim, cleared on complete/fail
```

### 6.2 Migration SQL (authoritative shape)

```sql
-- Migration: sync_job_outbox
-- Additive only. All columns nullable or have defaults — no existing rows or seed data changes.

ALTER TABLE "SyncJob"
  ADD COLUMN IF NOT EXISTS "payload"        JSONB,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS "attempts"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastError"      TEXT,
  ADD COLUMN IF NOT EXISTS "nextAttemptAt"  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "lockedAt"       TIMESTAMPTZ;
```

Note: Prisma generates this via `prisma migrate dev --name sync_job_outbox`. The `@unique`
index on `idempotencyKey` allows multiple `NULL`s in Postgres (per standard), so legacy seed
rows are unaffected.

### 6.3 Migration safety

- Zero downtime: all new columns are nullable/defaulted — rolling deploy safe.
- Existing seed data: 8-row seed in `prisma/seed.ts` has no `idempotencyKey` values; they will
  be `NULL`, which is correct (legacy rows).
- Rollback: `ALTER TABLE "SyncJob" DROP COLUMN "payload", DROP COLUMN "idempotencyKey", ...`
  — but this is only needed if P2 is rolled back before any SYNCED rows write these fields.

---

## 7. Outbox Enqueue in Checkout (Minimal Touch)

### 7.1 Location in `src/app/api/orders/route.ts`

The `$transaction` block (lines ~647–711 in the current file) currently ends with:

```typescript
return created;
```

The outbox enqueue is added BEFORE `return created`, AFTER all existing stock decrement +
`StockMovement` creates. The complete addition is exactly one `tx.syncJob.create(...)` call.

### 7.2 Enqueue logic (pseudocode — not implementation)

```
INSIDE $transaction, after all stockMovement.create calls:

1. BUILD SalePayload snapshot from:
   - `created` (the order just created by tx.order.create — all fields available)
   - `lineItems` (the server-computed per-line amounts)
   - the resolved `cashierName` (requires one extra User.findUnique BEFORE the
     $transaction, selecting { name: true } — OR inline a select on the cashier
     relation in the ORDER_INCLUDE and pass name from session). PREFERRED: add
     `cashier: { select: { id: true, name: true } }` to the existing ORDER_INCLUDE
     (already has `cashier: { select: { id: true, name: true } }`). The `created`
     object already includes it via ORDER_INCLUDE.
   - `resolvedCustomer` (already in scope)
   - `sellerConfig` (branchCode / branchName) — MUST be loaded BEFORE the
     $transaction (Prisma does not allow nested async operations mid-transaction
     that hit the same prisma client). Assign to a variable `const sellerConfig =
     await getSellerConfig()` between the shift lookup and the `$transaction` open.
     If null (seller not configured), the outbox row is still created but
     `branchCode`/`branchName` default to `"00000"` / `"สำนักงานใหญ่"` so the
     KRS write does not fail on missing branch.

2. ASSERT idempotencyKey is non-null (throw if null/empty — rolls back whole tx).

3. tx.syncJob.create({ data: { type: SALE, direction: INSERT, ref: orderNumber,
   amount: created.total (Decimal — already a Decimal; pass directly to avoid
   Number() round-trip), status: PENDING, provider: "KRS", idempotencyKey, payload,
   attempts: 0, branchId } })
```

**Blast radius of this change:** the `$transaction` adds one write (SyncJob insert). If the
SyncJob insert fails (e.g. duplicate idempotencyKey — which should not occur because
`orderNumber` is already unique), the whole `$transaction` rolls back — the Order, stock
decrement, and StockMovements are undone. This is CORRECT behavior: an order with no sync row
is worse than a failed checkout. The cashier retries (the checkout idempotency key collapses
the retry to the same order).

**`sellerConfig` load placement:** `getSellerConfig()` is an async call that hits Prisma —
it CANNOT be inside the `$transaction`. It goes between the existing `openShift` lookup and
the `prisma.$transaction(async (tx) => {` call, reusing the same pattern as `openShift`. If
`getSellerConfig()` throws (a DB error), the catch at the bottom of the handler returns a
sanitized 500 — checkout is blocked only if the DB itself is down, which is an acceptable
failure mode.

**pricing-tester MUST be run after this change** (CLAUDE.md mandate for any checkout touch).

---

## 8. Dispatcher (`src/lib/krs/dispatcher.ts`)

### 8.1 Atomic claim query

```sql
-- Claim up to BATCH_SIZE eligible jobs atomically.
-- "eligible" = PENDING status + lock free or stale (>10min) + retry gate passed.
-- Returns the claimed row ids only (no data leakage).
UPDATE "SyncJob"
SET "lockedAt" = NOW(),
    "status"   = 'RETRYING',
    "updatedAt" = NOW()
WHERE id IN (
  SELECT id FROM "SyncJob"
  WHERE "status" IN ('PENDING', 'RETRYING')
    AND ("lockedAt" IS NULL OR "lockedAt" < NOW() - INTERVAL '10 minutes')
    AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
  ORDER BY "createdAt" ASC
  LIMIT $1  -- BATCH_SIZE constant = 10
  FOR UPDATE SKIP LOCKED   -- Postgres advisory: skip rows already locked by another claim
)
RETURNING id;
```

Using `FOR UPDATE SKIP LOCKED` (Postgres advisory row locking) makes the claim fully
concurrent-safe even with `FOR UPDATE` semantics. `SKIP LOCKED` means two concurrent workers
claim disjoint sets of rows — no row is double-claimed.

This executes as `prisma.$queryRaw<{ id: string }[]>` with a bound `$1` parameter.

**Zero-rows result:** if the claim returns 0 rows, `runDispatch()` returns immediately with
`{ claimed: 0, synced: 0, failed: 0, skipped: 0 }` — no error, no KRS call.

### 8.2 Dispatcher state machine

```
CLAIM (atomic) → status = RETRYING, lockedAt = now()
  │
  ├─ DEDUP CHECK: existing SyncJob WHERE idempotencyKey = thisKey AND status = 'SYNCED'?
  │   └─ YES → UPDATE status=SKIPPED, lockedAt=null; done for this job
  │
  ├─ FEATURE FLAG: KRS_OUTBOUND_ENABLED !== "true"?
  │   └─ YES → UPDATE status=PENDING (re-queue), lockedAt=null; log at debug level
  │
  ├─ CALL writeback.ts → writeKrsSale(payload, sandboxConfig)
  │   ├─ SUCCESS → UPDATE status=SYNCED, lockedAt=null,
  │   │             response=JSON.stringify({ transactionNo }),
  │   │             attempts=attempts+1 (the succeeded attempt)
  │   │
  │   └─ FAILURE (throws) →
  │       attempts = currentAttempts + 1
  │       lastError = sanitizedErrorMessage (never raw driver error)
  │       ├─ attempts < MAX_ATTEMPTS (5) →
  │       │   nextAttemptAt = now() + min(BASE_DELAY_MS * 2^attempts, MAX_DELAY_MS)
  │       │   status = PENDING, lockedAt = null
  │       └─ attempts >= MAX_ATTEMPTS →
  │           status = FAILED (terminal), lockedAt = null
  │           (NavRail failed badge counts FAILED; RETRYING self-heals via stale reclaim)
```

### 8.3 Retry constants

```typescript
const BATCH_SIZE    = 10;       // jobs claimed per dispatch call
const MAX_ATTEMPTS  = 5;        // terminal after 5 failures
const BASE_DELAY_MS = 30_000;   // 30 seconds base
const MAX_DELAY_MS  = 3_600_000; // 1 hour cap
// Backoff: min(BASE_DELAY_MS * 2^attempts, MAX_DELAY_MS)
// Attempt 1 → 30s, 2 → 60s, 3 → 120s, 4 → 240s, 5 → terminal FAILED
```

### 8.4 Error logging

The dispatcher catches errors from `writeback.ts`. The KRS write module throws sanitized
errors only (never the raw `mssql` driver error or pool config). The dispatcher logs:
`logger.error({ krsDispatch: { jobId, idempotencyKey, attempts, code, message } }, "KRS dispatch failed")`.
The raw driver error NEVER reaches `logger.error({ err })` directly (would embed password
via driver object internals per P0 spec §2.5 R5).

---

## 9. KRS Write Module (`src/lib/krs/writeback.ts`)

### 9.1 CONFIG block (`src/lib/krs/writebackConfig.ts`)

All vendor constants are in ONE dedicated file. Values known from the P0 spec + field analysis
are filled in; values still awaiting vendor confirmation are `TODO_FROM_VENDOR` placeholders.
EXECUTE must not guess any placeholder value.

```typescript
// src/lib/krs/writebackConfig.ts
// KRS outbound write constants for a cash sale (SalesInvoice + InventoryFlow + TheJournal).
// All "TODO_FROM_VENDOR" values are EXECUTE PREREQUISITES — see krs-outbound-writeback_PLAN_25-06-26.md §10.

export const KRS_WRITE_CONFIG = {
  // === RunningNumber ===
  RUNNING_NUMBER_NAME_INVOICE: "TODO_FROM_VENDOR", // e.g. "ORCM..." or "Receipt" for invoice
  RUNNING_NUMBER_NAME_RECEIPT: "Receipt",           // CONFIRMED — TheJournal uses this
  RUNNING_NUMBER_NAME_INVFLOW: "TODO_FROM_VENDOR",  // InventoryFlow running number key (if separate)

  // === Document format ===
  DOC_NO_FORMAT: "SC-XXXX-XXXX",  // CONFIRMED — journal doc no format; adapt for invoice
  JOURNAL_SOURCE_TYPE: "SC",       // CONFIRMED
  JOURNAL_TRANSACTION_TYPE_I: 1,   // CONFIRMED
  JOURNAL_TRANSACTION_TYPE_T: 1,   // CONFIRMED
  JOURNAL_CURRENCY: "THB",         // CONFIRMED
  JOURNAL_DEPARTMENT: "SAL",       // CONFIRMED
  JOURNAL_BRANCH_CODE: "00000",    // CONFIRMED (from TheJournal spec)
  JOURNAL_BRANCH_NAME: "สำนักงานใหญ่", // CONFIRMED
  JOURNAL_JNL_NAME: "TODO_FROM_VENDOR", // JnlName field value
  JOURNAL_DESCRIPTION_FORMAT: "TODO_FROM_VENDOR", // how Description is formatted per line

  // === AccountHead group names (account code resolution) ===
  ACCOUNT_HEAD_CASH_GROUP: "Assets3",      // CONFIRMED
  ACCOUNT_HEAD_REVENUE_GROUP: "Revenues2", // CONFIRMED
  ACCOUNT_HEAD_VAT_GROUP: "Liabilities4",  // CONFIRMED

  // === SalesInvoice constants ===
  INVOICE_TYPE: "TODO_FROM_VENDOR",         // InvoiceType code for cash sale
  SALE_TYPE: "TODO_FROM_VENDOR",            // SaleType code
  ITEM_TYPE: "TODO_FROM_VENDOR",            // ItemType code
  TRANSACTION_TYPE_I: "TODO_FROM_VENDOR",   // TransactionTypeI (SalesInvoice)
  TRANSACTION_TYPE_T: "TODO_FROM_VENDOR",   // TransactionTypeT (SalesInvoice)
  DOCU_TYPE: "TODO_FROM_VENDOR",            // DocuType code
  SOURCE_TYPE_DTL: "TODO_FROM_VENDOR",      // SourceType for SalesInvoiceDtl
  IS_VAT: 1,                                // DERIVED — cash sale always has VAT
  IS_PAID: 1,                               // DERIVED — cash = paid immediately
  IS_CLOSED: "TODO_FROM_VENDOR",            // IsClosed for a paid cash sale (0 or 1?)
  IS_UNDUE_VAT: 0,                          // ASSUMED 0 for standard VAT; confirm

  // === Org constants ===
  COMPANY_CODE: "TODO_FROM_VENDOR",         // CompanyCode org constant
  DEPT_CODE: "TODO_FROM_VENDOR",            // DeptCode org constant
  DEPARTMENT: "TODO_FROM_VENDOR",           // Department org constant (invoice side)
  ACCOUNT_CODE: "TODO_FROM_VENDOR",         // AccountCode (header default)

  // === Walk-in customer ===
  WALK_IN_CUST_CODE: "TODO_FROM_VENDOR",    // KRS "cash customer" code for no-customer sale
  WALK_IN_CUST_NAME: "เงินสด",              // DERIVED — Thai "cash" label

  // === InventoryFlow constants ===
  INV_TRANSACTION_TYPE: "TODO_FROM_VENDOR", // TransactionType for stock-out from sale
  INV_REASON_INDEX: "TODO_FROM_VENDOR",     // ReasonIndex (ตัดออกจากการขาย)
  INV_REASON_NAME: "ตัดออกจากการขาย",      // ASSUMED — confirm exact string
  WAREHOUSE: "TODO_FROM_VENDOR",            // Warehouse code (WHFG? confirm)
  IN_OUT: -1,                               // CONFIRMED — stock out = -1
  INV_APPROVED: 1,                          // CONFIRMED — must be 1 for sp_Onhand to count
  INV_IS_CLOSED: 0,                         // CONFIRMED — must be 0 for sp_Onhand to count

  // === VAT ===
  VAT_PERCENT: 7,                           // CONFIRMED — Thai standard VAT

  // === MainUnits resolution ===
  MAIN_UNITS_COLUMN: "TODO_FROM_VENDOR",    // Column name in KRS InventoryItem for unit of measure
  UNIT_PRICE_INCL_VAT: "TODO_FROM_VENDOR",  // true = include VAT, false = exclude (confirm)
};
```

### 9.2 `writeKrsSale(payload, config)` function contract

```typescript
// src/lib/krs/writeback.ts

type KrsWriteResult = {
  transactionNo: string;     // The generated document number (for SyncJob.response)
  journalNo: string;         // The journal document number
};

/**
 * Write one POS cash sale to KRS in a single mssql transaction.
 * All parameterized — no string interpolation of user/sale data into SQL.
 * Throws a sanitized Error on any failure (never the raw mssql driver error).
 * NEVER called inside or during a Prisma $transaction.
 * NEVER called when KRS_OUTBOUND_ENABLED !== "true".
 */
export async function writeKrsSale(
  payload: SalePayload,
  config: sql.config  // sandbox config from sandboxClient.ts
): Promise<KrsWriteResult>
```

### 9.3 RunningNumber atomic claim

The vendor's `MAX(Number) + 1` pattern is race-prone (two concurrent sales get the same
number). The safe pattern requires a serializable sub-transaction or an `UPDATE…OUTPUT`
statement. Preferred approach (to be confirmed against vendor's actual RunningNumber table
schema):

```sql
-- Option A: UPDATE with OUTPUT (SQL Server-native, single-statement atomic)
-- Assumes RunningNumber(Name VARCHAR, Number INT, ...)
BEGIN TRANSACTION;
  DECLARE @nextNo INT;
  UPDATE RunningNumber WITH (UPDLOCK, SERIALIZABLE)
     SET Number = Number + 1,
         @nextNo = Number + 1
   WHERE Name = ?;
  -- If no row affected, INSERT (first use)
  IF @@ROWCOUNT = 0 BEGIN
    SET @nextNo = 1;
    INSERT INTO RunningNumber (Name, Number) VALUES (?, 1);
  END
  SELECT @nextNo AS NextNumber;
COMMIT;
```

This executes as a single parameterized `mssql` request INSIDE the outer sale transaction
(the RunningNumber update and the 5 inserts are all in one `BEGIN TRANSACTION / COMMIT`).

**Prerequisite:** the actual RunningNumber table schema (column names, PK) must be confirmed
(§10 item 3). Adjust the SQL above once confirmed.

### 9.4 Insert sequence (all inside ONE mssql BEGIN/COMMIT)

All `?` parameters are bound via `request.input("param", sql.Type, value)` — no template
string interpolation of sale data.

**Step 1 — RunningNumber claim:**
- Claim the next invoice number (`Name = CONFIG.RUNNING_NUMBER_NAME_INVOICE`).
- The result is `TransactionNo` (used in all subsequent inserts).
- Also claim the journal number (`Name = CONFIG.RUNNING_NUMBER_NAME_RECEIPT`) for `TheJournal`.

**Step 2 — INSERT SalesInvoiceHdr (1 row):**

| Field | Value source |
|-------|-------------|
| TransactionNo | RunningNumber result (invoice) |
| VoucherNo | RunningNumber result (same or separate?) — TBD |
| VoucherDate | `payload.createdAt` (parsed to Date) |
| DueDate | `payload.createdAt` (cash = same day) |
| InvoiceType | `CONFIG.INVOICE_TYPE` |
| SaleType | `CONFIG.SALE_TYPE` |
| ItemType | `CONFIG.ITEM_TYPE` |
| TransactionTypeI | `CONFIG.TRANSACTION_TYPE_I` |
| TransactionTypeT | `CONFIG.TRANSACTION_TYPE_T` |
| DocuType | `CONFIG.DOCU_TYPE` |
| CompanyCode | `CONFIG.COMPANY_CODE` |
| DeptCode | `CONFIG.DEPT_CODE` |
| Department | `CONFIG.DEPARTMENT` |
| AccountCode | `CONFIG.ACCOUNT_CODE` |
| CustOrSuppCode | `payload.customerCode ?? CONFIG.WALK_IN_CUST_CODE` |
| CustOrSuppName | `payload.customerName ?? CONFIG.WALK_IN_CUST_NAME` |
| CustOrSuppAddress | `payload.customerAddress ?? ""` |
| IsVAT | `CONFIG.IS_VAT` (1) |
| IsPaid | `CONFIG.IS_PAID` (1) |
| IsClosed | `CONFIG.IS_CLOSED` |
| Currency | `"THB"` |
| ExchangeRate | `1` |
| TermsofPayment | `"เงินสด"` |
| Paymentinday | `0` |
| CreditLimit | `0` |
| TotalAmount | `payload.total` (Decimal string, bound as DECIMAL) |
| AmountDue | `payload.total` |
| AmountDueBht | `payload.total` |
| SubTotalAmnt | `payload.subtotal` |
| VATForValue | `payload.subtotal` |
| VATAmount | `payload.tax` |
| VATPercent | `CONFIG.VAT_PERCENT` (7) |
| DiscountAmount | `payload.discount` |
| TotalMainQty | sum of `payload.items[*].quantity` |
| CashValue | `payload.amountPaid` |
| TotalCQ, TotalTF, TotalREC, OthExp, BankFree, TotalDR, OthRec, CqValue, TransFerValue | `0` |
| TotalCR | `payload.total` (total credited to AR) |
| ARAPJnl, VATJnl, DiscountJnl, CostOfSaleJnl, InventoryJnl, RevenueJnl | `TODO_FROM_VENDOR` (KRS-filled or format TBD) |
| AccountsDescription, ChargeOrDiscountAccount, DiscountAccount, TaxAccount | `TODO_FROM_VENDOR` |
| TaxPercen | `CONFIG.VAT_PERCENT` |
| WithHoldValue | `0` |
| DepositAmount | `0` |
| IsUndueVAT | `CONFIG.IS_UNDUE_VAT` |
| SalePerson | `payload.cashierId` |
| SaleName | `payload.cashierName` |
| EntryBy | `payload.cashierName` |
| BranchCode | `payload.branchCode` |
| BranchName | `payload.branchName` |
| Remarks | `payload.orderNumber` (idempotency anchor + traceability) |
| EntryDate | SQL `GETDATE()` |

**Step 3 — INSERT SalesInvoiceDtl (1 row per `payload.items[i]`):**

| Field | Value source |
|-------|-------------|
| TransactionNo | = Hdr TransactionNo |
| ItemOrder | line index `i + 1` (1-based) |
| ItemCode | `item.itemCode` |
| Description | `item.description` |
| MainQuantity | `item.quantity` |
| MainUnits | Resolved from KRS `InventoryItem` at dispatch time via `SELECT CONFIG.MAIN_UNITS_COLUMN FROM InventoryItem WHERE ItemCode = ?` (one lookup per distinct sku, cached within the transaction). If not found, use empty string. |
| UnitPrice | `item.unitPrice` (incl or excl VAT per `CONFIG.UNIT_PRICE_INCL_VAT` — TBD) |
| Amount | `item.lineTotal` |
| DiscountPercent | `0` (bill-level discount is already folded into `subtotal`; line discount folded into `lineTotal`) |
| DiscountAmount | `item.lineDiscount` |
| SourceType | `CONFIG.SOURCE_TYPE_DTL` |
| AccountCode | `CONFIG.ACCOUNT_CODE` |
| Currency | `"THB"` |
| InventoryJnl | `TODO_FROM_VENDOR` |
| RevenueJnl | `TODO_FROM_VENDOR` |
| CostOfSaleJnl | empty/null — **KRS computes COGS itself** (CONFIRMED 2026-06-25) |
| ForItemCode | `""` (blank — no SO in POS) |
| OrderNo, OrderTrNo | `""` / `0` (no SO) |
| FlowNo, FlowTrNo | Cross-link to InventoryFlow — value depends on `TODO_FROM_VENDOR` linkage contract (§10 item 4) |

**Step 4 — INSERT InventoryFlowHdr (1 row):**

| Field | Value source |
|-------|-------------|
| TransactionNo | RunningNumber result (invoice flow) — same as invoice or separate? (§10 item 3) |
| IsStock | `1` |
| IncludeVat | `TODO_FROM_VENDOR` |
| TransactionType | `CONFIG.INV_TRANSACTION_TYPE` |
| ReasonIndex | `CONFIG.INV_REASON_INDEX` |
| ReasonName | `CONFIG.INV_REASON_NAME` |
| Approved | `CONFIG.INV_APPROVED` (1) |
| IsClosed | `CONFIG.INV_IS_CLOSED` (0) |
| IsAssetForm | `0` |
| InOutDate | `payload.createdAt` |
| InOut | `CONFIG.IN_OUT` (-1) |
| SalesInvoiceTrNo | = SalesInvoice TransactionNo (cross-link) |
| SalesInvoiceNo | = SalesInvoice document number (cross-link) — §10 item 4 |
| SalesInvoiceDate | `payload.createdAt` |
| CompanyCode | `CONFIG.COMPANY_CODE` |
| DeptCode | `CONFIG.DEPT_CODE` |
| Department | `CONFIG.DEPARTMENT` |
| VoucherNo | `TODO_FROM_VENDOR` |
| CustOrSupCode | `payload.customerCode ?? CONFIG.WALK_IN_CUST_CODE` |
| CustOrSupName | `payload.customerName ?? CONFIG.WALK_IN_CUST_NAME` |
| CustOrSupAddress | `payload.customerAddress ?? ""` |
| Remark | `payload.orderNumber` |
| RequestBy | `payload.cashierName` |
| EntryBy | `payload.cashierName` |
| EntryDate | SQL `GETDATE()` |

**Step 5 — INSERT InventoryFlowDtl (1 row per `payload.items[i]`):**

| Field | Value source |
|-------|-------------|
| TransactionNo | = InventoryFlowHdr TransactionNo |
| Number | line index `i + 1` |
| ItemCode | `item.itemCode` |
| Description | `item.description` |
| MainQuantity | `item.quantity` |
| MainUnits | same as SalesInvoiceDtl.MainUnits |
| InOut | `CONFIG.IN_OUT` (-1) |
| Warehouse | `CONFIG.WAREHOUSE` |
| Approved | `CONFIG.INV_APPROVED` (**1** — CRITICAL for sp_Onhand) |
| IsClosed | `CONFIG.INV_IS_CLOSED` (**0** — CRITICAL for sp_Onhand) |
| IsStock | `1` |
| IsAssetForm | `0` |
| TransactionType | `CONFIG.INV_TRANSACTION_TYPE` |
| ReasonIndex | `CONFIG.INV_REASON_INDEX` |
| ReasonName | `CONFIG.INV_REASON_NAME` |
| SONo, SOTrNo | `""` / `0` (no SO) |
| ForItemCode | `""` |
| LotNo | `""` (no lot tracking confirmed or blank) |
| CompanyCode | `CONFIG.COMPANY_CODE` |
| Department | `CONFIG.DEPARTMENT` |
| VoucherNo | `TODO_FROM_VENDOR` |
| RemarkDTL | `payload.orderNumber` |

**sp_Onhand critical invariant:** `Approved=1` AND `IsClosed=0` (or `IsClosed <> 1`) is the
exact gate condition the KRS `sp_Onhand` function reads. Both values MUST be set. They are
constants from CONFIG so an incorrect vendor constant would be immediately detectable in the
sandbox dry-run (sp_Onhand would show no stock change).

**Step 6 — Resolve AccountHead codes (3 SELECTs, INSIDE the transaction):**

```sql
SELECT TOP 1 ACC_CODE FROM AccountHead WITH (NOLOCK)
  WHERE ACC_GRPNAME = ?  ORDER BY Roworder;
```

Execute once per group: `Assets3`, `Revenues2`, `Liabilities4`. Bind as NVarChar parameters.
If any SELECT returns 0 rows, throw a sanitized error (the account is not configured in KRS —
this is a CONFIG problem, not a POS problem).

**Step 7 — INSERT TheJournal (3 rows: DR cash, CR revenue, CR output-VAT):**

| Posting | DrCr | GLAccount | Amount |
|---------|------|-----------|--------|
| เงินสด (Cash) | `"D"` | `Assets3` code | `payload.total` |
| รายได้ขายสด (Revenue) | `"C"` | `Revenues2` code | `payload.subtotal` |
| ภาษีขาย (Output VAT) | `"C"` | `Liabilities4` code | `payload.tax` |

Common fields per TheJournal row:
- `JnlName` = `CONFIG.JOURNAL_JNL_NAME`
- `JnlCode` = RunningNumber result (`Name="Receipt"`)
- `TransactionTypeI` = `CONFIG.JOURNAL_TRANSACTION_TYPE_I` (1)
- `TransactionTypeT` = `CONFIG.JOURNAL_TRANSACTION_TYPE_T` (1)
- `CompanyCode` = `CONFIG.COMPANY_CODE`
- `Department` = `CONFIG.JOURNAL_DEPARTMENT` (`"SAL"`)
- `JnlDate` = `payload.createdAt`
- `Description` = `CONFIG.JOURNAL_DESCRIPTION_FORMAT` (TBD)
- `Currency` = `"THB"`
- `AmountBht` = same as `Amount` (THB = equal)
- `SourceType` = `CONFIG.JOURNAL_SOURCE_TYPE` (`"SC"`)
- `SourceNo` = `TransactionNo` (sale's document number — links journal → sale)
- `VoucherNo` = journal document number (`"SC-XXXX-XXXX"` format using journal RunningNumber)
- `JournalNo` = same as `VoucherNo`
- `ActualInvoiceNo` = same as `VoucherNo`
- `BranchCode` = `CONFIG.JOURNAL_BRANCH_CODE` (`"00000"`)
- `BranchName` = `CONFIG.JOURNAL_BRANCH_NAME` (`"สำนักงานใหญ่"`)

**Double-entry balance check (before INSERT, as assertion):**
```typescript
assert(totalSatang === subtotalSatang + taxSatang,
  `Journal imbalance: total ${payload.total} ≠ subtotal ${payload.subtotal} + tax ${payload.tax}`);
```
This is a defensive check — the checkout `computeOrderTotals` already guarantees it, but the
write module asserts it again as a last safety gate before hitting the ERP.

---

## 10. Explicit Execute Prerequisites

These items GATE Track B (the KRS write module). Track A (POS infrastructure) can be built
and shipped WITHOUT them. Do NOT begin Step 10 (CONFIG block with real values) or Steps 11–16
until ALL applicable prerequisites below are received from the vendor/owner.

| # | Prerequisite | Needed for | Status |
|---|-------------|-----------|--------|
| 1 | **Sandbox KRS connection** — host, port, database, username, password (separate DB, NOT prod). A least-privilege SQL login with write access to `RunningNumber, SalesInvoiceHdr, SalesInvoiceDtl, InventoryFlowHdr, InventoryFlowDtl, TheJournal` and read access to `AccountHead, InventoryItem`. | Step 8 (sandboxClient), Step 19 (dry-run) | OPEN |
| 2 | **SalesInvoice/InventoryFlow INSERT constants** — exact values for: `InvoiceType, SaleType, ItemType, TransactionTypeI/T (invoice side), DocuType, SourceType (SalesInvoiceDtl), IsClosed (paid cash invoice), IsUndueVAT, TransactionType (InventoryFlow), ReasonIndex, ReasonName, IncludeVat` | Steps 12–13, CONFIG block | OPEN |
| 3 | **RunningNumber scheme** — the Name key(s) for SalesInvoice and InventoryFlow (are they the same key or separate?), the number format (e.g. `ORCM6906xxxxxx`), and the VENDOR'S recommended safe atomic increment pattern (does KRS use UPDATE with UPDLOCK? sp_GetNewNumber? something else?) | Step 11 (RunningNumber claim) | OPEN |
| 4 | **Cross-table linkage values** — exactly which values go in: `SalesInvoiceDtl.FlowNo / FlowTrNo` (link to InventoryFlow), `InventoryFlowHdr.SalesInvoiceTrNo / SalesInvoiceNo` (link back to SalesInvoice), `OrderNo/OrderTrNo` (blank for POS?), `SONo/SOTrNo` (blank?), and `VoucherNo` semantics (same as TransactionNo or separate?) | Steps 12–13 (Dtl), Step 13 (FlowHdr) | OPEN |
| 5 | **Idempotency anchor field** — confirm that `SalesInvoiceHdr.Remarks` is the correct field for storing the POS `orderNumber` (for duplicate-check before insert: `SELECT TOP 1 TransactionNo FROM SalesInvoiceHdr WHERE Remarks = ?`). OR does KRS have its own unique constraint we can rely on as a fallback? | Steps 12, 15 (idempotency check) | OPEN |
| 6 | **Warehouse code** — confirm `WHFG` or the exact code for front-store sale stock-out in `InventoryFlowDtl.Warehouse` | Step 13 (FlowDtl), CONFIG block | OPEN |
| 7 | **MainUnits source + UnitPrice VAT basis** — which column in KRS `InventoryItem` holds the unit of measure (e.g. `MainUnits`, `Unit1`, `ItemUnit`)? Does KRS expect `UnitPrice`/`Amount` in `SalesInvoiceDtl` to be inclusive or exclusive of VAT? (POS stores inclusive — if KRS expects exclusive, the write module must back-calculate: `ex-VAT = total / 1.07`) | Steps 12–13 (Dtl rows), SalePayload | OPEN |
| 8 | **Org constants** — `CompanyCode`, `DeptCode`, `Department` (invoice side), `AccountCode` (default), `JnlName` (TheJournal), `Description` format for journal rows | CONFIG block | OPEN |
| 9 | **`*Jnl` field relationship** — do `ARAPJnl, RevenueJnl, InventoryJnl, VATJnl, DiscountJnl` in `SalesInvoiceHdr/Dtl` need to be filled by POS, or does KRS fill/compute them? If POS must fill them: what format (JnlCode string? account code? free text?) | Steps 12–13 (Hdr/Dtl) | OPEN |
| 10 | **Real sample bill** — one complete bill from the sandbox with actual values in all 5 tables + `TheJournal` 3 rows. This is the most reliable way to close gaps 2–8 above at once. | All write steps | OPEN |
| 11 | **Payment type handling** — are card/QR/transfer sales handled identically to cash sales in KRS, or do they use different `SaleType`/`InvoiceType`/`CashValue` treatment? P2 targets cash-only; this confirms whether CARD/QR/TRANSFER checkouts should enqueue a SALE SyncJob or be deferred. | Outbox enqueue gate (Step 3) | OPEN |
| 12 | **Void/refund reversal ownership** — does the POS send a compensating positive `InventoryFlow` row on a refund/void, OR does KRS independently reverse stock on its void document? This determines whether `STOCK_REVERSAL` SyncJobs in Step 9 are a stub or implemented. | Step 9 | OPEN |

**Disposition of prerequisites at EXECUTE time:** the plan executor MUST fill in all confirmed
values in `writebackConfig.ts` and replace every `TODO_FROM_VENDOR` before any sandbox dry-run.
The plan MUST NOT be marked complete with any `TODO_FROM_VENDOR` remaining in production-path code.

---

## 11. Feature Flag + Sandbox Connection Separation

### 11.1 Feature flag

```
KRS_OUTBOUND_ENABLED=false   # Default OFF. Set to "true" only on the sandbox environment
                             # after sandbox verification is complete.
```

The dispatcher checks `env.KRS_OUTBOUND_ENABLED !== "true"` before calling `writeback.ts`.
When OFF, claimed jobs are re-queued (lockedAt cleared, status=PENDING) and the endpoint
returns a 503 `OUTBOUND_DISABLED`. This allows Track A to be deployed to production without
risk.

### 11.2 Sandbox connection (SEPARATE from prod inbound)

```
# Sandbox-only env vars (NEVER reuse production KRS connection)
KRS_SANDBOX_HOST=
KRS_SANDBOX_PORT=1433
KRS_SANDBOX_DB=
KRS_SANDBOX_USER=
KRS_SANDBOX_PASS=          # plaintext in .env (sandbox, not prod); AES-encrypt only for DB-stored creds
KRS_SANDBOX_SSL=true
KRS_SANDBOX_TRUST_CERT=true
```

`src/lib/krs/sandboxClient.ts` reads these env vars directly (NOT from `KrsConnectionSettings`
— that row is the prod KRS connection used by inbound sync). The sandbox client is imported
ONLY by `writeback.ts` and the dispatch endpoint. The production inbound `buildConnectionConfig()`
in `client.ts` is completely unchanged.

**Why separate:** the P0 spec mandates that the outbound write target be a SEPARATE sandbox
connection, distinct from the production KRS connection used by inbound. This eliminates any
risk of accidentally writing to production KRS during verification.

---

## 12. Refund/Void — STOCK_REVERSAL Handling

The P0 spec (§4.1) defaults to: POS sends a compensating positive `InventoryFlow` row to KRS
on a refund/void (type `STOCK_REVERSAL`, `idempotencyKey = "${orderNumber}_STOCK_REVERSAL"`).

**Current code:** `src/app/api/orders/[id]/route.ts` (the refund/void path) already restores
Postgres `Product.stock` and writes an `ADJUST` `StockMovement`. It does NOT currently enqueue
any SyncJob.

**P2 decision gate (§10 item 12):** if the owner confirms KRS self-reverses on a void document,
the POS sends NO `STOCK_REVERSAL` row. If the owner confirms POS must send the reversal, the
P2 execution adds an enqueue in the refund/void path.

**Implementation guidance:**
- Until §10 item 12 is resolved, add a code comment in `src/app/api/orders/[id]/route.ts` at
  the refund/void stock-restore location:
  `// TODO(krs-sync-P2): enqueue STOCK_REVERSAL SyncJob here once owner confirms KRS reversal ownership`
- If CONFIRMED POS sends: add `prisma.syncJob.create(...)` (OUTSIDE the `$transaction` in the
  refund path — the refund path already commits before logging audit; the SyncJob is best-effort
  here because the Postgres stock is already restored and the KRS reversal is async. This is
  distinct from the checkout outbox which IS inside the `$transaction` because atomicity of
  sale+outbox is the invariant). idempotencyKey = `${orderNumber}_STOCK_REVERSAL`.

---

## 13. Verification

### 13.1 After every checkout-route touch: pricing-tester

Per `CLAUDE.md`: **Run `pricing-tester` after any change to `src/app/api/orders/route.ts`**.
The outbox enqueue (Step 3) is a change to that file. The pricing-tester agent is invoked
immediately after Step 3 is committed.

### 13.2 Type-check + build gate

Both must pass before any step is marked complete:
```
npm run type-check   # tsc --noEmit — zero errors
npm run build        # Next.js production build — zero errors
```

These run after: Step 1–2 (migration), Step 3–4 (checkout enqueue), Step 5–6 (dispatch
endpoint), Step 7 (dispatcher), and Step 16 (write module complete).

### 13.3 Sandbox dry-run (Track B verification — requires §10 prerequisites)

**Procedure:**
1. Set `KRS_OUTBOUND_ENABLED=true`, `KRS_SANDBOX_*` pointing at the vendor sandbox DB.
2. Perform a real POS checkout (use a test product with known SKU in KRS).
3. Trigger dispatch: `POST /api/krs/dispatch` with the bearer secret.
4. Observe SyncJob status transitions: PENDING → RETRYING → SYNCED.
5. Query sandbox KRS:
   ```sql
   SELECT TOP 1 * FROM SalesInvoiceHdr WHERE Remarks = '<orderNumber>' ORDER BY EntryDate DESC;
   SELECT * FROM SalesInvoiceDtl WHERE TransactionNo = '<above TransactionNo>';
   SELECT * FROM InventoryFlowDtl WHERE TransactionNo = '<InventoryFlow TransactionNo>';
   SELECT * FROM TheJournal WHERE SourceNo = '<TransactionNo>' ORDER BY DrCr;
   ```
6. Verify sp_Onhand reflects the stock-out:
   ```sql
   SELECT ItemCode, Balqty FROM dbo.sp_Onhand(NULL,NULL,NULL,NULL)
   WHERE ItemCode = '<sku>';
   ```
   `Balqty` should have decreased by the sold quantity.
7. Verify double-entry balance: `TheJournal` DR total = CR total.

### 13.4 Idempotency test

Re-dispatch the same SyncJob (reset `status=PENDING, attempts=0, nextAttemptAt=null`). Confirm:
- The dispatcher's dedup check detects the existing `SYNCED` row with the same `idempotencyKey`.
- Status becomes `SKIPPED` immediately.
- Zero new KRS rows inserted (re-query `SalesInvoiceHdr WHERE Remarks = '<orderNumber>'` returns
  exactly 1 row).

### 13.5 Concurrent dispatch test (atomic-claim proof)

Run two concurrent `POST /api/krs/dispatch` requests against the same PENDING job. Confirm:
- Exactly ONE of them claims the job (the other gets 0 rows from the `FOR UPDATE SKIP LOCKED`
  claim and returns `{ claimed: 0 }`).
- Exactly ONE KRS INSERT executed (verify in sandbox with `SELECT COUNT(*) FROM SalesInvoiceHdr WHERE Remarks = ?`).

### 13.6 Fail-open test

Kill the sandbox KRS connection mid-dispatch (or point `KRS_SANDBOX_HOST` at an unreachable
host). Perform a POS checkout. Confirm:
- Checkout completes with HTTP 201 (fail-open).
- SyncJob row exists with status `PENDING`.
- After restoring the sandbox connection and triggering dispatch: job drains to `SYNCED`.

### 13.7 Inbound reconcile loop closure

After a sandbox dry-run write, trigger the inbound auto-sync:
`POST /api/krs/auto-sync` → observe `sp_Onhand` delta is zero (POS and KRS stock now agree).

---

## 14. Ordered Implementation Checklist

Steps 1–9 are Track A (buildable immediately). Steps 10–16 are Track B (blocked on §10
prerequisites). Steps 17–20 span both.

**Track A — POS-side infrastructure**

1. `prisma/schema.prisma` — ADD 6 fields to `model SyncJob` as specified in §6.1. Add
   `// krs-sync P2 outbox extension — additive` comment block.

2. Run `npx prisma migrate dev --name sync_job_outbox` to generate the migration file.
   Verify migration SQL matches §6.2. Run `npm run type-check && npm run build` — green.

3. `src/lib/env.ts` — Add `KRS_OUTBOUND_ENABLED`, `KRS_DISPATCH_SECRET`, and the 7
   `KRS_SANDBOX_*` env vars (all optional at boot, not required). Add to `.env.example`
   with placeholder comments.

4. `src/app/api/orders/route.ts` — Add `getSellerConfig()` call between the `openShift`
   lookup and `prisma.$transaction(...)` open. Then inside `$transaction`, after all
   `tx.stockMovement.create(...)` calls and before `return created;`, add
   `tx.syncJob.create(...)` with the `SalePayload` snapshot as specified in §7.2.
   ASSERT idempotencyKey is non-null before the create. Touch NOTHING else in this file.

5. Run the `pricing-tester` agent immediately after Step 4. BLOCK on any failures.

6. `src/lib/krs/sandboxClient.ts` — CREATE. Reads `KRS_SANDBOX_*` env vars, builds an
   `mssql` `sql.config`, exports `buildSandboxConfig(): sql.config | null`. Apply the same
   sanitized-error pattern as `client.ts` (never log raw driver error/config).

7. `src/lib/krs/dispatcher.ts` — CREATE. Implements `runDispatch()` as specified in §8:
   atomic claim (`FOR UPDATE SKIP LOCKED`), dedup check, feature-flag gate, calls
   `writeKrsSale` (placeholder that throws NOT_IMPLEMENTED until Track B), retry/backoff,
   FAILED terminal. All mssql calls are outside any Prisma `$transaction`.

8. `src/app/api/krs/dispatch/route.ts` — CREATE. `POST` handler: bearer-secret + requireAdmin
   dual auth, calls `runDispatch()`, returns `{ claimed, synced, failed, skipped }`.
   Error responses match the API contract in §5.1.

9. `docker-compose.yml` — ADD `krs-dispatch-cron` service (mirrors `krs-cron`): runs
   dispatch curl every 30s. Reads `KRS_DISPATCH_SECRET` from environment. Only starts when
   `KRS_OUTBOUND_ENABLED=true` (use `profiles:` or a start condition, or document that the
   service should be commented out until enabled).

10. `src/app/api/orders/[id]/route.ts` — REVIEW refund/void path. Add the TODO comment from
    §12 at the stock-restore location. No code change unless §10 item 12 is already confirmed.

11. Run `npm run type-check && npm run build` — green before proceeding to Track B.

**Track B — KRS write module (blocked on §10 prerequisites)**

12. `src/lib/krs/writebackConfig.ts` — CREATE the CONFIG block as in §9.1. Fill in CONFIRMED
    values; leave `TODO_FROM_VENDOR` for still-open prerequisites. This file is committed with
    placeholders — a TODO grep check in CI can block deploy until all are resolved.

13. `src/lib/krs/writeback.ts` — CREATE `writeKrsSale(payload, config)`. Implement in order:
    a. Double-entry balance assertion (§9.4 Step 7 preamble).
    b. Idempotency guard: `SELECT TOP 1 TransactionNo FROM SalesInvoiceHdr WHERE Remarks = ?`
       — if found, return the existing TransactionNo (idempotent no-op).
    c. Open ONE mssql transaction (`pool.request().batch('BEGIN TRANSACTION')` or equivalent).
    d. RunningNumber atomic claim (§9.3) — invoice number + journal number.
    e. INSERT SalesInvoiceHdr (Step 2 of §9.4).
    f. INSERT SalesInvoiceDtl × N (Step 3).
    g. INSERT InventoryFlowHdr (Step 4).
    h. INSERT InventoryFlowDtl × N (Step 5) — VERIFY `Approved=1, IsClosed=0` in each row.
    i. Resolve AccountHead codes × 3 (Step 6).
    j. INSERT TheJournal × 3 (Step 7).
    k. COMMIT.
    l. Return `{ transactionNo, journalNo }`.
    All bindings use `request.input("paramName", sql.Type, value)`. No string interpolation
    of sale data. Sanitize all thrown errors (never re-throw raw driver error).

14. Update `dispatcher.ts` to replace the NOT_IMPLEMENTED placeholder with the real call to
    `writeKrsSale(payload, sandboxConfig)`.

15. Update `src/lib/krs/index.ts` to export `runDispatch`, `writeKrsSale`, `SalePayload`,
    `KrsWriteResult`, `buildSandboxConfig`.

16. Run `npm run type-check && npm run build` — green.

**Verification**

17. Run `pricing-tester` agent (verify checkout money/stock logic is pristine after Step 4).
    Also re-run after Step 14 (dispatcher now calls writeback — ensure no import side effects).

18. Run `npm run type-check && npm run build` — must be green after all steps.

19. Sandbox dry-run (§13.3): checkout → dispatch → verify SalesInvoiceHdr/Dtl, InventoryFlowDtl,
    TheJournal in sandbox KRS. Verify `sp_Onhand` stock delta. Verify double-entry balance.

20. Idempotency test (§13.4) + concurrent dispatch test (§13.5) + fail-open test (§13.6).

21. Report results to `process/features/krs-sync/reports/krs-outbound-p2-verify_REPORT_<date>.md`.

---

## 15. Blast Radius and Risk Assessment

| Risk | Severity | Affected | Mitigation |
|------|---------|---------|------------|
| `src/app/api/orders/route.ts` change | HIGH | Checkout (highest-risk file per CLAUDE.md) | (1) Minimal touch — ONE `tx.syncJob.create` call; zero change to money/stock logic. (2) pricing-tester runs immediately after. (3) The SyncJob insert is inside `$transaction` — if it fails, the whole checkout rolls back (a retried idempotency key collapses to the same order). |
| `idempotencyKey` null assert inside `$transaction` | MED | Checkout | If `orderNumber` is somehow empty (should not happen — `nextOrderNumber` asserts this), the checkout would roll back. This is correct: an order with no idempotency key is worse. The `nextOrderNumber` function already throws on empty day/seq. |
| Feature flag bypassed | MED | KRS sandbox | `KRS_OUTBOUND_ENABLED` is checked at dispatch, NOT at enqueue — this is intentional (the SyncJob is created regardless, so jobs accumulate and drain once enabled). The flag bypasses the KRS write only. |
| Sandbox connection exposed to prod | HIGH | KRS production data | `sandboxClient.ts` reads `KRS_SANDBOX_*` vars which are explicitly NOT the `KrsConnectionSettings` DB row. The two code paths are completely separate. A mistaken `KRS_SANDBOX_HOST` pointing at prod is a config mistake, not a code mistake — documented in the dry-run runbook. |
| RunningNumber race | MED | KRS document numbers | The atomic `UPDATE … WITH (UPDLOCK, SERIALIZABLE)` pattern (§9.3) eliminates the `MAX()+1` race. If the vendor's actual pattern is different, §10 item 3 resolves this before implementation. |
| `TODO_FROM_VENDOR` placeholders shipped to prod | HIGH | KRS data integrity | A TODO grep check blocks deployment until all placeholders are filled. `KRS_OUTBOUND_ENABLED=false` is the runtime gate. |
| mssql driver password leak via logger | HIGH | Credentials | Follows P0 spec §2.5 R5: `writeback.ts` and `dispatcher.ts` never pass raw driver error/config to logger. All errors are sanitized through `safeErrorParts()` from `client.ts`. |
| sp_Onhand not counting the stock-out | HIGH | KRS stock accuracy | `Approved=1, IsClosed=0` are CONFIG constants asserted in the sandbox dry-run via the `sp_Onhand` reconcile (§13.3 step 6). Any misconfiguration is caught in sandbox before prod is ever touched. |

---

## 16. Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| P0 spec approved | DONE | `krs-sync-spec_P0_22-06-26.md` — all architectural invariants drawn from here |
| P1 (connection layer) shipped | CHECK | `KrsConnectionSettings`, `KrsFieldMapping`, `buildConnectionConfig()`, `client.ts`, `crypto.ts`, `autoSync.ts`, schema migration — all appear present in codebase. Confirm P1 is complete before beginning P2. |
| `mssql` package installed | DONE (P1) | `import sql from "mssql"` already used in `client.ts`, `autoSync.ts`, etc. |
| `SyncJobType.SALE` enum value | DONE | Already in `prisma/schema.prisma` |
| `SyncDirection.INSERT` enum value | DONE | Already in `prisma/schema.prisma` |
| `getSellerConfig()` for branchCode/branchName | DONE | `src/lib/sellerConfig.ts` exists and exported |
| `safeErrorParts()` helper | DONE | Exported from `client.ts` — `writeback.ts` reuses it |
| Sandbox KRS DB + credentials | OPEN (§10 item 1) | Track B cannot begin without this |
| Vendor INSERT constants | OPEN (§10 items 2–9) | Track B cannot begin without confirmed values |
| Sample bill from sandbox | OPEN (§10 item 10) | Strongly recommended before Track B code |

---

## 17. Resume and Execution Handoff

**Selected plan file:** `process/features/krs-sync/active/krs-outbound-writeback_PLAN_25-06-26.md`

**Execution entrypoint:** Start at Step 1 (schema extension). Steps 1–11 are Track A —
buildable and shippable without KRS vendor prerequisites. Steps 12–16 are Track B — gated
on §10 prerequisites.

**Context files for EXECUTE agent:**
- This plan file (full)
- `process/features/krs-sync/references/krs-writeback-field-analysis_24-06-26.md` (field map)
- `process/features/krs-sync/references/krs-sync-spec_P0_22-06-26.md` (invariants)
- `prisma/schema.prisma` (current SyncJob model)
- `src/app/api/orders/route.ts` (checkout — highest-risk file, minimal touch)
- `src/lib/krs/client.ts` (patterns to mirror)
- `src/lib/krs/autoSync.ts` (dispatcher/sidecar pattern to mirror)
- `src/lib/sellerConfig.ts` (branchCode/branchName source)

**Phase gate for Track B:** EXECUTE must PAUSE at Step 12 and confirm with the user that all
§10 prerequisites (items 1–12) have been received. Do NOT proceed to Steps 12–16 if any
`TODO_FROM_VENDOR` value that would appear in production-path code is still unresolved.

**Verification sequence at handoff:**
1. `npm run type-check` — zero errors
2. `npm run build` — zero errors
3. `pricing-tester` agent — green (after Step 4/17)
4. Sandbox dry-run (§13.3) — all 5 tables written, sp_Onhand confirms stock-out
5. Report filed at `process/features/krs-sync/reports/`

**Update process after P2 EXECUTE:**
- Update `process/context/all-context.md` to reflect KRS outbound is no longer simulated
- Archive this plan to `process/features/krs-sync/completed/` when dry-run passes
- Update `krs-sync-program_PLAN_22-06-26.md` to mark P2 complete

---

## 18. Open Questions (for owner/vendor — not blocking Track A)

These are the §10 prerequisites restated as questions, plus one architectural decision:

1. (§10 item 11) For card/QR/transfer checkouts: should a `SALE` SyncJob be enqueued at
   checkout (with a different `SaleType` for card), or should non-cash checkouts be excluded
   from the outbox until a separate payment-method phase? **P2 default: enqueue ALL completed
   checkouts as SALE SyncJobs but gate the KRS write on cash-only until confirmed.**
2. (§10 item 12) Refund/void reversal ownership — KRS self-reverses or POS sends
   `STOCK_REVERSAL`? (§12 covers both paths)
3. `syncMode` gating: in `daily` mode, should the dispatch cron only run between certain
   hours? In `manual` mode, should the dispatch endpoint be disabled (503) or just the auto-
   cron? (P0 spec §11 Q9 — still open from P0)
4. Is the `TheJournal.Department` field the same `"SAL"` as confirmed, or does the invoice
   side (`SalesInvoiceHdr.Department`) use a different value from `CONFIG.DEPARTMENT`?

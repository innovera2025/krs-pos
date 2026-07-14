# Database Context

This file is the canonical database context entrypoint for krs-pos.

Use it after `process/context/all-context.md` when the task needs schema changes, Prisma model
work, migrations, seeding, or money/Decimal handling.

Last updated: 2026-07-14 (promotions program shipped — `Promotion` model + `PromotionType` enum,
`Order.promoBillDiscount`/`billPromotionId`/`billPromotionName`, `OrderItem.promotionId`/
`promotionName`/`promoDiscount`, migration `20260714080426_add_promotions`). **Known drift:** this
file's model/enum/migration inventory was last fully reconciled at krs-writeback-idempotency
(2026-06-27); several programs shipped since then (branch/warehouse, auth/audit, financial
correctness + tax invoice, KRS connection/field-mapping settings, held bills) added models,
enums, and ~17 migrations that are **not yet itemized below** — see the counts and the flag at the
end of the Models/Enums/Tracked Migrations sections. Recommend a full `vc-generate-context` re-sync
of this file.

---

## Scope

This group covers:

- the Prisma schema (`prisma/schema.prisma`): 21 models + 11 enums, 24 tracked migrations (actual
  current counts, promotions program; only the models/enums/migrations documented at each program's
  own closeout are itemized in the tables below — see the Known Drift flag above)
- model relationships and key constraints (unique fields, cascade deletes)
- migration workflow (`prisma migrate` — tracked migrations only; `db push` is dev-convenience only)
- seeding (`prisma/seed.ts` via tsx)
- the Prisma client singleton (`src/lib/prisma.ts`) and how routes consume it
- how money is represented and the integer-satang convention in app code

It does not cover:

- API route logic that uses the DB → see `src/app/api/*/route.ts` and `all-context.md`
- container/Postgres provisioning → `process/context/container/all-container.md`
- test database setup → `process/context/tests/all-tests.md`

## Read When

Read this entrypoint when:

- adding or modifying Prisma models, relations, or enums
- creating/applying a migration or pushing schema changes
- changing seed data
- debugging a query, a stock-decrement, or a money/Decimal rounding issue

## Schema Overview

Provider: **PostgreSQL** (`datasource db`, `url = env("DATABASE_URL")`). Generator: `prisma-client-js`.

**Models (`prisma/schema.prisma`) — 21 models total; only models documented as of each program's own
closeout are itemized here (see Known Drift above for the 8 not yet itemized: `Warehouse`,
`WarehouseStock`, `HeldBill`, `AuditLog`, `DailyOrderCounter`, `TaxInvoiceCounter`,
`KrsConnectionSettings`, `KrsFieldMapping`):**

| Model | Key fields & constraints | Relations |
|---|---|---|
| `User` | `email` unique, `name`, `role` (enum, default `CASHIER`), `password` (**plaintext** — TODO hash), `isActive Boolean @default(true)` (P4), `branchId String @default("BR-01")` (P4) | `orders Order[]`, `shifts Shift[]` (P5) |
| `Category` | `name` unique | `products Product[]` |
| `Product` | `sku` unique, `barcode` unique?, `price Decimal(10,2)`, `stock Int @default(0)`, `isActive @default(true)`, `imageUrl?`, `branchId @default("BR-01")` (P4) | `category Category?`, `orderItems OrderItem[]`, `movements StockMovement[]` (P4) |
| `Order` | `orderNumber` unique, `status` (enum, default `COMPLETED`), `subtotal`/`total` `Decimal(10,2)`, `tax`/`discount`/`amountPaid`/`change` `Decimal(10,2) @default(0)`, `paymentType` (enum, default `CASH`), `branchId @default("BR-01")` (P4), `shiftId?` (P5), `syncStatus SyncStatus @default(PENDING)` (P5), `accountingDocNo String?` (P5), `taxRequested Boolean @default(false)` (P5), `customerId?` (P6a); `promoBillDiscount Decimal(10,2) @default(0)`, `billPromotionId?`, `billPromotionName?` (promotions program — `promoBillDiscount` is the promo SLICE of `discount`; `discount` **keeps its prior meaning** = combined bill-level discount (manual + promo), so `subtotal − discount === total` is unchanged) | `cashier User?`, `items OrderItem[]`, `payments PaymentLine[]` (P3), `shift Shift?` (P5), `customer Customer?` (P6a) |
| `OrderItem` | `quantity Int`, `unitPrice/lineTotal Decimal(10,2)`; `promotionId?`, `promotionName?`, `promoDiscount Decimal(10,2) @default(0)` (promotions program — snapshot, no FK; already folded into `lineTotal` = `unitPrice×quantity − manualLineDiscount − promoDiscount`); `@@index([promotionId])` | `order Order` (**onDelete: Cascade**), `product Product` |
| `PaymentLine` | `method PaymentType`, `amount Decimal(10,2)`, `reference String?` (P3) | `order Order` (**onDelete: Cascade**) |
| `StockMovement` | `type StockMovementType`, `qty Int`, `reference String?`, `branchId @default("BR-01")` (P4) | `product Product` (**onDelete: Cascade**) |
| `Shift` | `shiftNumber` unique, `status ShiftStatus @default(OPEN)`, `openedAt/closedAt?`, `openingFloat Decimal(10,2) @default(0)`, `countedCash Decimal(10,2)?`, `cashierId?`, `branchId @default("BR-01")` (P5) | `cashier User?`, `orders Order[]` |
| `Customer` | `name`, `taxId? @unique`, `phone?`, `address?`, `branchId @default("BR-01")` (P6a) | `orders Order[]` |
| `SyncJob` | `type SyncJobType`, `direction SyncDirection @default(INSERT)`, `ref String`, `amount Decimal(12,2) @default(0)`, `status SyncJobStatus @default(PENDING)`, `provider String @default("KRS")`, `error?`, `response?`, `branchId @default("BR-01")` (P6a); `krsClaimedTxnNo String?` (krs-writeback-idempotency — burned-anchor: SaleInvoiceTrNo claimed in a separate committed phase-0 tx; non-null means a prior attempt burned this number; never cleared on failure, reused on NOT FOUND retry) | — |
| `KrsStockSnapshot` | `itemCode String @id`, `lastQty Decimal(12,4)`, `lockedAt DateTime?`, `updatedAt @updatedAt` — KRS on-hand snapshot for the inbound auto-pull delta engine. The row with `itemCode = "__LOCK__"` is the run-lock sentinel (prevents concurrent sync runs). | — |
| `ShopSettings` | Singleton row (`id = "singleton"`). Receipt layout: `receiptWidthMm Int @default(80)`, `receiptHeightAuto Boolean @default(true)`, `receiptHeightMm Int?`. Seller identity (DB-primary, ENV fallback via `getSellerConfig()`): `sellerName String?`, `sellerTaxId String?`, `sellerAddress String?`, `sellerPhone String?`, `sellerPosId String?`, `sellerBranchCode String?`, `sellerBranchLabel String?`. The 7 seller fields replaced the former `SELLER_*`-env-only design (migration `20260624120424_seller_settings`); `getSellerConfig()` is now async, reads DB first, falls back to `SELLER_*` env vars per field. Editable by admin via `/settings` Seller Info card. | — |
| `Promotion` (promotions program) | `name` (Thai display, shown on POS + receipt), `code String? @unique` (optional coupon ref), `type PromotionType`, `isActive Boolean @default(true)` (**soft delete only** — the app DB role has no DELETE, same stance as `HeldBill`), `startsAt/endsAt DateTime?` (UTC instants; half-open `startsAt <= now < endsAt`; admin UI converts Bangkok calendar days ↔ UTC via `src/lib/datetime.ts`; filtering is done at the fetch boundary — the engine itself is clock-free), `branchId @default("BR-01")`; per-type value fields (all validated at the API boundary, NULL unless `type` uses them): `percentOff Decimal(5,2)?`, `amountOffSatang Int?`, `fixedPriceSatang Int?`, `buyQty/getQty Int?`, `getDiscountPercent Int?`, `minSubtotalSatang Int?`; `productIds String[] @default([])` (scalar array, NOT a join table — the DB role has no DELETE, which would make editing a join set impractical; validated to exist at write time); `@@index([isActive, startsAt, endsAt])` | — |

All models have `createdAt @default(now())`; all except `OrderItem`, `PaymentLine`, `StockMovement`,
and `KrsStockSnapshot` also have `updatedAt @updatedAt` (KrsStockSnapshot has `updatedAt` but no
`createdAt` — it is a keyed snapshot store, not an audit log). IDs are `cuid()` strings for most models;
`KrsStockSnapshot` uses `itemCode String @id` as a natural key.

**Enums — 11 enums total; only enums documented as of each program's own closeout are itemized here
(`AuditAction`, added by the auth program, is not yet itemized — see Known Drift above):**

| Enum | Values |
|---|---|
| `Role` | `ADMIN`, `MANAGER`, `CASHIER` |
| `OrderStatus` | `PENDING`, `COMPLETED`, `REFUNDED`, `VOIDED` (P5), `CANCELLED` |
| `PaymentType` | `CASH`, `CARD`, `QR`, `TRANSFER`, `EWALLET` (P3), `OTHER` (P3) |
| `SyncStatus` | `PENDING`, `DAILY`, `SYNCED`, `FAILED`, `SKIPPED` (P5) |
| `ShiftStatus` | `OPEN`, `CLOSED` (P5) |
| `StockMovementType` | `RECEIVE`, `SALE`, `ADJUST` (P4), `KRS_SYNC` (krs-inbound-auto-pull — auto-pull delta audit) |
| `SyncJobType` | `SALE`, `REFUND`, `STOCK`, `PULL`, `TAX_INVOICE`, `STOCK_ADJ`, `RECEIVE` (P6a) |
| `SyncDirection` | `INSERT`, `PULL` (P6a) |
| `SyncJobStatus` | `PENDING`, `SYNCED`, `FAILED`, `RETRYING`, `SKIPPED` (P6a), `NEEDS_RECONCILE` (krs-writeback-idempotency — Prisma enum only; NOT in `src/types/index.ts` local union; not auto-claimable; routes to operator review when existence check persistently fails on a reclaimed job) |
| `PromotionType` (promotions program) | `PRODUCT_DISCOUNT`, `FIXED_PRICE`, `BUY_X_GET_Y`, `BILL_THRESHOLD` — ordered 1-4 as the engine/UI reference them: line %/฿ discount, special fixed price, buy-X-get-Y (same product, v1), whole-bill spend threshold |

## Tracked Migrations

The repo uses **`prisma migrate`** (tracked migration history) — NOT `db push` for production.
`db push` is available as `npm run db:push` for dev/scratch use only.

24 migrations exist under `prisma/migrations/`; only the ones documented at each program's own
closeout are itemized in the table below (17 migrations — auth/lockout/audit, financial
correctness, checkout idempotency, tax invoice, shop settings, perf indexes, KRS connection/
field-mapping settings, sync job outbox, warehouse master/user-warehouse/warehouse-stock ×3,
held bill ×2 — are tracked in the repo but not yet itemized here; see Known Drift above):

| Migration folder | Phase | Contents |
|---|---|---|
| `20260620114227_init_with_payments` | P1–P3 | Initial schema: User, Category, Product, Order, OrderItem, PaymentLine; enums Role/OrderStatus/PaymentType (+EWALLET/OTHER) |
| `20260620124520_phase4_catalog_stock_users` | P4 | `User.isActive`, `branchId` on User/Product/Order; `StockMovement` model + `StockMovementType` enum |
| `20260620134846_phase5_shift_sales_status` | P5 | `VOIDED` on OrderStatus; `Shift` model + `ShiftStatus` enum; `SyncStatus` enum; `Order.shiftId`/`syncStatus`/`accountingDocNo`/`taxRequested`; `User.shifts` back-relation |
| `20260620144152_phase6a_customer_syncjob` | P6a | `Customer` model; `SyncJob` model; enums SyncJobType/SyncDirection/SyncJobStatus; `Order.customerId` |
| `20260623105939_krs_auto_sync_snapshot` | krs-inbound-auto-pull | `KrsStockSnapshot` model (`itemCode @id`, `lastQty Decimal(12,4)`, `lockedAt`, `updatedAt`); `KRS_SYNC` value added to `StockMovementType` enum |
| `20260624120424_seller_settings` | seller-company-settings | 7 nullable `TEXT` columns added to `ShopSettings` (`sellerName`, `sellerTaxId`, `sellerAddress`, `sellerPhone`, `sellerPosId`, `sellerBranchCode`, `sellerBranchLabel`); additive only — no drops, no alters to existing columns |
| `20260627000000_add_syncjob_krs_claimed_txn_v2` | krs-writeback-idempotency | `ADD COLUMN "krsClaimedTxnNo" TEXT` on `SyncJob`; `ALTER TYPE "SyncJobStatus" ADD VALUE 'NEEDS_RECONCILE'`; additive only — no backfill, no constraint changes |
| `20260714080426_add_promotions` | promotions | `PromotionType` enum; `AuditAction` gains `PROMOTION_CREATED`/`PROMOTION_UPDATED`/`PROMOTION_ACTIVATED`/`PROMOTION_DEACTIVATED`; new `Promotion` model + `Promotion_isActive_startsAt_endsAt_idx`; `Order` gains `promoBillDiscount`/`billPromotionId`/`billPromotionName`; `OrderItem` gains `promotionId`/`promotionName`/`promoDiscount` + `OrderItem_promotionId_idx`; additive only — no drops, no backfill |

Apply to a fresh DB with `prisma migrate deploy` (CI/production) or `prisma migrate dev` (dev).

## Quick Routing

No deeper database docs yet. As the schema grows, add docs to this group and route to them here, e.g.:

- (future) `schema-guide.md` — model conventions, relationship patterns, enum rules
- (future) `migration-procedures.md` — step-by-step migrate/rollback/deploy workflow

## Workflow & Commands

```bash
npm run prisma:generate   # regenerate the typed client after ANY schema edit
npm run db:push           # dev convenience only — pushes schema without migration history
npm run prisma:migrate    # prisma migrate dev — create + apply a tracked migration
npm run prisma:seed       # run prisma/seed.ts (tsx) — sample data (categories, products, users, shift, orders, customers, sync jobs)
```

- **Always prefer `prisma migrate dev` over `db push`** when adding a tracked schema change. Use
  `db push` only for quick local iteration on a scratch DB.
- **Client singleton:** in app/route code import `{ prisma }` from `src/lib/prisma.ts`; never call
  `new PrismaClient()` there (avoids exhausting connections in dev hot-reload). **Exception:** the
  standalone `prisma/seed.ts` deliberately creates its own `new PrismaClient()` and `$disconnect()`s
  at the end — it is a one-shot script outside the Next.js runtime, so don't "fix" it to use the singleton.
- **Transactions:** the checkout flow (`src/app/api/orders/route.ts`) uses `prisma.$transaction`
  to create the order + decrement each product's `stock` atomically.

## Money & Data Gotchas

- **Integer satang (P2+).** Cart math and checkout totals are computed in **integer satang**
  (1 baht = 100 satang) in `src/lib/pricing.ts` to avoid IEEE-754 float drift. Convert baht→satang once
  at the boundary (`bahtToSatang(price)`), do all arithmetic as integers, then format back via
  `formatSatang(satang)` from `src/lib/money.ts`. Never use JS float for money totals.
- **Decimal columns at the DB boundary.** Prices/totals are `Decimal(10,2)` in Prisma schema.
  When serializing API responses, convert `Decimal` to `String` (`.toString()`) — never coerce
  Prisma `Decimal` to `Number` in API responses or it loses precision at large values.
- **Aggregate queries must scope to COMPLETED status.** Z-report and any sales aggregate
  (`sum(total)`, `sum(tax)`) must filter `status: "COMPLETED"` to exclude REFUNDED and VOIDED
  orders. A past bug hit this: the shift Z-report's `groupBy` on payment methods was summing all
  statuses until fixed. Always apply `where: { status: "COMPLETED" }` in aggregates.
- **Stock can go negative.** The checkout decrements `stock` with no "sufficient stock" guard and
  no quantity validation. Adding an atomic guard (`updateMany where stock gte qty`) is a planned
  production-readiness task.
- **Plaintext passwords.** `User.password` is seeded in plaintext. Hash before any real auth work.
- **`orderNumber = ORD-${Date.now()}`** is generated in app code (not the DB) and can collide
  under same-millisecond concurrency. (POS orders use `POS-YYYYMMDD-####` sequential numbering
  via a per-day count query.)
- **`branchId` is present on User/Product/Order/StockMovement/Shift/Customer/SyncJob** as a
  multi-branch-ready placeholder — all default to `"BR-01"`. Single-branch deployments can ignore it.
  Full multi-branch enforcement is deferred to a future program.
- **KRS inbound sync is REAL (live on prod).** The auto-pull engine (`src/lib/krs/autoSync.ts`,
  `POST /api/krs/auto-sync`) calls vendor `sp_Onhand` to read live KRS on-hand quantities and
  applies a delta against `KrsStockSnapshot` to adjust `Product.stock` without overwriting POS
  sales. Triggered every 5 minutes by the `krs-cron` Docker sidecar in `docker-compose.prod.yml`.
  **OUTBOUND (POS → KRS write-back) remains deferred** — blocked on the vendor spec from the KRS
  team. The `/data` tab `SyncJob` state machine still produces canned responses for outbound jobs;
  do not treat outbound `SyncJob.status` changes as real accounting events.

## Update Triggers

Update this group when:

- the Prisma schema gains/loses models, relations, or enums
- the migration or seeding workflow changes
- money representation changes (e.g. moving to Decimal-safe end-to-end)
- this group grows enough to split into deeper docs (schema guide, migrations, seeding)

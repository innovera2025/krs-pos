# Database Context

This file is the canonical database context entrypoint for krs-pos.

Use it after `process/context/all-context.md` when the task needs schema changes, Prisma model
work, migrations, seeding, or money/Decimal handling.

Last updated: 2026-06-20 (synced to P6b state)

---

## Scope

This group covers:

- the Prisma schema (`prisma/schema.prisma`): 10 models + 10 enums (as of P6a)
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

**Models (`prisma/schema.prisma`) — 10 models as of Phase 6a:**

| Model | Key fields & constraints | Relations |
|---|---|---|
| `User` | `email` unique, `name`, `role` (enum, default `CASHIER`), `password` (**plaintext** — TODO hash), `isActive Boolean @default(true)` (P4), `branchId String @default("BR-01")` (P4) | `orders Order[]`, `shifts Shift[]` (P5) |
| `Category` | `name` unique | `products Product[]` |
| `Product` | `sku` unique, `barcode` unique?, `price Decimal(10,2)`, `stock Int @default(0)`, `isActive @default(true)`, `imageUrl?`, `branchId @default("BR-01")` (P4) | `category Category?`, `orderItems OrderItem[]`, `movements StockMovement[]` (P4) |
| `Order` | `orderNumber` unique, `status` (enum, default `COMPLETED`), `subtotal`/`total` `Decimal(10,2)`, `tax`/`discount`/`amountPaid`/`change` `Decimal(10,2) @default(0)`, `paymentType` (enum, default `CASH`), `branchId @default("BR-01")` (P4), `shiftId?` (P5), `syncStatus SyncStatus @default(PENDING)` (P5), `accountingDocNo String?` (P5), `taxRequested Boolean @default(false)` (P5), `customerId?` (P6a) | `cashier User?`, `items OrderItem[]`, `payments PaymentLine[]` (P3), `shift Shift?` (P5), `customer Customer?` (P6a) |
| `OrderItem` | `quantity Int`, `unitPrice/lineTotal Decimal(10,2)` | `order Order` (**onDelete: Cascade**), `product Product` |
| `PaymentLine` | `method PaymentType`, `amount Decimal(10,2)`, `reference String?` (P3) | `order Order` (**onDelete: Cascade**) |
| `StockMovement` | `type StockMovementType`, `qty Int`, `reference String?`, `branchId @default("BR-01")` (P4) | `product Product` (**onDelete: Cascade**) |
| `Shift` | `shiftNumber` unique, `status ShiftStatus @default(OPEN)`, `openedAt/closedAt?`, `openingFloat Decimal(10,2) @default(0)`, `countedCash Decimal(10,2)?`, `cashierId?`, `branchId @default("BR-01")` (P5) | `cashier User?`, `orders Order[]` |
| `Customer` | `name`, `taxId? @unique`, `phone?`, `address?`, `branchId @default("BR-01")` (P6a) | `orders Order[]` |
| `SyncJob` | `type SyncJobType`, `direction SyncDirection @default(INSERT)`, `ref String`, `amount Decimal(12,2) @default(0)`, `status SyncJobStatus @default(PENDING)`, `provider String @default("KRS")`, `error?`, `response?`, `branchId @default("BR-01")` (P6a) | — |

All models have `createdAt @default(now())`; all except `OrderItem`, `PaymentLine`, and `StockMovement`
also have `updatedAt @updatedAt`. IDs are `cuid()` strings.

**Enums — 10 enums as of Phase 6a:**

| Enum | Values |
|---|---|
| `Role` | `ADMIN`, `MANAGER`, `CASHIER` |
| `OrderStatus` | `PENDING`, `COMPLETED`, `REFUNDED`, `VOIDED` (P5), `CANCELLED` |
| `PaymentType` | `CASH`, `CARD`, `QR`, `TRANSFER`, `EWALLET` (P3), `OTHER` (P3) |
| `SyncStatus` | `PENDING`, `DAILY`, `SYNCED`, `FAILED`, `SKIPPED` (P5) |
| `ShiftStatus` | `OPEN`, `CLOSED` (P5) |
| `StockMovementType` | `RECEIVE`, `SALE`, `ADJUST` (P4) |
| `SyncJobType` | `SALE`, `REFUND`, `STOCK`, `PULL`, `TAX_INVOICE`, `STOCK_ADJ`, `RECEIVE` (P6a) |
| `SyncDirection` | `INSERT`, `PULL` (P6a) |
| `SyncJobStatus` | `PENDING`, `SYNCED`, `FAILED`, `RETRYING`, `SKIPPED` (P6a) |

## Tracked Migrations

The repo uses **`prisma migrate`** (tracked migration history) — NOT `db push` for production.
`db push` is available as `npm run db:push` for dev/scratch use only.

Four migrations exist under `prisma/migrations/`:

| Migration folder | Phase | Contents |
|---|---|---|
| `20260620114227_init_with_payments` | P1–P3 | Initial schema: User, Category, Product, Order, OrderItem, PaymentLine; enums Role/OrderStatus/PaymentType (+EWALLET/OTHER) |
| `20260620124520_phase4_catalog_stock_users` | P4 | `User.isActive`, `branchId` on User/Product/Order; `StockMovement` model + `StockMovementType` enum |
| `20260620134846_phase5_shift_sales_status` | P5 | `VOIDED` on OrderStatus; `Shift` model + `ShiftStatus` enum; `SyncStatus` enum; `Order.shiftId`/`syncStatus`/`accountingDocNo`/`taxRequested`; `User.shifts` back-relation |
| `20260620144152_phase6a_customer_syncjob` | P6a | `Customer` model; `SyncJob` model; enums SyncJobType/SyncDirection/SyncJobStatus; `Order.customerId` |

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
- **KRS sync is SIMULATED.** `/data` tab and `SyncJob` state machine mutate status with canned
  responses; there is no real KRS transport. Real integration = production-readiness program.

## Update Triggers

Update this group when:

- the Prisma schema gains/loses models, relations, or enums
- the migration or seeding workflow changes
- money representation changes (e.g. moving to Decimal-safe end-to-end)
- this group grows enough to split into deeper docs (schema guide, migrations, seeding)

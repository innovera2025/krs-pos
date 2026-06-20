# Database Context

This file is the canonical database context entrypoint for krs-pos.

Use it after `process/context/all-context.md` when the task needs schema changes, Prisma model
work, migrations, seeding, or money/Decimal handling.

---

## Scope

This group covers:

- the Prisma schema (`prisma/schema.prisma`): 5 models + 3 enums
- model relationships and key constraints (unique fields, cascade deletes)
- migration and schema-push workflow (`prisma migrate` vs `db push`)
- seeding (`prisma/seed.ts` via tsx)
- the Prisma client singleton (`src/lib/prisma.ts`) and how routes consume it
- how money is represented (`Decimal(10,2)`) and the float-arithmetic risk around it

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

**Models (`prisma/schema.prisma`):**

| Model | Key fields & constraints | Relations |
|---|---|---|
| `User` | `email` unique, `name`, `role` (enum, default `CASHIER`), `password` (**plaintext** — TODO hash) | `orders Order[]` |
| `Category` | `name` unique | `products Product[]` |
| `Product` | `sku` unique, `barcode` unique?, `price Decimal(10,2)`, `stock Int @default(0)`, `isActive @default(true)`, `imageUrl?` | `category Category?`, `orderItems OrderItem[]` |
| `Order` | `orderNumber` unique, `status` (enum, default `COMPLETED`), `subtotal`/`total` **required** `Decimal(10,2)`, `tax`/`discount`/`amountPaid`/`change` `Decimal(10,2) @default(0)`, `paymentType` (enum, default `CASH`) | `cashier User?`, `items OrderItem[]` |
| `OrderItem` | `quantity Int`, `unitPrice/lineTotal Decimal(10,2)` | `order Order` (**onDelete: Cascade**), `product Product` |

**Enums:** `Role { ADMIN, MANAGER, CASHIER }`, `OrderStatus { PENDING, COMPLETED, REFUNDED, CANCELLED }`,
`PaymentType { CASH, CARD, QR, TRANSFER }`.

Every model has `createdAt @default(now())`; all except `OrderItem` also have `updatedAt @updatedAt`.
IDs are `cuid()` strings.

## Quick Routing

No deeper database docs yet. As the schema grows, add docs to this group and route to them here, e.g.:

- (future) `schema-guide.md` — model conventions, relationship patterns, enum rules
- (future) `migration-procedures.md` — step-by-step migrate/rollback/deploy workflow

## Workflow & Commands

```bash
npm run prisma:generate   # regenerate the typed client after ANY schema edit
npm run db:push           # push schema to DB without migration history (dev convenience)
npm run prisma:migrate    # prisma migrate dev — create + apply a tracked migration
npm run prisma:seed       # run prisma/seed.ts (tsx) — sample categories + products + admin user
```

- **Client singleton:** in app/route code import `{ prisma }` from `src/lib/prisma.ts`; never call
  `new PrismaClient()` there (avoids exhausting connections in dev hot-reload). **Exception:** the
  standalone `prisma/seed.ts` deliberately creates its own `new PrismaClient()` and `$disconnect()`s
  at the end — it is a one-shot script outside the Next.js runtime, so don't "fix" it to use the singleton.
- **Transactions:** the checkout flow (`src/app/api/orders/route.ts`) uses `prisma.$transaction`
  to create the order + decrement each product's `stock` atomically.

## Money & Data Gotchas

- **Decimal columns, float math.** Prices/totals are `Decimal(10,2)` in the DB, but the orders
  route and the client compute with JS `Number(...)`. This loses Decimal precision — be careful
  when changing pricing/tax/discount logic; prefer Decimal-safe arithmetic.
- **Stock can go negative.** The checkout decrements `stock` with no "sufficient stock" guard and
  no quantity validation — and despite a misleading `// Fetch products and validate stock` comment
  in the orders route, no validation is actually performed. Adding a guard is a likely near-term task.
- **Plaintext passwords.** `User.password` is seeded in plaintext. Hash before any real auth work.
- **`orderNumber = ORD-${Date.now()}`** is generated in app code (not the DB) and can collide
  under same-millisecond concurrency.

## Update Triggers

Update this group when:

- the Prisma schema gains/loses models, relations, or enums
- the migration or seeding workflow changes
- money representation changes (e.g. moving to integer minor units / Decimal-safe math)
- this group grows enough to split into deeper docs (schema guide, migrations, seeding)

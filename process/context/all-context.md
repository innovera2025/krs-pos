# krs-pos — All Context

> This file (`process/context/all-context.md`) is the authoritative context router for
> both Claude and Codex. Read it first, then open the grouped/source docs it points to.
> Regenerate or refresh with the `vc-generate-context` skill.

- Last updated: 2026-06-20
- Repo HEAD: (no commits yet — unborn `main`)
- Mode: Fresh scan (vc-setup, Flow A)
- Package manager: npm (`package-lock.json` committed as of Phase 0)

Start here before loading deeper context files. Use it for two things:

1. quick routing to the right context pack or root file
2. broad architecture and repository understanding

---

## How This File Works (the `all-*.md` Convention)

Every `process/context/` directory has one `all-*.md` entrypoint that acts as an attachable
quick router for that domain. This root file (`all-context.md`) is the top-level router.
Context groups each have their own `all-{group}.md` entrypoint.

```
process/context/
  all-context.md          <-- THIS FILE: root router
  planning/all-planning.md
  tests/all-tests.md
  database/all-database.md
  container/all-container.md
```

How agents use it: read this file → find the relevant group in the routing tables below →
read that group's `all-{group}.md` → only then load the specific deep doc. This layered
routing keeps context windows small. Never load the whole `process/context/` tree.

---

## 1. Product context

**KRS POS** is a Thai-first, single-store **point-of-sale (POS)** web app — a cashier opens
the screen, searches/browses products, adds them to a cart, adjusts quantities, and checks out.
On a successful sale the order is recorded and product stock is decremented atomically.

- **Audience:** counter cashiers in a Thai retail / small-business setting. UI copy is in Thai.
  (Assumption from the code/README — correct here if the target differs.)
- **Current scope:** one store, cash checkout. The sale flow and the products/orders APIs are
  implemented; everything in the roadmap below is not built yet.
- **Roadmap (from README, not yet implemented):** login / authentication, admin product & stock
  management, sales reports, receipt printing, multi-payment (cash / card / QR / transfer).

PRD/spec docs: none yet. `README.md` is the closest thing to a product brief.

## 2. Quick Start

For most substantial tasks:

1. read this file first
2. choose the smallest relevant root file or context group from the tables below
3. only then load deeper files

## 3. Current Root Entry Points

| File | Read when |
|---|---|
| `process/context/all-context.md` | any substantial planning, research, review, or implementation task |
| `process/context/tests/all-tests.md` | testing, verification, debugging — **note: no test runner exists yet** |
| `process/context/planning/all-planning.md` | creating a new plan; SIMPLE vs COMPLEX calibration |
| `process/context/database/all-database.md` | schema changes, Prisma models, migrations, seeding, money/Decimal handling |
| `process/context/container/all-container.md` | Docker, docker-compose, local Postgres, production image, ports |

## 4. Current Context Groups

| Group | Entry point | Scope |
|---|---|---|
| `planning/` | `process/context/planning/all-planning.md` | plan-shape calibration, SIMPLE vs COMPLEX, PRD examples |
| `tests/` | `process/context/tests/all-tests.md` | verification strategy and commands (no automated tests yet — known gap) |
| `database/` | `process/context/database/all-database.md` | Prisma schema, the 5 models + enums, migrations, seeding, client singleton, money handling |
| `container/` | `process/context/container/all-container.md` | Dockerfile, docker-compose services (db + app), ports, build/run commands |

## 5. Task Routing Table

| If the task involves... | Load first | Then load |
|---|---|---|
| architecture / stack questions | this file | — |
| schema, models, migrations, seeding | `all-context.md`, `database/all-database.md` | `prisma/schema.prisma` |
| the sale / checkout flow or API routes | `all-context.md` | `src/app/api/orders/route.ts`, `src/app/page.tsx` |
| Docker / local DB / deployment image | `all-context.md`, `container/all-container.md` | `docker-compose.yml`, `Dockerfile` |
| UI/frontend or POS redesign work | `all-context.md` | `design/Simple POS.dc.html`, `design/KRS POS Taste Redesign.html`, then `src/app/page.tsx` |
| testing or verification | `all-context.md`, `tests/all-tests.md` | — |
| creating a new plan | `all-context.md`, `planning/all-planning.md` | `process/development-protocols/references/example-simple-prd.md` |
| context maintenance | `all-context.md` | run the `vc-audit-context` skill after edits |

## 6. Repository Structure

```
krs-pos/
  prisma/
    schema.prisma          -- DB schema: User, Category, Product, Order, OrderItem (+ enums)
    seed.ts                -- sample categories + products + admin user (run via tsx)
  src/
    app/
      api/
        products/route.ts  -- GET list active products / POST create product
        orders/route.ts    -- GET recent orders / POST checkout (transaction + stock decrement)
      layout.tsx           -- root layout
      page.tsx             -- main POS screen (client component: search, cart, checkout)
      globals.css          -- Tailwind entry
    lib/
      prisma.ts            -- PrismaClient singleton
    types/
      index.ts             -- Product, CartItem, Category TS types
  Dockerfile               -- multi-stage Next.js production image
  docker-compose.yml       -- postgres:16-alpine (db) + app
  next.config.mjs
  tailwind.config.ts
  tsconfig.json            -- path alias @/* -> ./src/*
  package.json
  design/
    Simple POS.dc.html             -- original complete POS design/function inventory
    KRS POS Taste Redesign.html    -- approved Joi/Taste redesign visual direction
    _ds/                           -- pguard-derived design-system reference only; not KRS POS truth
  .env.example             -- DATABASE_URL only
  process/                 -- agent harness context + plans (this dir)
```

## 7. Technology Stack

- **Framework:** Next.js **14.2.5** (App Router) — server route handlers (`route.ts`) + a client POS page
- **Language:** TypeScript **5.5** (strict), `allowJs`, `moduleResolution: bundler`
- **Runtime:** Node **20** (`.nvmrc`)
- **UI:** React **18.3** + Tailwind CSS **3.4** (no component library; hand-written JSX). For UI work,
  inspect the `design/` source files first: preserve functions from `Simple POS.dc.html` and apply the
  approved `KRS POS Taste Redesign.html` visual language.
- **Database:** PostgreSQL **16** (alpine in Docker) via **Prisma 5.18** ORM (`@prisma/client` + `prisma`)
- **State:** local React state only (`useState`/`useEffect`/`useMemo`) — no Redux/Zustand/etc.
- **API style:** REST-ish Next.js route handlers returning `NextResponse.json(...)`
- **Auth:** none (no auth library; see gotchas)
- **Package manager:** npm (`package-lock.json` committed in Phase 0, so `npm ci` / Docker build works)
- **Seeding/scripts:** `tsx` runs `prisma/seed.ts`
- **Monorepo:** no — single app

## 8. Key Patterns and Conventions

- **Import alias:** `@/*` → `./src/*` (e.g. `@/lib/prisma`, `@/types`).
- **Prisma client:** in app/route code import `{ prisma }` from `src/lib/prisma.ts`; never call `new PrismaClient()` there. (The standalone `prisma/seed.ts` script is an intentional exception — it makes its own client and `$disconnect()`s at the end.)
- **API routes:** App Router handlers in `src/app/api/<name>/route.ts`. Export `GET`/`POST` functions;
  return `NextResponse.json(data, { status })`. Validation errors return `{ error }` with an HTTP status.
- **Checkout is transactional:** `src/app/api/orders/route.ts` wraps order creation + per-item
  `product.update({ stock: { decrement } })` in a single `prisma.$transaction`.
- **Order numbers:** `ORD-${Date.now()}` (millisecond timestamp).
- **Money in the schema:** `Decimal @db.Decimal(10, 2)` for prices/totals; `BigInt`/satang is **not** used here.
- **Naming:** `route.ts` for handlers, PascalCase React components, camelCase functions/vars,
  shared TS types in `src/types/index.ts`.
- **Thai-first copy** throughout the UI.

### Gotchas / be careful (current debt)

These are real and worth flagging before touching the relevant code:

- **No authentication/authorization.** Every API route is open — `POST /api/products` and
  `POST /api/orders` accept anonymous requests; `cashierId` is optional and unauthenticated.
- **Plaintext passwords.** `User.password` is stored as plaintext in `prisma/seed.ts` (the seeded
  admin's credentials are no longer printed in docs as of Phase 0 — set/rotate them locally). Hash
  (e.g. bcrypt) before any real use.
- **Money math runs in JS floats.** Prices are coerced via `Number(product.price)` and all
  subsequent `subtotal`/`tax`/`total`/`change` math runs in JS floating point, not `Decimal` —
  rounding risk on real prices. The client also uses `Number(price).toFixed(2)`.
- **No input/stock guards in checkout.** Quantities are trusted from the client; there is no
  check that stock is sufficient, so `stock` can go **negative**. `taxRate`, `discount`,
  `amountPaid`, and `paymentType` are also trusted from the request body (`tax`/`total`/`change`
  are derived server-side; `paymentType` is cast with `as never`).
- **No top-level error handling** in either POST route — `POST /api/orders` (a thrown "Product not
  found") and `POST /api/products` (a Prisma P2002 on duplicate `sku`/`barcode`) both surface as
  unhandled 500s.
- **`ORD-${Date.now()}` collision risk** under concurrent checkouts within the same millisecond.
- **No tests at all** (see `tests/all-tests.md`).

## 9. Environment and Configuration

**Config files:** `next.config.mjs`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.mjs`,
`.nvmrc` (Node 20), `.env.example`, `Dockerfile`, `docker-compose.yml`.

**Env var groups (names only, never values):**
- Database (app): `DATABASE_URL` (PostgreSQL connection string the app/Prisma uses)
- Database (compose `db` service, added in Phase 0): `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB` — consumed by `docker-compose.yml` to provision the Postgres container. Use a
  non-`postgres` app user (suggest `krs_app`). Values live in a git-ignored `.env`; `.env.example`
  documents the names with placeholders only.
- Runtime: `NODE_ENV` (set to `production` by `docker-compose.yml` for the app service)

## 10. Context Group Lifecycle

Context groups are durable knowledge domains, not feature folders. Create a group when a topic
has 3+ durable docs, a single doc exceeds ~800 lines with separable subtopics, or multiple agents
repeatedly need only one slice of a large file. Do **not** create a group for temporary reports,
plans/execution artifacts, or feature-specific content (that belongs in `process/features/...`).
Move/split one group at a time, use `all-{group}.md` entrypoints, and run the `vc-audit-context`
skill after every context organization change.

## 11. Naming Convention

No `README.md` files inside `process/context/`. Canonical entrypoints use `all-*.md`:
root is `process/context/all-context.md`; each group is `process/context/{group}/all-{group}.md`.
Each `all-{group}.md` is the attachable quick router for that domain.

## 12. Context Update Protocol

When durable project knowledge changes: (1) update the smallest relevant context file,
(2) update this file if routing, ownership, naming, or groups changed, (3) update the owning
`all-{group}.md` entrypoint, (4) run the `vc-audit-context` skill.

## Scan Metadata

- Generated: 2026-06-20
- HEAD: (no commits yet — unborn `main`)
- Mode: fresh (vc-setup Flow A)
- Package manager: npm
- Source files scanned: `prisma/schema.prisma`, `prisma/seed.ts`, `src/app/page.tsx`,
  `src/app/api/{products,orders}/route.ts`, `src/lib/prisma.ts`, `src/types/index.ts`,
  `package.json`, `tsconfig.json`, `docker-compose.yml`, `Dockerfile`, `.env.example`, `README.md`

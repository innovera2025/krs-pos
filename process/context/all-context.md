# krs-pos — All Context

> This file (`process/context/all-context.md`) is the authoritative context router for
> both Claude and Codex. Read it first, then open the grouped/source docs it points to.
> Regenerate or refresh with the `vc-generate-context` skill.

- Last updated: 2026-06-27 (krs-writeback-idempotency shipped — 7 migrations; SyncJob.krsClaimedTxnNo; SyncJobStatus.NEEDS_RECONCILE Prisma enum; module remains dormant)
- Repo HEAD: main (committed through seller-company-settings; commits 27153c1 feat + c7ab7f9 docs)
- Mode: Context sync (context-maintainer)
- Package manager: npm (`package-lock.json` committed)

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

**KRS POS** is a Thai-first, single-store **point-of-sale (POS)** web app built for counter
cashiers in a Thai retail/small-business setting. UI copy is bilingual Thai-first.

The redesign program (Phases 1–6) rebuilds the original subtotal-only checkout into a full
Taste-redesigned POS system: checkout + payment (P1–3), products/stock/users + RBAC (P4),
sales history + shift Z-report + refund/void (P5), customer picker + tax invoice + KRS sync
UI + design spec docs (P6a–6c). Phases 6c (Design Spec docs) and P7 (cross-cutting hardening)
are the remaining work.

**KRS inbound sync is REAL (live on prod)** — `POST /api/krs/auto-sync` runs a delta engine
against `sp_Onhand` every 5 minutes via the `krs-cron` Docker sidecar. **KRS outbound (POS→KRS
write-back) remains deferred** — blocked on the vendor spec from the KRS team. The `/data` KRS
Data Link UI and `SyncJob` state machine still produce canned responses for outbound jobs only.

**RBAC is a CLIENT DEMO STUB** — `RoleProvider`/`NavRail`/`AdminOnly` enforce role gating
in the browser only; the server does not check session role. Real auth/RBAC enforcement is
deferred to the production-readiness program.

- **Current scope:** all 7 screens are implemented (see §3); `/docs` is a placeholder awaiting P6c.
- **Roadmap (remaining):** P6c Design Spec docs hub (12 fn, static); P7 cross-cutting hardening
  (real auth, Decimal-safe money end-to-end, atomic stock guard, idempotency, audit trail, etc.).

PRD/spec docs: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (165-function matrix).
Security gap audit: `process/general-plans/references/pos-security-gap-audit_20-06-26.md`.

## 2. Quick Start

For most substantial tasks:

1. read this file first
2. choose the smallest relevant root file or context group from the tables below
3. only then load deeper files

## 3. Current Root Entry Points

| File | Read when |
|---|---|
| `process/context/all-context.md` | any substantial planning, research, review, or implementation task |
| `process/context/tests/all-tests.md` | testing, verification, debugging — **note: no automated test runner exists yet** |
| `process/context/planning/all-planning.md` | creating a new plan; SIMPLE vs COMPLEX calibration |
| `process/context/database/all-database.md` | schema changes, Prisma models, migrations, seeding, money/satang handling |
| `process/context/container/all-container.md` | Docker, docker-compose, local Postgres, production image, ports |

## 4. Current Context Groups

| Group | Entry point | Scope |
|---|---|---|
| `planning/` | `process/context/planning/all-planning.md` | plan-shape calibration, SIMPLE vs COMPLEX, PRD examples |
| `tests/` | `process/context/tests/all-tests.md` | verification strategy, commands, ephemeral-Postgres smoke pattern (no automated tests yet — known gap) |
| `database/` | `process/context/database/all-database.md` | Prisma schema, 12 models + 11 enums, 7 tracked migrations, seeding, client singleton, integer-satang money, status-scoped aggregates |
| `container/` | `process/context/container/all-container.md` | Dockerfile, docker-compose services (db + app), ports, build/run commands |

## 5. Task Routing Table

| If the task involves... | Load first | Then load |
|---|---|---|
| architecture / stack questions | this file | — |
| schema, models, migrations, seeding | `all-context.md`, `database/all-database.md` | `prisma/schema.prisma` |
| the checkout / order flow or API routes | `all-context.md` | `src/app/api/orders/route.ts` |
| shift Z-report or sales aggregates | `all-context.md`, `database/all-database.md` | `src/app/api/shift/route.ts` |
| money math / pricing | `all-context.md` | `src/lib/pricing.ts`, `src/lib/money.ts` |
| Docker / local DB / deployment image | `all-context.md`, `container/all-container.md` | `docker-compose.yml`, `Dockerfile` |
| UI/frontend or POS redesign work | `all-context.md` | `design/Simple POS.dc.html`, `design/KRS POS Taste Redesign.html`, then relevant `src/app/(shell)/*/page.tsx` |
| RBAC / role gates | `all-context.md` | `src/lib/roleAccess.ts`, `src/components/RoleProvider.tsx`, `src/components/AdminOnly.tsx` |
| KRS sync / SyncJob state | `all-context.md`, `database/all-database.md` | `src/app/api/sync-jobs/route.ts`, `src/app/(shell)/data/page.tsx` |
| KRS inbound auto-pull / auto-sync | `all-context.md`, `database/all-database.md`, `container/all-container.md` | `src/lib/krs/autoSync.ts`, `src/app/api/krs/auto-sync/route.ts` — `POST /api/krs/auto-sync` uses bearer machine-auth (NOT session); see `KrsStockSnapshot` model |
| customer / tax invoice | `all-context.md`, `database/all-database.md` | `src/app/api/customers/route.ts`, `src/app/api/orders/route.ts` |
| seller config / shop settings / receipt header | `all-context.md`, `database/all-database.md` | `src/lib/sellerConfig.ts` (async DB-first + ENV fallback), `src/app/api/settings/route.ts`, `src/app/(shell)/settings/page.tsx` |
| testing or verification | `all-context.md`, `tests/all-tests.md` | — |
| creating a new plan | `all-context.md`, `planning/all-planning.md` | `process/development-protocols/references/example-simple-prd.md` |
| context maintenance | `all-context.md` | run the `vc-audit-context` skill after edits |

## 6. Repository Structure

```
krs-pos/
  prisma/
    schema.prisma          -- DB schema: 12 models + 11 enums (see §8 and database/all-database.md)
    seed.ts                -- sample data: categories, products, admin user, shift, orders, customers, sync jobs
    migrations/            -- 7 tracked migrations (init_with_payments, phase4, phase5, phase6a, krs_auto_sync_snapshot, seller_settings, add_syncjob_krs_claimed_txn_v2)
  src/
    app/
      api/
        products/          -- GET list active products / POST create product
          [id]/            -- PATCH update product
        orders/            -- GET recent orders / POST checkout (transaction + stock decrement)
          [id]/            -- PATCH refund/void/request-tax
        shift/             -- GET current shift + Z-report / POST open or close shift
        stock-movements/   -- POST receive-stock (GRN)
        users/             -- GET users / POST create user
          [id]/            -- PATCH update/activate/deactivate user
        customers/         -- GET customer list (search)
        sync-jobs/         -- GET job list / POST insert-all-pending/pull
          [id]/            -- PATCH retry/skip a job
          failed-count/    -- GET count of FAILED jobs (drives NavRail badge)
        krs/
          auto-sync/       -- POST /api/krs/auto-sync — machine-auth bearer; runs delta engine
        settings/          -- GET shop settings (requireUser) / PATCH update settings (requireAdmin); includes receipt layout + 7 seller identity fields (sellerName, sellerTaxId, sellerAddress, sellerPhone, sellerPosId, sellerBranchCode, sellerBranchLabel)
        seller-config/     -- GET resolved seller config (DB-first + SELLER_* env fallback); async getSellerConfig() — returns null if mandatory §86/4 particulars (name/taxId/address) absent
      (shell)/             -- route group with shared NavRail layout
        layout.tsx         -- NavRail shell layout
        pos/               -- /pos — Taste checkout + payment modal + receipt
        products/          -- /products — Products & Inventory (admin)
        users/             -- /users — Users & Roles (admin)
        sales/             -- /sales — Sales History with detail drawer + refund/void
        shift/             -- /shift — Shift open/close + Z-report
        data/              -- /data — KRS Data Link (4 tabs: Connection/Mapping/Data Flow/Live Data)
        docs/              -- /docs — Design Spec docs (placeholder; P6c next)
        settings/          -- /settings — Shop Settings (admin-only); receipt layout + Seller Info card (7 seller fields; editable without server restart)
      login/               -- /login — UI stub (no real auth yet)
      layout.tsx           -- root layout
      page.tsx             -- root → redirects to /pos
      globals.css          -- Tailwind entry
    components/
      Modal.tsx            -- reusable modal with focus-trap + Esc close
      ToastProvider.tsx    -- global toast context + live region
      NavRail.tsx          -- 76px forest-gradient left rail; role-filtered nav items + data badge
      RoleProvider.tsx     -- client RBAC stub: sets AppRole from localStorage (demo only)
      AdminOnly.tsx        -- renders children only when RoleProvider role === "admin"
      pos/                 -- POS checkout components
      sales/               -- Sales History components (SaleDetailDrawer, etc.)
      shift/               -- Shift screen components
      data/                -- KRS Data Link tab components (Connection/Mapping/DataFlow/LiveData/SyncDetailDrawer)
      products/            -- Products & Inventory components
      users/               -- Users & Roles components
    lib/
      prisma.ts            -- PrismaClient singleton (import { prisma } in all app/route code)
      pricing.ts           -- integer-satang cart math (computeTotals, bahtToSatang, sumPaySatang, remainingPaySatang)
      money.ts             -- formatting: money(n) → "฿X.XX", formatSatang(satang) → "฿X.XX"
      datetime.ts          -- Asia/Bangkok helpers: bangkokDateParts, bangkokYyyymmdd, bangkokDayWindow
      roleAccess.ts        -- NAV_ACCESS map + canAccess() — CLIENT DEMO ONLY, not a server auth boundary
      krs/
        autoSync.ts        -- inbound delta engine: fetchKrsOnhand → diff vs KrsStockSnapshot → adjust Product.stock; run-lock via __LOCK__ sentinel row
    types/
      index.ts             -- shared TS types
  Dockerfile               -- multi-stage Next.js production image (node:20-alpine)
  docker-compose.yml       -- postgres:16-alpine (db) + app; credentials from env, port 5432 not published
  docker-compose.prod.yml  -- production overlay: adds krs-cron sidecar (curlimages/curl, 5-min auto-sync poll)
  next.config.mjs
  tailwind.config.ts
  tsconfig.json            -- path alias @/* -> ./src/*
  package.json
  design/
    Simple POS.dc.html             -- complete function/screen/state/flow inventory (SOURCE OF TRUTH)
    KRS POS Taste Redesign.html    -- approved Joi/Taste redesign visual direction
    _ds/                           -- pguard-derived design-system reference only; not KRS POS truth
  .env.example             -- DATABASE_URL + Postgres compose vars (placeholders only)
  process/                 -- agent harness context + plans (this dir)
    general-plans/
      active/              -- active plans (pos-redesign_PLAN_20-06-26.md = the 165-fn program plan)
      reports/             -- phase execution reports (P1–P6b) + per-phase research docs
      references/          -- pos-redesign-timeline_20-06-26.html, pos-security-gap-audit_20-06-26.md
```

## 7. Technology Stack

- **Framework:** Next.js **14.2.5** (App Router) — server route handlers (`route.ts`) + client pages/components
- **Language:** TypeScript **5.5** (strict), `allowJs`, `moduleResolution: bundler`
- **Runtime:** Node **20** (`.nvmrc`)
- **UI:** React **18.3** + Tailwind CSS **3.4** + `lucide-react` icons. No component library;
  hand-written JSX. For UI work, inspect the `design/` source files first:
  preserve functions from `Simple POS.dc.html` and apply the approved `KRS POS Taste Redesign.html`
  visual language (forest-green/mint palette, IBM Plex Sans Thai, compact NavRail, etc.).
- **Database:** PostgreSQL **16** (alpine in Docker) via **Prisma 5.18** ORM
- **State:** local React state only (`useState`/`useEffect`/`useMemo`) — no Redux/Zustand/etc.
- **API style:** REST-ish Next.js route handlers returning `NextResponse.json(...)`
- **Auth:** none — `/login` is a UI stub; all API routes are currently open
- **Package manager:** npm (`package-lock.json` committed)
- **Seeding/scripts:** `tsx` runs `prisma/seed.ts`
- **Monorepo:** no — single app

## 8. Key Patterns and Conventions

- **Import alias:** `@/*` → `./src/*` (e.g. `@/lib/prisma`, `@/lib/pricing`, `@/types`).
- **Prisma client:** in app/route code import `{ prisma }` from `src/lib/prisma.ts`; never call
  `new PrismaClient()` there. (`prisma/seed.ts` is an intentional exception — it makes its own client
  and `$disconnect()`s at the end; it is a one-shot script outside the Next.js runtime.)
- **API routes:** App Router handlers in `src/app/api/<name>/route.ts`. Export `GET`/`POST`/`PATCH`
  functions; return `NextResponse.json(data, { status })`. Typed error responses return `{ error, code }`
  with an appropriate HTTP status (400/404/409/422).
- **Checkout is transactional:** `src/app/api/orders/route.ts` wraps order creation + per-item
  `product.update({ stock: { decrement } })` + PaymentLine creation in a single `prisma.$transaction`.
- **Order numbers:** `POS-YYYYMMDD-####` (sequential per Bangkok calendar day, counted from DB).
- **Money math:** cart and API totals use **integer satang** (1 baht = 100 satang) via
  `src/lib/pricing.ts` — convert baht→satang once at the boundary, do all math as integers,
  format back via `formatSatang()`. **Never use JS float for money totals.**
- **Decimal→String at API boundaries:** when serializing Prisma `Decimal` fields in API responses,
  call `.toString()` — never coerce to `Number`.
- **Aggregate queries must filter `status: "COMPLETED"`** to exclude REFUNDED/VOIDED orders from
  totals, VAT sums, and payment-method breakdowns. Omitting this filter is a real bug class.
- **Asia/Bangkok dates:** use helpers from `src/lib/datetime.ts` (`bangkokDateParts`,
  `bangkokYyyymmdd`, `bangkokDayWindow`) for any daily sequence, shift window, or date comparison.
  Never use `new Date()` directly for Thai-calendar logic.
- **Schema workflow:** use `prisma migrate dev` to create + apply tracked migrations; commit the
  generated `prisma/migrations/` folder. `db push` is dev-convenience only (no history).
- **No destructive deletes:** voided orders are set to `VOIDED`/total 0/`SKIPPED` — never deleted.
  Users are deactivated (`isActive: false`) — never deleted. Shifts are closed — never deleted.
- **Naming:** `route.ts` for handlers, PascalCase React components, camelCase functions/vars,
  shared TS types in `src/types/index.ts`.
- **Thai-first copy** throughout the UI.

### Gotchas / be careful (current debt)

These are real and worth flagging before touching the relevant code:

- **No authentication/authorization server-side.** Every API route is open — `POST /api/orders`,
  `POST /api/users`, etc. accept anonymous requests. The RBAC in `RoleProvider`/`AdminOnly`/`NavRail`
  is a **client demo stub only** — it does not protect server routes. Real enforcement is deferred
  to the production-readiness program. Do not add UI role gates and call it "secure".
- **Plaintext passwords.** `User.password` is stored as plaintext in `prisma/seed.ts`. Hash (bcrypt)
  before any real auth work.
- **Stock can go negative.** `product.stock` decrements in checkout with no sufficiency guard. Adding
  an atomic `updateMany where stock gte qty` guard is a planned production-readiness task.
- **`POST /api/orders` is the most sensitive file.** It handles money, stock, and payment lines.
  Run the `pricing-tester` agent after touching `src/app/api/orders/route.ts`.
- **KRS inbound sync is REAL (live on prod).** `POST /api/krs/auto-sync` (bearer machine-auth)
  calls `sp_Onhand`, computes a delta against `KrsStockSnapshot`, and adjusts `Product.stock`.
  Triggered every 5 min by the `krs-cron` sidecar in `docker-compose.prod.yml`. **KRS outbound
  (POS → KRS write-back) is still deferred** — the `/data` tab `SyncJob` state machine still
  produces canned responses for outbound jobs only. Do not treat outbound `SyncJob.status` as real.
- **`orderNumber = ORD-${Date.now()}`** collision risk under concurrent checkouts within the same
  millisecond (the new POS number scheme `POS-YYYYMMDD-####` is used for POS sales; the `ORD-`
  format remains as a fallback path — see orders route).
- **No top-level error handling** in some routes — uncaught Prisma errors (P2002 duplicate
  sku/barcode, P2025 record not found) surface as unhandled 500s in some paths.
- **No tests at all** (see `tests/all-tests.md`).

## 9. Environment and Configuration

**Config files:** `next.config.mjs`, `tsconfig.json`, `tailwind.config.ts`, `postcss.config.mjs`,
`.nvmrc` (Node 20), `.env.example`, `Dockerfile`, `docker-compose.yml`.

**Env var groups (names only, never values):**
- Database (app): `DATABASE_URL` (PostgreSQL connection string the app/Prisma uses)
- Database (compose `db` service): `POSTGRES_USER`, `POSTGRES_PASSWORD`,
  `POSTGRES_DB` — consumed by `docker-compose.yml` to provision the Postgres container.
  Use a non-`postgres` app user (suggest `krs_app`). Values live in a git-ignored `.env`;
  `.env.example` documents the names with placeholders only.
- Runtime: `NODE_ENV` (set to `production` by `docker-compose.yml` for the app service)
- Seller identity (app, **FALLBACK ONLY** as of 2026-06-24 — seller-company-settings feature):
  `SELLER_NAME`, `SELLER_TAX_ID`, `SELLER_ADDRESS`, `SELLER_BRANCH_CODE`, `SELLER_BRANCH_LABEL` —
  these env vars are now **per-field fallbacks** when the corresponding `ShopSettings` DB column is
  null/empty. DB values (editable by admin at `/settings`) take precedence. Existing deploys that
  use only env vars continue to work without any change. See `src/lib/sellerConfig.ts` for the
  DB-first + env fallback resolution chain. `getSellerConfig()` is async (DB query on every call).
- KRS auto-sync (app, forwarded in docker-compose.yml):
  - `KRS_SYNC_TRIGGER_SECRET` — bearer secret; validated by `POST /api/krs/auto-sync` (machine-auth)
  - `KRS_AUTO_SYNC_ENABLED` — opt-in kill switch (`true`/`false`, default `false`)
  - `KRS_AUTO_SYNC_WAREHOUSE` — warehouse filter passed to `sp_Onhand` (empty = all)
- KRS auto-sync (sidecar only, NOT in app `env.ts`):
  - `KRS_AUTO_SYNC_INTERVAL_SECONDS` — poll interval for the `krs-cron` sidecar (default 300)

## 10. Current Program State

**POS Redesign program** (165 functions across 7 screens — single-assignment matrix in the plan):

| Phase | Status | Description |
|---|---|---|
| P1 | ✅ committed | Shell/rail/theme/routing — NavRail, `/login` UI stub, favicon, Modal a11y |
| P2 | ✅ committed | `/pos` Taste checkout — integer-satang cart, VAT-inclusive totals, proportional discount |
| P3 | ✅ committed | Payment modal (6 methods, split, cash+change), 80mm receipt, hold bill; `PaymentLine` model + `EWALLET`/`OTHER`; 1st tracked migration |
| P4 | ✅ committed | Products & Inventory + Users & Roles; APIs users/products/stock-movements; RBAC client stub; `StockMovement` model + `isActive`/`branchId`; 2nd tracked migration |
| P5 | ✅ committed | Sales History + Shift Z-report + refund/void/reprint; APIs orders PATCH + shift GET/POST; `Shift`/`VOIDED`/`SyncStatus` + shift FK on Order; 3rd tracked migration |
| P6a | ✅ committed | Customer picker + tax invoice + `domain-tax-invoice-requires-tax-customer`; `Customer`/`SyncJob` models + 4th tracked migration |
| P6b | ✅ done (pending commit per plan) | KRS Data Link 4 tabs + sync-detail drawer + sync-jobs API + NavRail failed-badge + 8-job seed; **no new migration** (SyncJob from 6a) |
| P6c | ▶ next | Design Spec docs hub — `/docs` 10 panels (static, admin-only); 12 functions |
| P7 | ⏸ deferred | Cross-cutting hardening: real auth/RBAC, Decimal-safe money end-to-end, atomic stock guard, idempotency, audit trail → production-readiness program |

Active plan: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md`
Phase reports: `process/general-plans/reports/pos-redesign-phase-{1..6b}_REPORT_20-06-26.md`
Phase research: `process/general-plans/reports/pos-redesign-phase-{2..6b}_RESEARCH_20-06-26.md`

## 11. Context Group Lifecycle

Context groups are durable knowledge domains, not feature folders. Create a group when a topic
has 3+ durable docs, a single doc exceeds ~800 lines with separable subtopics, or multiple agents
repeatedly need only one slice of a large file. Do **not** create a group for temporary reports,
plans/execution artifacts, or feature-specific content (that belongs in `process/features/...`).
Move/split one group at a time, use `all-{group}.md` entrypoints, and run the `vc-audit-context`
skill after every context organization change.

## 12. Naming Convention

No `README.md` files inside `process/context/`. Canonical entrypoints use `all-*.md`:
root is `process/context/all-context.md`; each group is `process/context/{group}/all-{group}.md`.
Each `all-{group}.md` is the attachable quick router for that domain.

## 13. Context Update Protocol

When durable project knowledge changes: (1) update the smallest relevant context file,
(2) update this file if routing, ownership, naming, or groups changed, (3) update the owning
`all-{group}.md` entrypoint, (4) run the `vc-audit-context` skill.

## Scan Metadata

- Generated: 2026-06-20
- Last manual update: 2026-06-27 (krs-writeback-idempotency shipped; 7 migrations; SyncJob.krsClaimedTxnNo + SyncJobStatus.NEEDS_RECONCILE Prisma enum; outbound module remains dormant)
- Synced to: seller-company-settings on main (commits 27153c1, c7ab7f9; prior: 942efa8, c8f4afd, d48de83, 989d88c, 054f291, 6ae8346)
- Package manager: npm
- Source files scanned: `prisma/schema.prisma`, `prisma/migrations/`, `prisma/seed.ts`,
  `src/app/api/*/route.ts`, `src/app/(shell)/*/page.tsx`, `src/components/*.tsx`,
  `src/lib/{prisma,pricing,money,datetime,roleAccess}.ts`, `src/lib/krs/autoSync.ts`,
  `src/types/index.ts`, `package.json`, `tsconfig.json`, `docker-compose.yml`,
  `docker-compose.prod.yml`, `Dockerfile`, `.env.example`,
  `process/general-plans/active/pos-redesign_PLAN_20-06-26.md`

# Phase 7 Research — Integration hardening, responsive QA, regression, polish (FINAL phase)

- Date: 2026-06-21
- Cross-cutting hardening of the built redesign — **NO new product functions, NO schema, NO new API/seed**. P1–6 done (165/165). Build + type-check clean.
- **#1 job: a bounded punch-list + scope that prevents P7 ballooning.**

## ⚠️ Scope boundary (keep distinct)
- **P7 = redesign hardening/QA**: responsive reflow, a11y/contrast, route error boundaries, API-error UI states, regression, polish.
- **production-readiness = SEPARATE (not-built) program** (OUT of P7): real auth/session + server RBAC enforcement, Decimal end-to-end money, idempotency, atomic stock, audit trail, password hashing, real KRS transport, accountingDocNo issuance, Zod, ESLint config, CI/CD, DB backup. All flagged `// TODO(production-readiness)` in code. Do NOT fold in (except 2 trivial 1-liners below).

## 1. Current state
All 7 screens Taste-built + /login stub; build PASS, type-check PASS. Already-hardened (credit P1–P6 reviews): Modal focus-trap/Escape (split effects), SaleDetail/SyncDetail drawer traps + keyboard rows, Toast live-region, NavRail aria-current/labels/landmark, PaymentModal role=group/alert, `prefers-reduced-motion` global, 80mm print isolation, focus-visible ring, `lang="th"`, `--soft` darkened to `#6b7280`, role=alert on form errors. **No test runner** (manual ephemeral-postgres smoke is the gate; P6c used Playwright ad-hoc).

## 2. ★ Punch-list (bounded; P0 broken / P1 significant / P2 polish / P3 nice)
**A. Responsive** (the app is tablet/desktop-primary):
- **R1 (P1)** `NavRail.tsx:102` width 76px hard-coded, NO breakpoint/mobile collapse; shell `flex h-screen`. POS min width ~836px → clips < ~900px tablet + all phones. Taste spec (≤1120 rail→68 / ≤760 rail hidden+mobile nav) unimplemented.
- **R2 (P1)** `pos/page.tsx:652` cart panel fixed 408px `flex-shrink-0` → workspace collapses on narrow tablet.
- **R3 (P2)** `pos/page.tsx:587` category panel hard 168px, no responsive override.
- **R5 (P2)** `data/page.tsx:163` tab bar can overflow (no `overflow-x-auto`).
- R4/R6/R7 already OK (login `hidden lg:flex`, PaymentModal `max-w-[94vw]`, /docs pills `overflow-x-auto`).

**B. Accessibility**:
- **A1/POL6 (P1)** `/login` no `autoFocus`/initial focus on email.
- **A2 (P1)** duplicate `<main>` — `(shell)/layout.tsx:16` AND `pos/page.tsx:551`. Fix: layout keeps `<main>` landmark, pos page's inner `<main>` → `<div>`.
- **A4 (P2)** NavRail inactive icon `#82a89c` on forest `#0c3026` ≈2.1:1 (<3:1 non-text AA) → bump (e.g. `#a0bfb5`).
- **A5/A6/A7 (P2)** hardcoded muted text below 4.5:1 AA: `pos:703` `#98a2b3`; `shift/KpiCards.tsx:26,32` `#93c5b1`; **`#94a3b8` ~17 occurrences** (CustomerPickerModal, ReceiptModal, PaymentModal, data/AccountMappingSection, data/page) — replace text uses with `var(--soft)` (#6b7280 ≈4.6:1). Icon/border uses OK at 3:1.
- **A3/A9 (P2)** `/data` + `/docs` tabs are `<button aria-current>` (operable) not full ARIA tablist/tab/tabpanel + arrow-keys — optional upgrade if low-effort.

**C. Error handling**:
- **E1 (P1)** NO `error.tsx` anywhere → add `src/app/error.tsx` (root) + `src/app/(shell)/error.tsx`.
- **E2 (P2)** NO `not-found.tsx` → add Taste 404.
- **E4 (P2)** `/data` `fetchJobs` failure shows empty table, no error message → add fetch-error state.
- **E6 (P3)** `/api/customers` DYNAMIC_SERVER_USAGE build log is **benign** (route is correctly `ƒ`); optional `export const dynamic='force-dynamic'` 1-liner to silence.

**D. Regression/build**: REG1 type-check+build PASS. REG3 no tests (Playwright e2e = highest-value optional). REG5 NavRail+globals.css are cross-cutting → change first, smoke after each.

**E. Polish**: **POL5 (P2)** `tailwind.config.ts:16 soft:#98a2b3` vs `globals.css --soft:#6b7280` mismatch → sync config. POL1–4 already consistent (money(), badges, tri-state loading/empty/error except E4, TODO markers correctly = production-readiness).

## 3. Scope recommendation — single tight pass, sequenced (cross-cutting first)
1. **Group 1 (safety net first):** `src/app/error.tsx` + `(shell)/error.tsx` (E1) + `not-found.tsx` (E2) + optional `force-dynamic` on customers (E6).
2. **Group 2 (cross-cutting contrast/tokens — change + smoke):** A4 NavRail icon, A5/A6/A7 muted-text → `var(--soft)`, POL5 tailwind sync.
3. **Group 3 (a11y structural):** A2 duplicate `<main>`, A1 login autoFocus, optional A3/A9 tablist if low-effort.
4. **Group 4 (responsive ≤900px tablet):** R1 NavRail collapse, R2 cart collapsible/narrower, R3 category panel, R5 /data tab overflow.
5. **Group 5:** E4 /data fetch-error state.
6. **Verify:** type-check+build + responsive smoke @1280/1024/900/768 across 8 routes + a11y spot-check + full-route regression (+ Playwright if approved).

## 4. Decisions needing go-ahead
1. **Responsive depth:** (a) **tablet-only ≤900px** (cart collapsible, rail shrink) — recommended, bounded · (b) full mobile incl. ≤760px rail-hidden + hamburger/bottom-nav — much more cross-cutting work.
2. **error.tsx + not-found.tsx** — recommend **yes** (low-effort, high-value).
3. **ARIA tablist upgrade** (/data, /docs) — recommend **if low-effort**, else defer.
4. **Playwright e2e** (1–2 scripts: checkout happy-path + 8-route smoke) — recommend **yes** (biggest quality gap; new devDep `@playwright/test`; ≤3 files) — needs explicit go-ahead.
5. **Cheap prod-readiness folds:** only the 2 trivial 1-liners (force-dynamic on /api/customers; tailwind soft sync) — safe. All other prod-readiness stays OUT.

## 5. Risks
1. **Scope creep (biggest)** — bright line: no new functions/schema/API/seed; only hardening on existing UI. 2. **NavRail + globals.css cross-cutting** → change first, build+smoke after each. 3. **No test runner** safety net → if Playwright approved, land it first as the regression guard. 4. A2 `<main>` fix: layout keeps landmark, pos inner → div. 5. A7 touches ~17 files (text-only swaps safe).

## 6. Files likely to touch
HIGH (cross-cutting): `NavRail.tsx`, `globals.css`, `(shell)/layout.tsx`. Medium: `pos/page.tsx`. Low/new: `login/page.tsx`, **NEW** `app/error.tsx` + `(shell)/error.tsx` + `not-found.tsx`, `data/page.tsx`, `docs/page.tsx`, `CustomerPickerModal/ReceiptModal/PaymentModal/AccountMappingSection/KpiCards` (contrast), `tailwind.config.ts`, optional `api/customers/route.ts` (1-liner). **NOT touched:** schema, API logic, pricing/money/seed.
Verify: type-check + build + responsive smoke (1280/1024/900/768 × 8 routes) + a11y spot-check + regression + optional Playwright.

## 7. Readiness + recommendation
**Ready for EXECUTE — bounded, low-risk hardening; no blocking defects.** Recommend the single tight pass (Groups 1→5, cross-cutting first) at **tablet ≤900px** responsive depth, plus the 2 trivial prod-readiness 1-liners. Production-readiness (auth/Decimal/idempotency/atomic-stock/audit/real-KRS/ESLint/CI) stays a SEPARATE program. **Playwright e2e (1–2 scripts) recommended but needs go-ahead.** This closes the redesign program.

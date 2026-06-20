# POS Redesign — Phase 1 Report (Design-system foundation + app shell)

- Date: 2026-06-20
- Plan: `process/general-plans/active/pos-redesign_PLAN_20-06-26.md` (Phase 1)
- Status: 🔨 CODE DONE / build-verified (manual runtime checks pending — see below)
- Scope decision: **UI/shell only; `branchId` (`domain-multi-branch-ready`) DEFERRED** (no DB available; no schema/migration this pass)

## What was done (7 of 8 Phase-1 functions)

| fn id | delivered |
|---|---|
| `nav-sidebar` | `src/components/NavRail.tsx` — 76px forest-gradient rail, brand mark, 7 nav items, active-state, `data` badge-dot (stub 0), role stubbed to admin |
| `action-nav-go` | Next.js App Router `(shell)` route group; active via `usePathname()`, navigate via `useRouter().push()`; 7 routes + `/`→`/pos` redirect |
| `overlay-toast` + `state-toast-feedback` | `src/components/ToastProvider.tsx` — context + `useToast()`, dark pill, auto-dismiss 2200ms, mounted in root layout |
| `domain-currency-baht` | `src/lib/money.ts` — `money()` → `฿` + en-US 2-dp, mono tabular (`.mono` class) |
| `action-stop-propagation` | `src/components/Modal.tsx` — backdrop `onClose` + inner `stopPropagation` |
| `domain-nav-en-and-titles-mismatch` | rail short `labelEn` vs placeholder `viewTitle` (long) per the canonical copy table |

Supporting infra: `next/font/google` (IBM Plex Sans Thai + Mono via CSS vars) in `src/app/layout.tsx`; Taste `:root` tokens + `.mono` in `globals.css`; `tailwind.config.ts theme.extend` (forest/brand/mint/accent + fonts + radii + shadows); `lucide-react` installed (`^1.21.0`).

## Files
- **Created:** `src/components/{NavRail,ToastProvider,Modal}.tsx`, `src/lib/money.ts`, `src/app/(shell)/layout.tsx`, `src/app/(shell)/{pos,sales,shift,data,products,users,docs}/page.tsx`
- **Moved:** `src/app/page.tsx` → `src/app/(shell)/pos/page.tsx` (internals unchanged)
- **Edited:** `src/app/page.tsx` (now `redirect("/pos")`), `src/app/layout.tsx`, `src/app/globals.css`, `tailwind.config.ts`, `package.json`/`package-lock.json` (lucide-react only)

## Verification (independent, orchestrator)
- `npm run type-check` — **PASS** (clean)
- `npm run build` — **PASS** — 13 routes compiled: `/` (redirect, 158B), `/pos` (1.94kB), `/sales /shift /data /products /users /docs` (placeholders), `/api/orders` + `/api/products` (dynamic, unchanged)
- **Regression vs Phase 0 — PASS:** `GET /api/orders` still uses `cashier: { select: { id: true, name: true } }` (password-leak fix intact); no diff to `prisma/`, `src/app/api/**`, `src/lib/prisma.ts`

## Verified vs pending
- ✅ Compiles, type-safe, all routes build, no regressions, scope respected
- ⏳ Manual runtime (not exercised headlessly): rail click-routing, toast 2.2s auto-dismiss, `money()` render, modal backdrop-close. Run `npm run dev` (or `/smoke`) to confirm.

## Deviations / notes
- **No deviations** from the approved (UI-only) scope.
- **Expected visual mismatch:** the relocated POS page is NOT restyled — old blue/slate UI coexists with the new forest rail. This is intended; POS restyle is **Phase 2**.
- `font-sans` (Tailwind default key) now maps to `var(--font-sans)` so the body uses IBM Plex Sans Thai by default.

## Deferred (tracked, not dropped)
- `domain-multi-branch-ready` (add `branchId @default("BR-01")` to `Order`/`Product`): needs a live DB for `prisma migrate dev`. **Recommend folding into Phase 4** (catalog/stock, which already does schema work) or a dedicated migration step when Postgres is available. Until then, multi-branch groundwork is pending.

## Next
- Commit checkpoint (orchestrator/user) — Phase 1 changes are not yet committed.
- Then **Phase 2** (Checkout core redesigned) research pass against the same plan path. Phase 2 depends on Phase 1 (done).

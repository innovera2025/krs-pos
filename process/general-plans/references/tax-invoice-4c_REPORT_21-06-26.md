# Phase 4 REPORT — Tax invoice 4c (Customer CRUD)

- Date: 2026-06-21 · completes the usable tax-invoice feature (4a+4b + this) · `tax-invoice_RESEARCH_21-06-26.md` §4c.
- **No schema change / no migration** (the `Customer` model + `buyerBranchCode` already exist from 4a).
- Status: ✅ **type-check + build + e2e 14/14 + live smoke (CRUD + onboard→issue + clear-field) + 2-dim adversarial review (7 confirmed → 3 fixed, 4 deferred) — all verified.**

## What was built
- **`POST /api/customers`** (requireUser) + **`PATCH /api/customers/[id]`** (requireUser, partial) — create/edit B2B tax customers. Zod (`src/lib/schemas/customer.ts`, NODE-only): `name` required ≤200; `taxId` optional `/^\d{13}$/` (sparse-`@unique`; empty→null); `address` ≤300; `phone` ≤30; `buyerBranchCode` `/^\d{5}$/` default "00000". Explicit Prisma data (no body spread). Codes: `VALIDATION` 400, `TAXID_TAKEN` 409 (P2002), `NOT_FOUND` 404 (P2025). Shared `CUSTOMER_PUBLIC_SELECT`.
- **UI:** `CustomerFormModal` (add/edit, Taste language) wired into the checkout `CustomerPickerModal` (add button + per-row edit) — a cashier can onboard a tax customer mid-sale; refresh + auto-select after save. Followed the `Simple POS.dc.html` customer IA (ported the add-tax-customer function into the redesign per CLAUDE.md).

## Adversarial review (2-dim) — 7 confirmed → 3 FIXED, 4 deferred
**Fixed:**
1. **(HIGH/MED) Edit could not CLEAR optional fields** (taxId/address/phone/buyerBranchCode) — `submitCustomerForm` omitted empty keys from the PATCH body, so clearing a field in the edit form left the DB value unchanged (couldn't remove a taxId to fix a duplicate). Fixed: the PATCH branch now sends optional keys unconditionally (`""` → server normalizes to null; `buyerBranchCode` empty → `"00000"`).
2. **(HIGH) Escape closed BOTH stacked modals** (customer-form over picker) — each `Modal` had its own Escape listener. Fixed: a module-level modal stack in `src/components/Modal.tsx`; only the top-most open modal honors Escape (single-modal Escape preserved; cleanup on unmount).
3. **(LOW) `CUSTOMER_PUBLIC_SELECT` duplicated** in both route files → extracted to `src/lib/schemas/customer.ts` and imported by both (GET/POST/PATCH stay shape-identical).

**Deferred (LOW, not fixed):** review #3 — no length cap on the `[id]` path param (a codebase-wide convention across ALL `[id]` routes, auth-gated + parameterized → negligible); review #4 — `addressSchema.max(300)` runs pre-trim (harmless; a whitespace-only value still normalizes to null).

## Verification (orchestrator — ephemeral Postgres + live server)
- type-check + build + **e2e 14/14** (the shared `Modal.tsx` change did not break the checkout PaymentModal or any modal).
- **CRUD smoke:** POST valid (name+13-digit TIN+buyerBranchCode) → 201; POST invalid TIN (12 digits) → 400 `VALIDATION`; POST duplicate TIN → 409 `TAXID_TAKEN`; PATCH edit → 200.
- **End-to-end onboard→issue:** add a NEW tax customer → checkout with them → request-tax → minted `TAX-2026-000001` (the full counter-staff flow the feature enables).
- **Clear-field (FIX 1) live:** PATCH `{taxId:"", address:"", phone:"", buyerBranchCode:""}` → DB `taxId=NULL, address=NULL, buyerBranchCode="00000"`.
- All smoke containers/server torn down.

## Notes
- Escape-stacking (FIX 2) is browser-UI; verified by code (top-of-stack logic + unmount cleanup) + the e2e modal-regression pass. A real-device smoke of stacked Escape is worth a glance.
- `CustomerFormModal` (client) does not import the NODE-only schema (edge/client bundle clean).

## Tax-invoice feature status
**4a + 4b + 4c COMPLETE** — a VAT-registered shop can: add/edit a B2B tax customer (validated TIN), check out, request a full §86/4 tax invoice (locally-minted gapless `TAX-YYYY-NNNNNN`, issuance date in Buddhist Era, VAT broken out), and print/reprint the A4 document. **Owner must set the real `SELLER_*` env (TIN/name/address) before issuing real invoices.**

## Remaining (genuine enhancements / owner-decision-gated — NOT blocking)
- Abbreviated §86/6 invoice path (needs the owner's Director-General retail-designation decision).
- DB-backed Settings model + admin screen for seller identity (env works today).
- PDF/email delivery, unit-of-measure column, 5-year retention policy doc.
- Other Phase 4: backups/PITR + DR, PDPA + data retention, offline/PWA, a11y. Sentry (needs DSN). Carried deferred review items (Customer PII/PDPA scoping, shift-tx race, idempotency body-match, Zod on users routes).

# Phase 4 REPORT — Thai tax invoice (ใบกำกับภาษี) Sub-phases 4a + 4b

- Date: 2026-06-21 · Research: `tax-invoice_RESEARCH_21-06-26.md` · gap-audit Phase 4 (domain/compliance). Domain + compliance + UI.
- **Migration #9** `20260621140000_phase4_tax_invoice`.
- Status: ✅ **type-check + build + Vitest 42/42 + e2e 14/14 + live smoke (mint/idempotency/gates/seller-config) + 4-dim adversarial review (10 confirmed → 7 fixed, 2 deferred to 4c) — all verified on the final code.**

## Decisions (all = research recommendation)
- **Number source = LOCAL** — minted at request-tax time into the existing `Order.accountingDocNo` (printable immediately; no KRS-sync dependency).
- **Seller config = ENV** (`SELLER_TAX_ID`/`NAME`/`ADDRESS`/`BRANCH_CODE`/`BRANCH_LABEL`), OPTIONAL at boot + enforced at issue time (422 `SELLER_NOT_CONFIGURED`) — so a non-VAT deploy is not bricked. `.env.example` has **placeholders only** (the owner MUST set the real 13-digit TIN + address before issuing real invoices).
- **Full §86/4 only** (B2B customers with a TIN); added `Customer.buyerBranchCode` (default "00000"=HQ).
- **Separate A4 document** (`TaxInvoiceDocument`); the 80mm thermal `ReceiptModal` is unchanged.
- **Yearly counter** `TaxInvoiceCounter{year,seq}` → `TAX-YYYY-NNNNNN` (atomic gapless, mirrors `DailyOrderCounter`).

## What was built
- **Schema (migration #9):** `TaxInvoiceCounter{year @id, seq}`; `Customer.buyerBranchCode`; `Order.taxIssuedAt DateTime?` (§86/4(7) issuance date); `Order.accountingDocNo @unique` (duplicate-number DB backstop).
- **Numbering + issue:** in the request-tax `$transaction`, an atomic yearly `TaxInvoiceCounter` upsert (`INSERT…ON CONFLICT (year) DO UPDATE … RETURNING`, Bangkok-year from the Postgres tx clock) mints `TAX-YYYY-NNNNNN` → written to `accountingDocNo`; `taxIssuedAt` stamped from the same DB clock. SELLER config checked BEFORE minting (no seq consumed on misconfig).
- **Seller config:** `src/lib/env.ts` (5 optional `SELLER_*`, shape-validated: TIN 13 digits, branch 5 digits, length caps) + `src/lib/sellerConfig.ts` (`getSellerConfig()` → null when unset) + `GET /api/seller-config` (requireUser; bridges the NODE-only env to the client document).
- **A4 document** (`src/components/sales/TaxInvoiceDocument.tsx`): all §86/4 mandatory particulars — "ใบกำกับภาษี" heading, seller block (name/address/TIN/branch), buyer block (name/address/TIN/buyerBranchCode), line items (desc/qty/unit price/amount), a subtotal row + VAT broken out (pre-VAT base = total−tax, VAT 7%, total inclusive), the sequential number, the **Buddhist-Era** issue date (e.g. "21 มิ.ย. 2569"). Renders from STORED values; reprint never re-mints. Taste visual language; A4 `@page` print CSS isolated from the thermal path. Wired from `SaleDetailDrawer` (sales-history reprint) + the sales page.
- **Flow correctness:** request-tax idempotency — pre-tx fast-path + an **in-tx conditional `updateMany(where taxRequested:false)` count===1 guard** (closes the TOCTOU double-mint race) → 409 `ALREADY_REQUESTED`; walk-in → 422 `TAX_REQUIRES_TAX_CUSTOMER`; `SaleDetailDrawer canTax` adds `!taxRequested`. `ReceiptModal` fixes: customer address in the tax block + dynamic `syncStatus` badge.

## Verification (orchestrator — ephemeral Postgres + live server)
- type-check + build + **Vitest 42/42** + **e2e 14/14** (on the final post-fix code).
- **Mint:** request-tax → `TAX-2026-000001`, 2nd invoice → `000002` (gapless, counter atomic). `taxIssuedAt` stamped.
- **TOCTOU (FIX 2):** 2 **concurrent** request-tax on one order → one 200 + one 409, **counter incremented by exactly 1** (single mint, no duplicate number).
- **Idempotency:** repeat request-tax → 409 `ALREADY_REQUESTED`. **Walk-in:** 422 `TAX_REQUIRES_TAX_CUSTOMER`.
- **Seller config:** `/api/seller-config` returns the env block; with SELLER unset → request-tax 422 `SELLER_NOT_CONFIGURED` (no seq consumed) **and the app still boots** (optional env — non-VAT deploys not bricked).
- **DB:** `@unique` index on `accountingDocNo` + `taxIssuedAt` column present.

## Adversarial review (4 dims) — 10 confirmed → 7 FIXED, 2 deferred
**Fixed:** (HIGH) issue date was the SALE date → added `taxIssuedAt` stamped at issue + rendered; (HIGH) TOCTOU double-mint → in-tx conditional guard; (MED) Gregorian year → **Buddhist Era**; (MED) line table didn't reconcile with the summary under a bill discount → added a subtotal row; (LOW) `@unique` on accountingDocNo; (LOW) SELLER_NAME/ADDRESS/BRANCH_LABEL length caps; (print) A4 `@page` moved onto the printed element so it reliably governs (thermal path untouched).
**Deferred → 4c:** unit-of-measure column (not §86/4-required); buyer-TIN 13-digit format validation (belongs with customer CRUD).

## Deviations / notes
- New `GET /api/seller-config` + `SellerConfigDTO` (a `"use client"` A4 document cannot import the NODE-only env module; the endpoint is the minimal bridge). `buyerBranchCode` added to the customers select.
- The Buddhist-Era conversion is on the displayed date only; the `TAX-YYYY-` number prefix stays Gregorian (internal system id).
- Real-browser A4 print rendering is best confirmed on a printer/PDF; the CSS follows the Paged-Media spec but was not exercised in a real print here.

## User action (host dev)
Migration #9 will be applied to the dev DB (additive). To ISSUE tax invoices in dev, set the `SELLER_*` vars in `.env` (placeholders are in `.env.example`; use your REAL 13-digit TIN + registered name/address). Without them the app runs normally but request-tax returns 422 `SELLER_NOT_CONFIGURED`.

## Remaining (Phase 4c + roadmap)
- **4c:** customer CRUD (add/edit incl. buyerBranchCode + buyer-TIN format validation); a DB-backed Settings model + admin screen for seller identity (vs env); abbreviated §86/6 path (needs Director-General retail designation); the 5-year retention policy; PDF/email delivery + the unit-of-measure column.
- **Sentry** (needs DSN). **Phase 4 (rest):** backups/PITR + DR, PDPA + data retention, offline/PWA, a11y. Carried deferred review items (Customer PII/PDPA scoping, shift-tx race, idempotency body-match).

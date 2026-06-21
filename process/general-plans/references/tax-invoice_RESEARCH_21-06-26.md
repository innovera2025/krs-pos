# Thai Tax Invoice (ใบกำกับภาษี) — Research Report

## 1. Current-State Summary

### 1.1 Schema Fields That Exist (prisma/schema.prisma)

**Customer model (lines 18–30)**
- `taxId String? @unique` — stores buyer 13-digit TIN; present and used for the TAX_REQUIRES_TAX_CUSTOMER gate.
- `name`, `address`, `phone` — all nullable strings; `address` carries the schema comment "ที่อยู่ออกใบกำกับ" (line 17).
- `branchId String @default("BR-01")` — **this is the seller's branch identifier**, not a buyer-branch field. No RD-compliant 5-digit buyer branch code field exists.

**Order model (lines 187–238)**
- `taxRequested Boolean @default(false)` (line 230) — flags a tax invoice was requested.
- `accountingDocNo String?` (line 228) — nullable; intended to hold the issued doc number (e.g., `TAX-2026-000418`). Currently populated **only** by the seeded row and the canned sync-retry mock; no live code path ever writes it to an Order record.
- `customerId String?` (line 214) — nullable FK to Customer; null = walk-in.

**DailyOrderCounter model (lines 247–251)**
- `day String @id` (Bangkok `YYYYMMDD` from Postgres `now()`)
- `seq Int @default(0)`
- Atomic `INSERT … ON CONFLICT DO UPDATE SET seq = seq + 1 RETURNING day, seq` pattern lives in `src/app/api/orders/route.ts` lines 197–221 (`nextOrderNumber`), wrapped inside the checkout `$transaction` so a rolled-back checkout does not consume a sequence number.

**What does NOT exist in the schema:**
- No `TaxInvoice` or `TaxDocument` model.
- No `TaxInvoiceCounter`, `MonthlyTaxCounter`, or `YearlyTaxCounter` model.
- No `ShopSettings`, `BranchSettings`, or `SellerConfig` model.
- No seller TIN, seller registered address, or RD 5-digit branch code on any model.
- No buyer branch code field on `Customer`.

Confirmed by grep across all `src/` and `prisma/` — zero hits for any of those model or field names.

### 1.2 Seller Identity — Currently Hardcoded

`src/components/pos/ReceiptModal.tsx` lines 19–20:
```
const BRANCH = "สาขาสีลม · Silom (BR-01)";
const PHONE = "โทร 02-123-4567";
```
Shop name `"KRS"` is hardcoded in JSX line 106. No seller TIN, no registered address, no RD branch code appear anywhere in the codebase or any env var. `src/lib/env.ts` validates only `DATABASE_URL`, `AUTH_SECRET`, `NODE_ENV`, `AUTH_URL`, `AUTH_TRUST_HOST` — no `SELLER_*` vars exist (lines 24–54).

### 1.3 How `taxRequested` / `customerId` / `accountingDocNo` Flow Today

**At checkout (POST /api/orders)**  
`customerId` is accepted from the client body, confirmed via `prisma.customer.findUnique`. If `taxRequested === true` but the resolved customer has no `taxId`, the route returns 422 `TAX_REQUIRES_TAX_CUSTOMER` (route.ts lines 556–569). Both `customerId` and `taxRequested` are stored on the created `Order`. `accountingDocNo` is never set at checkout time.

**At request-tax PATCH (src/app/api/orders/[id]/route.ts lines 128–214)**  
Two gates: `status === COMPLETED` (line 149) and `customer.taxId` non-empty (lines 159–170). In a single `$transaction`: sets `taxRequested = true` and creates a PENDING `SyncJob` of type `TAX_INVOICE` (lines 176–191). `accountingDocNo` is **intentionally not set** — the comment at line 174 states it "returns async on a future KRS sync."

**No idempotency guard on request-tax**: Calling the PATCH twice on the same COMPLETED order with a tax customer creates a second `TAX_INVOICE` SyncJob. There is no `if (existing.taxRequested) return conflict` guard.

**accountingDocNo is never set by any live route**: The sync-jobs PATCH retry (`src/app/api/sync-jobs/[id]/route.ts` lines 107–118) writes a canned `{"doc_no":"TAX-2026-NNN"}` to `SyncJob.response` only, never updating `Order.accountingDocNo`. The seed at `prisma/seed.ts` line 179 sets `accountingDocNo: "TAX-2026-000418"` directly — this is the only non-null row.

### 1.4 VAT Computation (src/lib/pricing.ts)

VAT-inclusive extraction: `vatSatang = round(lineFinal * 7 / 107)` (line 189), applied per line after proportional bill-discount allocation. The result is:
- `Order.subtotal` = Σ lineTotal (price×qty − lineDiscount, before bill discount)
- `Order.tax` = Σ per-line extracted VAT (after bill discount allocation)
- `Order.total` = subtotal − billDiscount (inclusive of VAT; VAT is not added on top)

`ReceiptModal.tsx` lines 56–58: `preVatNum = totalNum - vatNum` — a derived display value, not stored. All values stored as `Decimal(10,2)` in Postgres. The VAT math is **legally correct** for VAT-inclusive retail pricing.

---

## 2. Thai Legal Requirements for Tax Invoice

### 2.1 Full Tax Invoice — ใบกำกับภาษีแบบเต็มรูป (Revenue Code §86/4)

The seven mandatory particulars (all required; omitting any is a violation):

1. **The word "ใบกำกับภาษี"** displayed prominently on the document.
2. **Seller identity**: name, registered address, 13-digit TIN, AND branch designation — "สำนักงานใหญ่" (code 00000) or "สาขาที่ XXXXX" (5-digit code, e.g., 00001). Both the label and the 5-digit code must appear.
3. **Buyer identity**: name and address. For the buyer to claim input VAT, the buyer's 13-digit TIN + branch designation is also required (technically the buyer provides it, but without it the document cannot serve as input-VAT evidence for the buyer's ภ.พ.30).
4. **Serial invoice number** (and book number if applicable) — must be sequential.
5. **Line detail**: description, quantity, and value per line.
6. **VAT amount separated clearly** — the pre-VAT base amount AND the 7% VAT component each shown as distinct figures (not embedded).
7. **Date of issuance**.

All particulars must be in Thai language, Thai currency (baht), Thai or Arabic numerals (§86/4 paragraph 3).

### 2.2 Abbreviated Tax Invoice — ใบกำกับภาษีอย่างย่อ (Revenue Code §86/6)

Permitted only for **retail businesses** (กิจการค้าปลีก) as designated by the Director-General. Key differences:
- Buyer name, address, and TIN are **not required**.
- Prices must be displayed **VAT-inclusive** with a clear "ราคารวมภาษีมูลค่าเพิ่มแล้ว" or "VAT Included" label.
- VAT need not be broken out as a separate line (though the document must state that VAT is included).
- **Cannot be used by the buyer to claim input VAT** for their own ภ.พ.30 — B2C only from a VAT-credit perspective.
- If a customer **requests a full invoice**, the retailer must issue one even if normally issuing abbreviated invoices.

Whether KRS POS qualifies as a designated retail business under Director-General designation is a compliance decision that has not been made and is not documented anywhere in the codebase or process files.

### 2.3 Invoice Numbering Rules

- **Sequential / gapless requirement**: §86/4(4) requires a serial number. Revenue Department auditor guidance treats gaps as a red-flag indicator. The law does not mandate zero-gap sequences in explicit text, but issued numbers must be in strict ascending order without reuse.
- **Reset period**: The Revenue Code does not mandate a specific reset period. Yearly (`TAX-YYYY-NNNNNN`) is the most common for small Thai businesses and matches the seeded `"TAX-2026-000418"` format. Daily resets (mirroring POS order numbers) and monthly resets are also accepted, provided the full prefix makes each number globally unique and auditably traceable.
- **POS order number ≠ tax invoice number**: The design source-of-truth (`design/Simple POS.dc.html` line 1875) explicitly states: `"posNo สร้างฝั่ง client ทันที (POS-YYYYMMDD-####). accountingDocNo มาจาก provider response หลัง sync สำเร็จเท่านั้น — อย่าผูกสองค่านี้เป็นตัวเดียวกัน"`. The POS order number is an internal reference; the legally mandatory sequential tax invoice number belongs in `Order.accountingDocNo`.

### 2.4 VAT Display Rules

- Retail businesses (§86/6): prices displayed inclusive of VAT — already the case (all prices are VAT-inclusive).
- Full tax invoice (§86/4): pre-VAT base amount, VAT amount (7%), and total inclusive amount must all be shown as separate figures. The current ReceiptModal already displays "ยอดก่อนภาษี" and "VAT 7%" (lines 161–175) — this portion is compliant.

### 2.5 Record Retention

§87/3: VAT registrants must retain tax invoices and supporting documents at the place of business for **at least 5 years** from the date of the tax return filing. The Director-General may extend to 7 years. No purge mechanism exists in the codebase (append-only convention), which is consistent with retention requirements, but no explicit 5-year retention policy is enforced in code.

### 2.6 E-Tax Invoice (Context Only)

e-Tax Invoice is currently **voluntary** for most Thai businesses (2025). Two routes exist: XML + digital signature (ETDA standard) or e-Tax Invoice by Email (annual revenue ≤ ฿30M). This is not a current legal obligation for KRS POS and is deferred to a future production-readiness phase.

---

## 3. Design Source-of-Truth Audit

### 3.1 Taste Redesign (design/KRS POS Taste Redesign.html, 156 lines)

This file defines the visual language but contains **no tax-invoice-specific UI screens** — only the POS checkout shell. Two tax mentions only:
- Cart customer row sub-caption (line 75): `"แตะเพื่อเลือกสมาชิก / ใบกำกับภาษี"`
- VAT display line (line 82): `"VAT 7% (รวมในราคา)"`

Design tokens confirmed: IBM Plex Sans Thai + IBM Plex Mono, `--brand:#1fa971`, `--blue:#2563eb` (accounting/tax tint), `--blue-soft:#eef4ff`.

### 3.2 Simple POS (design/Simple POS.dc.html, 1900 lines) — Authoritative Function/State Inventory

**Receipt paper (lines 990–1059) — 80mm thermal**  
The tax-payer block (lines 1024–1030) is conditional on `receipt.taxRequested` and shows:
- "ข้อมูลผู้เสียภาษี" (bold header)
- `receipt.taxName` (customer name)
- `TIN receipt.taxId` (mono)

The design does **not** show: seller TIN, seller address, seller branch code, buyer address, buyer branch, or an "ใบกำกับภาษี" document heading on the thermal receipt. The word "ใบกำกับภาษี" does not appear anywhere on the printed receipt template.

**Customer picker (lines 882–905)**: search by name or TIN, "มีข้อมูลภาษี" blue badge, TIN sub-line for tax customers. Does not show customer address in the picker row.

**Payment modal tax toggle (lines 907–988)**: pre-payment checkbox "ขอใบกำกับภาษี", amber warning when no TIN. Hard client block in `confirmPayment()` (line 1321).

**Sale Detail Drawer (lines 1061–1093)**: `canTax = status === 'paid' && !x.tax` (line 1599). The `!x.tax` check means the button is hidden **after** a tax invoice is already requested — this is the intended behavior but is not implemented in the current `canTax` logic.

**Accounting doc number format (line 1216)**: `'TAX-2026-000418'` — yearly prefix, 6-digit zero-padded sequence. The canned retry at line 1408 uses `TAX-2026-${3-digit random}` — explicitly a placeholder.

**Design IA (line 1799)**: customer fields required in system = "ข้อมูลลูกค้า · เลขผู้เสียภาษี · ที่อยู่ออกใบกำกับ" — billing address is confirmed as a required field on the tax invoice.

**Dev note (line 1875)**: explicitly warns `"อย่าผูกสองค่านี้เป็นตัวเดียวกัน"` (posNo and accountingDocNo must remain separate).

### 3.3 Component Inventory from Design (lines 1833–1847)

- `ReceiptPreview { sale, accountingDocNo?, taxInfo?, qrUrl }` — `taxInfo?` suggests a dedicated props shape for tax details.
- `TaxBadge { hasTax: boolean, taxId? }` — reusable badge component.

---

## 4. Implementation vs Design Gap Analysis

### GAP 1 — Customer Address Not Rendered (CONFIRMED)

`Customer.address` exists in the schema (line 23), is selected by `GET /api/customers` (customers/route.ts line 54), and is typed in `CustomerDTO.address?: string | null` (types/index.ts line 121). The `OrderDTO.customer` includes the full `CustomerDTO`. However, `ReceiptModal.tsx` lines 199–212 render only `order.customer.name` and `order.customer.taxId` — `order.customer.address` is never rendered. The design IA (Simple POS.dc.html line 1799) lists "ที่อยู่ออกใบกำกับ" as required.

### GAP 2 — Receipt Sync Badge Hardcoded (CONFIRMED)

`ReceiptModal.tsx` lines 248–255 hardcode a single "กำลังส่งเข้า KRS / Queued — INSERT to KRS" state. The Simple POS design (lines 1040–1043) specifies dynamic `receipt.syncBg`, `receipt.syncDot`, `receipt.syncLabel`, `receipt.syncLabelEn` — three states (pending/daily/synced). The `order.syncStatus` field exists on `OrderDTO` (types/index.ts line 138) and is passed through `ORDER_DETAIL_INCLUDE`, but the ReceiptModal does not use it.

### GAP 3 — `canTax` Missing `!order.taxRequested` Check (CONFIRMED)

`SaleDetailDrawer.tsx` lines 123–127:
```
const canTax =
  order.status === "COMPLETED" &&
  order.customer != null &&
  typeof order.customer.taxId === "string" &&
  order.customer.taxId.trim().length > 0;
```
The design's `canTax` (Simple POS.dc.html line 1599) is `x.status==='paid' && !x.tax`. The `!x.tax` (equivalent to `!order.taxRequested`) is absent. After a tax invoice is requested (`taxRequested` becomes `true`), the "ขอใบกำกับภาษี" button remains enabled and clickable, which would create a second `SyncJob` since the server-side `request-tax` PATCH also has no idempotency guard.

### GAP 4 — No Tax Invoice Running Number (CONFIRMED)

The design shows `accountingDocNo = 'TAX-2026-000418'` (yearly, 6-digit). Only `DailyOrderCounter` exists for POS order numbering. No `TaxInvoiceCounter` or equivalent model exists anywhere. `accountingDocNo` on Order is the correct field to hold the number but is currently always null in live transactions (set only in seed and canned response string, never written back to `Order` by any API).

### GAP 5 — No Seller Identity Fields (CONFIRMED)

No seller TIN, no seller registered address, no RD 5-digit branch code exist in schema, env, or config. These are hardcoded strings in `ReceiptModal.tsx`. For a compliant §86/4 full tax invoice, seller TIN and registered address are mandatory particulars.

### GAP 6 — No Buyer Branch Code (CONFIRMED)

`Customer.branchId` (schema line 26, default `"BR-01"`) holds the seller's branch identifier, not the buyer's RD-compliant 5-digit branch code. The buyer's branch designation (สำนักงานใหญ่ / สาขาที่ XXXXX) is not modeled anywhere. This is needed for B2B full tax invoices where the buyer claims input VAT.

### GAP 7 — No "ใบกำกับภาษี" Document Heading on Printed Output (CONFIRMED)

`ReceiptModal.tsx` line 87: the modal label is `"ใบเสร็จ"`. No "ใบกำกับภาษี" heading appears anywhere on the printed receipt template. For §86/4 compliance, the word "ใบกำกับภาษี" must appear prominently. The existing ReceiptModal is a single 80mm thermal receipt template that conditionally shows a buyer-TIN block — it is not a legally compliant full tax invoice document.

### GAP 8 — No Distinct Tax Invoice Document Template (CONFIRMED)

There is no `TaxInvoiceModal`, `TaxInvoiceDocument`, or A4/print template in the codebase. The design source-of-truth (`Simple POS.dc.html`) does not specify a separate tax invoice document layout beyond the thermal receipt with a buyer-TIN block. The Taste redesign contains no tax invoice document design at all. This leaves the rendering approach entirely unspecified from the design perspective.

---

## 5. What Already Works Correctly

The following tax-related behaviors are correctly implemented and match the design spec:

| Area | File:line | Status |
|---|---|---|
| Cart customer row + "มีข้อมูลภาษี" badge | pos/page.tsx lines 722–747 | Matches design |
| Customer picker: walk-in first, TIN badge, name/TIN filter | CustomerPickerModal.tsx | Matches design |
| Payment modal tax toggle + taxWarn amber | PaymentModal.tsx lines 160–198 | Matches design |
| confirmPayment() hard-block when taxRequested + no TIN | pos/page.tsx line 430 | Matches design |
| Receipt paper: buyer name + TIN block | ReceiptModal.tsx lines 199–212 | Partial — address missing |
| Receipt: accountingDocNo displayed, placeholder when null | ReceiptModal.tsx lines 64–65 | Matches design |
| request-tax PATCH + PENDING SyncJob creation | orders/[id]/route.ts lines 176–191 | Works; missing idempotency |
| requestTax toast copy | sales/page.tsx line 132 | Matches design |
| Sales table "ใบกำกับ" badge | SalesTable.tsx lines 97–104 | Matches design |
| Sales filter chip "ขอใบกำกับ" | saleMeta.ts line 65 | Matches design |
| VAT math (inclusive extraction, pre-VAT display) | pricing.ts + ReceiptModal.tsx | Legally correct |
| TAX_REQUIRES_TAX_CUSTOMER gate | orders/[id]/route.ts lines 159–170 | Correct |

---

## 6. Open Design Tensions

**Tension A — accountingDocNo origin:**  
The design source-of-truth (`Simple POS.dc.html` line 1875) explicitly states `accountingDocNo` comes from the KRS provider response after a successful sync, and warns not to conflate it with the POS order number. This means: in the original design intent, the tax invoice number is externally issued (KRS), not locally minted. This creates a direct tension with the compliance requirement that a printed tax invoice must carry a valid sequential number at the time of printing. If `accountingDocNo` is null until KRS syncs (which may be asynchronous or deferred), the document cannot be printed as a compliant tax invoice immediately after the sale.

**Tension B — abbreviated vs full in current design:**  
The Simple POS receipt block (lines 1024–1030) shows only buyer name + TIN in the tax block — no seller TIN, no seller address, no buyer address, no document heading. This matches the structure of an **abbreviated tax invoice** (§86/6 — no buyer address required) supplemented with a buyer TIN block, but it is neither a complete abbreviated invoice (the document does not state "VAT included" prominently as required by §86/6) nor a complete full tax invoice (seller TIN, seller address, buyer address all absent). The design is in an intermediate, non-compliant state for either formal category.

---

## 7. Confirmed Evidence: Numbering Infrastructure

The `DailyOrderCounter` atomic upsert pattern (schema lines 247–251, orders/route.ts lines 197–221) provides:
- Race-safe, gap-resistant sequential numbering via `INSERT … ON CONFLICT DO UPDATE`
- Bangkok-clock-derived day key (Postgres `now() AT TIME ZONE 'Asia/Bangkok'`)
- Wrapped inside the checkout transaction (rolled-back sales do not consume a number)
- Format: `POS-${day}-${seq.padStart(4,'0')}`

The seeded `accountingDocNo` format `"TAX-2026-000418"` (seed.ts line 179) uses `TAX-${year}-${seq.padStart(6,'0')}` — annual reset, 6-digit padding. The canned sync retry uses `TAX-2026-${Math.floor(Math.random()*900+100)}` (3-digit random) — explicitly a non-production placeholder.

No `formatTaxInvoiceNumber` helper exists anywhere in the codebase.

---

## 8. Confirmed Evidence: env.ts Extension Pattern

`src/lib/env.ts` uses a Zod `EnvSchema` (lines 24–54) with fail-fast validation at server boot. The pattern is established and extensible. Currently validates 5 vars. No `NEXT_PUBLIC_*` vars exist (no client-side env exposure). Seller identity fields would need to be added to this schema if the env-var approach is chosen.

---

## 9. Unresolved Questions

- Whether KRS POS qualifies as a "retail business" under Director-General designation for §86/6 abbreviated invoices is not documented anywhere.
- Whether `accountingDocNo` is to be issued locally (by the POS) or remotely (by KRS after sync) is the single most consequential architectural decision — it determines the counter model design, the print flow (immediate vs deferred), and the schema shape.
- The design source-of-truth has no A4 or full-page tax invoice document layout anywhere; the render format (80mm thermal extension vs separate A4 template vs PDF generation) is entirely unspecified.
- The customer-address display in `CustomerPickerModal` is confirmed as NOT a design requirement for the picker row — address is a receipt-only concern.

---

## 10. Migrations Confirmed Present

Seven migrations exist: `init_with_payments`, `phase4_catalog_stock_users`, `phase5_shift_sales_status`, `phase6a_customer_syncjob`, `phase3_auth_lockout_audit`, `phase_financial_correctness`, `phase_idempotency_ordernumber`. None adds a `TaxInvoice`, `TaxInvoiceCounter`, `ShopSettings`, or seller-identity model.

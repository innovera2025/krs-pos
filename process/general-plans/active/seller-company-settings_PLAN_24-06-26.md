# Seller / Company Settings — Implementation Plan
**Plan file:** `process/general-plans/active/seller-company-settings_PLAN_24-06-26.md`
**Created:** 2026-06-24
**Complexity:** SIMPLE (single session, one migration, no new model, DB-only concern)
**Status:** READY FOR EXECUTE

---

## 1. Overview

Move seller identity (company name, TIN, address, phone, POS ID, branch code/label) from
`SELLER_*` environment variables to the existing `ShopSettings` singleton in the database,
so the shop owner can edit these values from the `/settings` admin screen without touching
the server environment.

**Sources of truth (in priority order):**
1. DB column (`ShopSettings`) — written via the Settings UI PATCH
2. `SELLER_*` ENV vars — fallback per-field when the DB value is NULL/empty
3. Hard-coded HQ defaults for branchCode/branchLabel only ("00000" / "สำนักงานใหญ่")

This is an ADDITIVE change — no existing columns are altered, no existing ENV vars are
removed, and the checkout path (`src/app/api/orders/route.ts`) is NOT touched.

---

## 2. Goals

- Owner can edit seller identity from `/settings` UI without a server restart or env-var change.
- All existing tax-invoice flows continue to work: the §86/4 null-refusal (422 SELLER_NOT_CONFIGURED)
  is preserved. Minting still fails if ANY mandatory particular (TIN / name / address) resolves
  to empty after the DB-then-ENV fallback chain.
- Existing `SELLER_*` env-based deploys keep working on day-0 (zero downtime, no forced migration
  of env vars by the operator).
- phone + posId are added to `SellerConfig` / `SellerConfigDTO`; they appear on the thermal receipt
  (ReceiptModal header block) but do NOT block tax-invoice minting (they are not §86/4 mandatory).
- `getSellerConfig()` becomes `async` (reads ShopSettings first, falls back to ENV); all callers
  are updated to `await` it.

---

## 3. Scope — What Changes

### Files CREATED (new)
| File | Purpose |
|---|---|
| `prisma/migrations/YYYYMMDDHHMMSS_seller_settings/migration.sql` | ADD 7 nullable columns to `ShopSettings` |

### Files MODIFIED
| File | What changes |
|---|---|
| `prisma/schema.prisma` | Add 7 optional `String?` fields to `ShopSettings` |
| `src/lib/sellerConfig.ts` | `getSellerConfig()` → `async`, DB-first + ENV fallback; add `phone`/`posId` to `SellerConfig` type |
| `src/types/index.ts` | Add `phone?`/`posId?` to `SellerConfigDTO` |
| `src/lib/schemas/shopSettings.ts` | Extend `ShopSettingsPatchBodySchema` with seller fields; update `ShopSettingsPatchBody` export type |
| `src/app/api/settings/route.ts` | Add seller fields to `SETTINGS_SELECT`; include in upsert `update`/`create` blocks |
| `src/app/api/seller-config/route.ts` | `await getSellerConfig()` (was sync call) |
| `src/app/api/orders/[id]/route.ts` | `await getSellerConfig()` in request-tax path (was sync call) |
| `src/app/(shell)/settings/page.tsx` | Add "ข้อมูลกิจการ · Seller Info" card section, admin-gated form + save |
| `src/components/pos/ReceiptModal.tsx` | Render phone + posId in receipt header (fetched from `/api/settings`) |

### Files NOT TOUCHED
- `src/app/api/orders/route.ts` — checkout; explicitly excluded by owner
- `src/components/sales/TaxInvoiceDocument.tsx` — `seller` prop is already `SellerConfigDTO`; the new
  `phone`/`posId` fields on the DTO are optional and the document does NOT render them (tax invoice
  does not require phone/posId; the thermal receipt does)
- `prisma/seed.ts` — no change needed; ShopSettings seed row omits seller fields (they stay null/env)
- `src/lib/env.ts` — ENV vars are KEPT AS FALLBACK; no changes

---

## 4. Data Flow

```
Admin edits Settings UI
  → PATCH /api/settings  (requireAdmin)
  → ShopSettingsPatchBodySchema validates (Zod)
  → prisma.shopSettings.upsert(update: { sellerName, sellerTaxId, … })
  → returns updated ShopSettingsDTO (incl. seller fields)

Cashier or server reads seller identity:
  → await getSellerConfig()
  → prisma.shopSettings.findUnique({ where: { id: "singleton" }, select: sellerFields })
  → for each of: name, taxId, address, branchCode, branchLabel, phone, posId
      resolved = db.field (if non-null, non-empty)   OR  env.SELLER_*(fallback)
  → if resolved name/taxId/address all truthy → return SellerConfig
    else → return null  (triggers 422 in request-tax)

Receipt rendering:
  → ReceiptModal fetches GET /api/settings (requireUser)
  → gets sellerPhone, sellerPosId from ShopSettingsDTO
  → renders in receipt header block

Tax invoice rendering (TaxInvoiceDocument):
  → caller already has SellerConfigDTO from GET /api/seller-config
  → phone/posId are OPTIONAL on SellerConfigDTO; TaxInvoiceDocument does not render them
    (they are not §86/4 mandatory and the A4 document is NOT changed in this plan)
```

---

## 5. Detailed Specification

### 5.1 Prisma Schema — `ShopSettings` additive columns

Add to the `ShopSettings` model (all `String?` nullable, no default, no index required):

```
sellerName        String?   // §86/4 mandatory: registered legal name (≤200 chars)
sellerTaxId       String?   // §86/4 mandatory: 13-digit TIN
sellerAddress     String?   // §86/4 mandatory: registered address (≤300 chars)
sellerPhone       String?   // Optional for receipt: contact phone (≤50 chars)
sellerPosId       String?   // Optional for receipt: POS terminal ID (≤50 chars)
sellerBranchCode  String?   // 5-digit RD branch code (default resolved in getSellerConfig)
sellerBranchLabel String?   // Human branch label (default resolved in getSellerConfig)
```

The existing comment on `ShopSettings` in schema.prisma that says "Seller identity stays in ENV
and is intentionally NOT migrated here" must be replaced with a comment explaining the new design.

### 5.2 Migration SQL

Migration name pattern: `YYYYMMDDHHMMSS_seller_settings`

Generated via `prisma migrate dev --name seller_settings`. The SQL will be seven
`ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS` statements with nullable `TEXT` columns.
**No existing column is altered; no data is destroyed.**

After running the migration, run `prisma generate` to regenerate the client.

### 5.3 `src/lib/sellerConfig.ts` — async DB-first getSellerConfig

The function signature changes from:
```
export function getSellerConfig(): SellerConfig | null
```
to:
```
export async function getSellerConfig(): Promise<SellerConfig | null>
```

New `SellerConfig` type (add `phone` and `posId` as optional):
```typescript
export type SellerConfig = {
  name: string;
  address: string;
  taxId: string;
  branchCode: string;
  branchLabel: string;
  phone?: string;   // NEW — optional, not §86/4 mandatory
  posId?: string;   // NEW — optional, not §86/4 mandatory
};
```

Implementation logic:
1. Query `prisma.shopSettings.findUnique({ where: { id: "singleton" }, select: { sellerName: true, sellerTaxId: true, sellerAddress: true, sellerPhone: true, sellerPosId: true, sellerBranchCode: true, sellerBranchLabel: true } })`
2. Per-field resolution (DB value wins if non-null and non-empty after trim; else ENV fallback):
   - `name`        = (db.sellerName?.trim()   || env.SELLER_NAME)   || null
   - `taxId`       = (db.sellerTaxId?.trim()  || env.SELLER_TAX_ID) || null
   - `address`     = (db.sellerAddress?.trim() || env.SELLER_ADDRESS) || null
   - `branchCode`  = db.sellerBranchCode?.trim() || env.SELLER_BRANCH_CODE || HQ_BRANCH_CODE
   - `branchLabel` = db.sellerBranchLabel?.trim() || env.SELLER_BRANCH_LABEL || (branchCode === HQ_BRANCH_CODE ? HQ_BRANCH_LABEL : `สาขาที่ ${branchCode}`)
   - `phone`       = db.sellerPhone?.trim() || undefined  (no ENV fallback — phone is new)
   - `posId`       = db.sellerPosId?.trim() || undefined  (no ENV fallback — posId is new)
3. Mandatory-particular check: if ANY of (name / taxId / address) is falsy → return `null`
4. `posId` and `phone` never affect the null-return decision.
5. The module-level `import { env } from "@/lib/env"` is retained (fallback still reads env).
6. The module-level `import { prisma } from "@/lib/prisma"` is added.

### 5.4 `src/types/index.ts` — SellerConfigDTO

Extend `SellerConfigDTO` with two optional fields:
```typescript
export type SellerConfigDTO = {
  name: string;
  address: string;
  taxId: string;
  branchCode: string;
  branchLabel: string;
  phone?: string;   // NEW
  posId?: string;   // NEW
};
```

Also extend `ShopSettingsDTO` with the seven seller fields:
```typescript
export type ShopSettingsDTO = {
  receiptWidthMm: number;
  receiptHeightAuto: boolean;
  receiptHeightMm: number | null;
  // Seller identity (editable via /settings, DB-primary, ENV fallback)
  sellerName: string | null;
  sellerTaxId: string | null;
  sellerAddress: string | null;
  sellerPhone: string | null;
  sellerPosId: string | null;
  sellerBranchCode: string | null;
  sellerBranchLabel: string | null;
};
```

### 5.5 `src/lib/schemas/shopSettings.ts` — Zod schema extension

Add seller field schemas to `ShopSettingsPatchBodySchema`. All seller fields are OPTIONAL
in the PATCH body (the existing receipt-size fields remain required). The schema must be
extended as a merged/intersection so the existing `superRefine` cross-field check is preserved.

Seller field validations:
- `sellerTaxId`: `z.string().regex(/^\d{13}$/, "เลขประจำตัวผู้เสียภาษีต้องมี 13 หลัก").or(z.literal("")).optional()` — allow empty string to CLEAR the value (resolved to null in the route); 13 digits when non-empty
- `sellerName`: `z.string().max(200).optional()`
- `sellerAddress`: `z.string().max(300).optional()`
- `sellerPhone`: `z.string().max(50).optional()`
- `sellerPosId`: `z.string().max(50).optional()`
- `sellerBranchCode`: `z.string().regex(/^\d{5}$/).or(z.literal("")).optional()` — 5 digits when non-empty or empty string to clear
- `sellerBranchLabel`: `z.string().max(100).optional()`

**Trim-and-null-empty normalization** is performed in the ROUTE (not the schema). The route
converts any empty-string seller field to `null` before the upsert so storage is consistent
(null = "not set"; empty string = never stored). This mirrors how `receiptHeightMm` is
normalized.

Update `ShopSettingsPatchBody` export type.

### 5.6 `src/app/api/settings/route.ts` — seller fields in GET and PATCH

**SETTINGS_SELECT extension:**
```typescript
const SETTINGS_SELECT = {
  receiptWidthMm: true,
  receiptHeightAuto: true,
  receiptHeightMm: true,
  sellerName: true,
  sellerTaxId: true,
  sellerAddress: true,
  sellerPhone: true,
  sellerPosId: true,
  sellerBranchCode: true,
  sellerBranchLabel: true,
} as const;
```

**GET handler** — no logic change; the upsert-on-read `create: { id: SINGLETON_ID }` creates
the row with all new seller fields as NULL (Prisma applies the schema's `String?` default = NULL).
The extended `SETTINGS_SELECT` will now include seller fields in the response.

**PATCH handler** — extract the seller fields from `parsed.data` and apply trim-and-null-empty
normalization before the upsert:
```
const toNullOrTrimmed = (v: string | undefined): string | null =>
  v === undefined ? undefined : (v.trim() === "" ? null : v.trim())
// Then pass toNullOrTrimmed(sellerName) etc. to the upsert update/create
```
Note: `undefined` means "not sent in this PATCH" (the field stays unchanged in the DB);
`null` means "explicitly cleared". Use Prisma's `undefined`-means-skip behaviour.

Auth gates remain unchanged: GET = `requireUser`, PATCH = `requireAdmin`.

### 5.7 `src/app/api/seller-config/route.ts` — await the async call

Change:
```typescript
const seller = getSellerConfig();
```
to:
```typescript
const seller = await getSellerConfig();
```

No other changes needed.

### 5.8 `src/app/api/orders/[id]/route.ts` — await in request-tax path

Change the synchronous call at the SELLER_NOT_CONFIGURED gate:
```typescript
const seller = getSellerConfig();
```
to:
```typescript
const seller = await getSellerConfig();
```

The surrounding try/catch already handles errors. This is the ONLY change in this file.
The `src/app/api/orders/route.ts` (checkout) is NOT touched.

### 5.9 `src/app/(shell)/settings/page.tsx` — Seller Info card

A new second card section is added inside the same `<form>` element after the existing
"เครื่องพิมพ์" card. The card header icon uses a `Building2` (or `Store`) lucide icon.

**Card title:** "ข้อมูลกิจการ · Seller Info"
**Card subtitle:** "ข้อมูลแสดงบนใบเสร็จและใบกำกับภาษี"

Form fields (all optional text inputs, string drafts like the existing widthDraft):
| Field key | Thai label | Input note |
|---|---|---|
| `sellerName` | ชื่อกิจการ · Name | max 200 |
| `sellerTaxId` | เลขประจำตัวผู้เสียภาษี · TIN | 13-digit validation hint; `inputMode="numeric"` |
| `sellerAddress` | ที่อยู่ · Address | `<textarea>` rows=3, max 300 |
| `sellerPhone` | โทรศัพท์ · Phone | max 50 |
| `sellerPosId` | รหัส POS Terminal · POS ID | max 50 |
| `sellerBranchCode` | รหัสสาขา · Branch Code | 5 digits; defaulted to "00000"; `inputMode="numeric"` |
| `sellerBranchLabel` | ชื่อสาขา · Branch Label | max 100 |

A status line at the bottom of the card (similar to the receipt preview line) shows:
- "ข้อมูลครบถ้วน — พร้อมออกใบกำกับภาษี" (green mint) when sellerName/TaxId/Address are all non-empty
- "ยังไม่ครบ — จะไม่สามารถออกใบกำกับภาษีได้" (amber/warning) when any mandatory field is empty

The **existing Save button** applies to both sections together (one PATCH payload carrying
both receipt-size fields AND seller fields). The PATCH body already allows partial seller
fields (all optional in schema); the route normalizes undefined = "leave unchanged".

Load flow: `loadSettings()` already fetches `GET /api/settings`; extend the handler to
populate the new seller draft states from `data.settings.sellerName` etc.

No separate save button for seller-only; the single "บันทึกการตั้งค่า" button saves all settings.

The component remains wrapped in `<AdminOnly>` at the page level — no change to the gate.

### 5.10 `src/components/pos/ReceiptModal.tsx` — phone + posId in header

**Current header** is hardcoded with `BRANCH` and `PHONE` constants. These are replaced with
dynamic values fetched from the settings.

**Strategy:** The ReceiptModal currently receives only `order: OrderDTO | null`. Rather than
drilling a new prop through the POS page, the modal fetches `GET /api/settings` once on open
(inside a `useEffect` triggered by `open === true`). It caches the result in a `sellerInfo`
state variable. This avoids prop drilling and keeps the fetch co-located with where it's rendered.

The receipt header renders:
1. **Company name** — `sellerInfo.sellerName ?? "KRS"` (keep "KRS" as safe fallback)
2. **Branch + code line** — `sellerInfo.sellerBranchLabel` (if set) or existing fallback text
3. **Phone line** — `sellerInfo.sellerPhone` — rendered only when non-null/non-empty
4. **POS ID line** — `sellerInfo.sellerPosId` — rendered only when non-null/non-empty (format: "POS: {id}")

Remove the `BRANCH` and `PHONE` module-level constants after the settings fetch is wired.

New local state in ReceiptModal (minimal, does not affect existing order/print logic):
```typescript
const [sellerInfo, setSellerInfo] = useState<Partial<ShopSettingsDTO>>({});
useEffect(() => {
  if (!open) return;
  fetch("/api/settings")
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data?.settings) setSellerInfo(data.settings); })
    .catch(() => {});
}, [open]);
```

Import `ShopSettingsDTO` from `@/types` in ReceiptModal.

---

## 6. Touchpoints (Full File List)

| # | File | Change type | Why |
|---|---|---|---|
| 1 | `prisma/schema.prisma` | MODIFY | Add 7 nullable fields to ShopSettings model |
| 2 | `prisma/migrations/*/migration.sql` | CREATE | ADD COLUMN x7 on ShopSettings |
| 3 | `src/lib/sellerConfig.ts` | MODIFY | async + DB-first + phone/posId + SellerConfig type |
| 4 | `src/types/index.ts` | MODIFY | SellerConfigDTO + ShopSettingsDTO extended |
| 5 | `src/lib/schemas/shopSettings.ts` | MODIFY | Zod schema extended with seller fields |
| 6 | `src/app/api/settings/route.ts` | MODIFY | SETTINGS_SELECT + upsert data extended |
| 7 | `src/app/api/seller-config/route.ts` | MODIFY | await getSellerConfig() |
| 8 | `src/app/api/orders/[id]/route.ts` | MODIFY | await getSellerConfig() in request-tax path only |
| 9 | `src/app/(shell)/settings/page.tsx` | MODIFY | Seller Info card + form state + save |
| 10 | `src/components/pos/ReceiptModal.tsx` | MODIFY | Dynamic header via settings fetch |

---

## 7. Public Contracts

### API contract changes (additive only)

**GET /api/settings** — response `settings` object gains 7 new nullable fields:
```json
{
  "settings": {
    "receiptWidthMm": 80,
    "receiptHeightAuto": true,
    "receiptHeightMm": null,
    "sellerName": "บริษัท เค.อาร์.เอส. จำกัด",
    "sellerTaxId": "1234567890123",
    "sellerAddress": "123 ถนนสีลม กรุงเทพฯ 10500",
    "sellerPhone": "02-123-4567",
    "sellerPosId": "POS-001",
    "sellerBranchCode": "00000",
    "sellerBranchLabel": "สำนักงานใหญ่"
  }
}
```
Existing clients that only read `receiptWidthMm` / `receiptHeightAuto` / `receiptHeightMm`
are unaffected (they ignore unknown fields in JSON).

**PATCH /api/settings** — body now OPTIONALLY accepts seller fields. Existing PATCH calls
that only send receipt-size fields continue to work; seller fields default to `undefined`
(Prisma skips them).

**GET /api/seller-config** — response `seller` object gains optional `phone?` and `posId?`.
Existing callers (`TaxInvoiceDocument`) that only read name/address/taxId/branchCode/branchLabel
are unaffected.

### Type contract changes
`SellerConfigDTO` — two optional fields added (`phone?`, `posId?`). Backwards compatible.
`ShopSettingsDTO` — seven nullable fields added. Backwards compatible.
`ShopSettingsPatchBody` — seven optional fields added. Backwards compatible.

---

## 8. Blast Radius

### async getSellerConfig() ripple — HIGHEST RISK
`getSellerConfig()` becomes `async`. The two call sites are:
- `src/app/api/seller-config/route.ts` — already inside an `async` handler, trivial `await`
- `src/app/api/orders/[id]/route.ts` — already inside an `async` handler, trivial `await`

**No other file calls `getSellerConfig()` directly** (confirmed by grep: only these two route
files and `sellerConfig.ts` itself import it). The change is contained.

### request-tax transaction — MEDIUM RISK
`getSellerConfig()` is called BEFORE the `$transaction` block in the request-tax path
(as it is today). After this change, the `await` happens before the transaction opens.
The transaction logic itself is unchanged. No risk of a DB call inside the transaction
changing the transaction scope.

### ReceiptModal settings fetch — LOW RISK
The new `useEffect` fetch fires once when `open` becomes true. It is fire-and-catch — if
it fails, `sellerInfo` stays empty and the header falls back to the hardcoded values
("KRS", no phone/posId rendered). The receipt renders regardless; the fetch is cosmetic.

### TaxInvoiceDocument — NO CHANGE
The `seller` prop type (`SellerConfigDTO`) gains optional fields. The component does NOT
render `phone`/`posId`. No behavioral change; TypeScript structural compatibility is preserved.

### `src/app/api/orders/route.ts` — NOT TOUCHED
The checkout route does not call `getSellerConfig()`. Zero blast radius here.

---

## 9. Implementation Checklist

Execute in this exact order:

### Schema + Prisma (Steps 1–3)
1. **`prisma/schema.prisma`** — update `ShopSettings` model: add 7 nullable `String?` fields
   (`sellerName`, `sellerTaxId`, `sellerAddress`, `sellerPhone`, `sellerPosId`,
   `sellerBranchCode`, `sellerBranchLabel`). Update the model comment to reflect DB-primary
   design. Do NOT alter any existing field.

2. **Run migration** — `prisma migrate dev --name seller_settings` (generates migration SQL in
   `prisma/migrations/YYYYMMDDHHMMSS_seller_settings/migration.sql`). Verify the generated SQL
   contains only `ADD COLUMN IF NOT EXISTS` statements, no drops or alters.

3. **Prisma client regeneration** — `prisma generate` (happens automatically with `migrate dev`
   but explicit in the checklist for clarity).

### Types + Schema (Steps 4–5)
4. **`src/types/index.ts`** — extend `SellerConfigDTO` with `phone?: string; posId?: string`.
   Extend `ShopSettingsDTO` with 7 new `string | null` seller fields.

5. **`src/lib/schemas/shopSettings.ts`** — extend `ShopSettingsPatchBodySchema` with the 7
   seller field schemas (all optional). Update `ShopSettingsPatchBody` export type.

### Core library (Step 6)
6. **`src/lib/sellerConfig.ts`** — rewrite `getSellerConfig()` as async:
   - add `import { prisma } from "@/lib/prisma"`
   - change return type to `Promise<SellerConfig | null>`
   - add `phone?: string` and `posId?: string` to `SellerConfig` type
   - implement DB-first + ENV per-field fallback logic (see §5.3)
   - mandatory-particular null check unchanged

### API routes (Steps 7–9)
7. **`src/app/api/settings/route.ts`** — extend `SETTINGS_SELECT` with the 7 seller fields.
   In `GET`: no logic change (upsert-on-read creates null values automatically).
   In `PATCH`: extract seller fields from `parsed.data`, apply trim-and-null-empty normalization,
   include in `update` and `create` blocks of the upsert. Update the `toResponse` return type
   annotation if it has one.

8. **`src/app/api/seller-config/route.ts`** — change `getSellerConfig()` → `await getSellerConfig()`.

9. **`src/app/api/orders/[id]/route.ts`** — change the single `getSellerConfig()` call in the
   request-tax path to `await getSellerConfig()`. This is the ONLY change in this file.

### UI (Steps 10–11)
10. **`src/app/(shell)/settings/page.tsx`** — add:
    - import `Building2` (or `Store`) from `lucide-react`
    - 7 new draft state variables (string, initialized from settings load)
    - extend `loadSettings()` to populate seller draft states from `data.settings`
    - extend `save()` payload to include seller fields
    - a new "ข้อมูลกิจการ · Seller Info" card section after the Printer card
    - the completeness status line (green / amber based on mandatory field presence)
    - No new save button — the existing "บันทึกการตั้งค่า" covers all fields

11. **`src/components/pos/ReceiptModal.tsx`** — add:
    - import `ShopSettingsDTO` from `@/types`
    - `useState<Partial<ShopSettingsDTO>>({})` for `sellerInfo`
    - `useEffect(() => { if (!open) return; fetch("/api/settings")… }, [open])`
    - Replace hardcoded `BRANCH` / `PHONE` constants with dynamic values from `sellerInfo`
    - Render `sellerInfo.sellerPhone` and `sellerInfo.sellerPosId` conditionally in the header

### Verification (Steps 12–13)
12. **Type-check** — run `npm run type-check` (tsc --noEmit). Zero errors required.

13. **Build** — run `npm run build`. Zero errors required. (Confirms the async
    `getSellerConfig()` ripple did not break any static analysis or module boundary.)

---

## 10. Acceptance Criteria

All must pass before the plan is considered DONE:

1. `npm run type-check` passes with zero errors.
2. `npm run build` completes successfully.
3. The migration SQL contains only `ADD COLUMN` statements (no drops, no alters to existing columns).
4. **GET /api/settings** returns all 7 new seller fields as `null` on a fresh/unseeded row.
5. **PATCH /api/settings** (admin) with `{ sellerName: "บริษัท ทดสอบ" }` saves to DB and is
   returned in the next GET.
6. **GET /api/seller-config** returns `{ seller: null }` when no seller fields are set in DB
   AND `SELLER_TAX_ID`/`SELLER_NAME`/`SELLER_ADDRESS` are unset in ENV.
7. **GET /api/seller-config** returns a non-null seller when DB has all three mandatory fields.
8. **GET /api/seller-config** returns a non-null seller when DB fields are null but ENV vars
   are set (ENV fallback working).
9. **PATCH /api/orders/:id with `{action:"request-tax"}`** returns 422 SELLER_NOT_CONFIGURED
   when neither DB nor ENV has the mandatory seller particulars. (Tax-invoice null-refusal
   preserved.)
10. **PATCH /api/orders/:id with `{action:"request-tax"}`** succeeds and mints a doc number
    when seller mandatory fields are set (via DB or ENV).
11. `/settings` page renders the "ข้อมูลกิจการ" card for an admin session.
12. Receipt header shows phone / POS ID when those fields are set in DB.
13. Empty-string seller fields saved via PATCH are stored as `null` (not empty string) in DB.
14. A PATCH with `{ sellerTaxId: "abc" }` (non-13-digit) returns 400 VALIDATION.

---

## 11. Validation / Verification Strategy

### Manual smoke (no automated test runner yet — see process/context/tests/all-tests.md)

**Scenario A — DB-primary flow (new owner-configured seller):**
1. Boot the app with NO `SELLER_*` env vars set.
2. `GET /api/seller-config` → `{ seller: null }` (correct; no config yet).
3. Attempting request-tax → 422 SELLER_NOT_CONFIGURED (§86/4 refusal preserved).
4. Log in as admin, go to `/settings`, fill in all 3 mandatory + phone + posId, Save.
5. `GET /api/seller-config` → non-null seller with phone/posId.
6. `GET /api/settings` → seller fields returned (non-null).
7. Open ReceiptModal → header shows company name, phone, POS ID.
8. Perform a checkout with a tax customer, request-tax → succeeds (doc number minted).
9. Seller name rendered on `/api/seller-config` matches what was typed.

**Scenario B — ENV fallback (existing deploy, no DB seller fields):**
1. Set `SELLER_NAME`, `SELLER_TAX_ID`, `SELLER_ADDRESS` in ENV; do NOT set them in DB.
2. `GET /api/seller-config` → non-null seller from ENV (fallback working).
3. Request-tax → succeeds.
4. The Settings UI shows empty seller fields (DB is null; the form doesn't pre-fill from ENV —
   this is intentional: owner must actively choose to save ENV values to DB if they want to
   manage them there).

**Scenario C — DB overrides ENV (migration day for existing deploy):**
1. ENV has `SELLER_NAME=A`; DB has `sellerName=B`.
2. `GET /api/seller-config` → `{ seller: { name: "B", … } }` (DB wins).

**Scenario D — partial DB (only name set in DB, address from ENV):**
1. DB: `sellerName="Foo"`, all other seller fields null.
2. ENV: `SELLER_TAX_ID=1234567890123`, `SELLER_ADDRESS="Bangkok"`.
3. `GET /api/seller-config` → `{ seller: { name: "Foo", taxId: "1234567890123", address: "Bangkok", … } }`
   (per-field fallback working).

**Scenario E — tax-invoice null-refusal preserved:**
1. DB has name + address but NOT taxId; ENV has no SELLER_TAX_ID.
2. `GET /api/seller-config` → `{ seller: null }`.
3. Request-tax → 422 SELLER_NOT_CONFIGURED.

**Scenario F — type-check and build gate:**
- `npm run type-check` → zero errors
- `npm run build` → success

---

## 12. Dependencies and Blockers

| Item | Status | Note |
|---|---|---|
| Prisma 5 / Postgres 16 | Available | No version change needed |
| `prisma migrate dev` access | Needs local DB running | Use `docker compose up db -d` if needed |
| `SELLER_*` ENV vars | Optional | Keep as fallback; no removal required |
| `src/app/api/orders/route.ts` | NOT TOUCHED | Explicitly excluded by owner |
| Auth — `requireAdmin` for PATCH | Already implemented (auth Phase 3) | No new auth work |

**No blockers.** All dependencies are satisfied by the current codebase.

---

## 13. Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `async getSellerConfig()` missed at a call site | Low (only 2 call sites confirmed by grep) | `npm run type-check` will catch any missed `await` (TS `strict` + `@typescript-eslint/no-floating-promises` would flag it; even without that, the return type `Promise<SellerConfig | null>` means a non-awaited call returns a truthy Promise object, making the `if (!seller)` guard always skip → 422 never fires → detectable in Scenario E) |
| Prisma shared-select const gotcha (see memory) | Applicable here | `SETTINGS_SELECT` is a `const` with `as const` — TS type is derived structurally. Adding new `true` entries is additive and safe. Confirm the `toResponse` type annotation (if explicit) is updated to `ShopSettingsDTO`. |
| Empty string vs null inconsistency | Low | Normalize in route: any seller field that is an empty string after trim is written as `null`. Zod allows `z.literal("")` on sellerTaxId/branchCode to pass validation but the route converts to null. |
| Receipt header fetch fails silently | Acceptable | Fire-and-catch; receipt renders regardless. Worst case: header shows hardcoded fallback. Not a safety issue. |
| Migration runs on production before ENV removed | Non-issue | New columns are nullable; existing app code (before this deploy) reads only ENV and ignores DB seller columns (they don't exist yet). After deploy, DB-null → ENV fallback → zero-downtime upgrade. |
| Prisma Decimal 2dp serialization (see memory) | Not applicable | Seller fields are `String?`, not `Decimal`. No serialization concern. |

---

## 14. Decisions Needing Sign-Off

### Signed off by owner (do not re-open):
- Fields: sellerName, sellerTaxId, sellerAddress, sellerPhone, sellerPosId, sellerBranchCode,
  sellerBranchLabel. No logo, no email.
- Edit = ADMIN ONLY. Read (for printing) = any authenticated user.
- Source of truth = DB with ENV as fallback.

### Pending sign-off (one item):

**Decision D1 — Keep or drop SELLER_* env vars long-term?**

RECOMMENDATION: **KEEP the SELLER_* env vars as fallback indefinitely.**

Rationale:
1. Zero-downtime upgrade path — existing operators using ENV-based seller config continue
   working with no action required on deploy day.
2. CI / e2e environments (which may never have a database row) still boot and can issue
   tax invoices via ENV alone.
3. Removing the ENV fallback would require operators to set up the DB seller config BEFORE
   deploying, which increases deployment risk.
4. The ENV vars are already validated by `src/lib/env.ts` at boot.

If the owner decides to DROP env var support in a future cleanup: the change would be
confined to `src/lib/sellerConfig.ts` (remove the `|| env.SELLER_*` fallback lines) and
`src/lib/env.ts` (remove the `SELLER_*` entries from `EnvSchema`). That is a one-file pair
change that can be done as a separate plan/commit.

Until explicitly approved otherwise, **this plan implements KEEP.**

---

## 15. Migration Safety Notes

- Migration is ADDITIVE only. No DROP, no ALTER of existing columns.
- The singleton row (id="singleton") already exists in prod after `20260621150000_shop_settings`.
  The `ALTER TABLE ADD COLUMN` adds nullable columns with no default → existing rows get NULL.
  No data loss.
- `prisma migrate deploy` (used in the prod Docker `migrate` image) applies it automatically
  on next deployment.
- Rollback: if needed, the 7 columns can be dropped without affecting any other model or data.

---

## 16. Out of Scope

- Removing `SELLER_*` ENV vars (see Decision D1 — recommendation: KEEP)
- `TaxInvoiceDocument` A4 layout changes (seller phone/posId are NOT §86/4 mandatory; the A4
  doc is not modified in this plan)
- Logo / email fields (explicitly excluded by owner)
- Multi-branch seller profiles (out of scope; `branchId` / multi-branch is a separate program)
- Real auth (server-side RBAC) — `requireAdmin` is already enforced on PATCH; the client
  `AdminOnly` wrapper on `/settings` is the UI gate (consistent with all other admin pages)

---

## 17. Resume and Execution Handoff

**Selected plan file:** `process/general-plans/active/seller-company-settings_PLAN_24-06-26.md`

**Execute sequence:** Steps 1 → 13 in the Implementation Checklist (§9). No phase gates within
the session — this is a single-session SIMPLE plan. All 13 steps are safe to execute in order.

**Start point for EXECUTE:** Step 1 (`prisma/schema.prisma` — add 7 fields).

**Prerequisite state:**
- Local Postgres is running and accessible via `DATABASE_URL` in `.env`
- `npm install` is up to date (no new deps added by this plan)

**Verification gate before declaring DONE:**
- `npm run type-check` → zero errors
- `npm run build` → success
- Manual Scenario A (§11) — DB-primary seller config works end-to-end
- Manual Scenario E (§11) — tax-invoice null-refusal still fires when seller unset

**Reports path:** `process/general-plans/reports/`

**Context update after EXECUTE:** Update `process/context/all-context.md` Scan Metadata
date and the `ShopSettings` row in the database context table to note the 7 new seller fields.
Update `process/context/database/all-database.md` Models table for ShopSettings.

---

*Plan complete. No further creative decisions needed during EXECUTE.*

# Admin Receipt Print-Size Settings — REPORT

- Date: 2026-06-21 · Research: `receipt-settings_RESEARCH_21-06-26.md`. Feature: an admin sets the thermal-receipt print **width × height** in-app; printed receipts use it (was hardcoded `@page { size: 80mm auto }`).
- **Migration #10** `20260621150000_shop_settings`.
- Status: ✅ **type-check + build + e2e 14/14 + live smoke (RBAC, validation, persistence, cross-field) + 2-dim adversarial review (4 confirmed → 3 fixed, 1 positive-non-finding) — all verified.** Migration applied to dev DB.

## Decisions (= research recommendations)
LOCAL singleton `ShopSettings` DB model · height auto+fixed (default auto) · width preset 58/80 + free input (40–120mm) · dynamic `@page` via injected `<style>` before `window.print()` · seller identity stays ENV (separate).

## What was built
- **`ShopSettings` singleton** (`id @default("singleton")`): `receiptWidthMm @default(80)`, `receiptHeightAuto @default(true)`, `receiptHeightMm Int?`. Defaults = today's `80mm auto` (no behavior change). Seeded (idempotent upsert).
- **`GET /api/settings`** (requireUser — the cashier reads the size to print; upsert-on-read so it always exists) + **`PATCH /api/settings`** (requireAdmin; Zod `src/lib/schemas/shopSettings.ts` width 40–120, height 50–400; **all 3 fields = a full-settings save**, the UI always sends them; `auto=true` forces height null; cross-field guard: `auto=false` requires a height). `ShopSettingsDTO` in types.
- **Admin Settings screen** `(shell)/settings/page.tsx` (AdminOnly) — nav key `settings` (admin-only in NAV_ACCESS + NavRail + middleware `PROTECTED_PREFIXES`), a "เครื่องพิมพ์ · Printer" card: width preset chips (58/80) + free mm input; height Auto toggle + mm input; live preview; Save → PATCH. Taste language (Settings was in the Simple POS IA but had no mockup → built in the redesign language).
- **Dynamic print** `src/lib/receiptPrint.ts` — injects `<style id="receipt-page-size-dynamic">@media print { @page { size: ${w}mm ${h}; margin:4mm } .print-receipt { width:${w-8}mm } }</style>` before `window.print()`, removes after (afterprint + timeout). Built from VALIDATED INTEGERS (no injection). Wired into the POS print + the sales reprint. The 80mm globals.css default + the A4 tax-invoice named page are untouched/isolated.

## Verification (orchestrator — ephemeral Postgres + live server)
- type-check + build + **e2e 14/14** (nav + print-path changes don't break).
- migration #10 + seed singleton (w=80, auto=true).
- **RBAC:** GET (seller) 200 (defaults); PATCH (seller) → **403**; PATCH (admin) → 200 + persisted (w=58, h=200).
- **Validation:** width 200 (>120) → 400 VALIDATION; **cross-field** (complete body) `auto=false + height=null` → **400 VALIDATION**, `auto=false + height=200` → 200, `auto=true` → 200 (height nulled) — all confirmed.
- (The PATCH is a full-settings save: all 3 fields required, matching the Settings form. A partial PATCH 400s by design.)

## Adversarial review (2-dim) — 4 confirmed → 3 fixed
- **(MED) cross-field gap** — `auto=false + receiptHeightMm=null` passed Zod (heightMm nullable) → incoherent row. Fixed: `.superRefine()` rejects `auto=false` without a height.
- **(LOW) cold-load print race** — sales/POS could print at the 80mm default if settings hadn't loaded. Fixed: `printReceiptWithSize` now fetches `/api/settings` when its arg is null before printing, falling back to 80mm only if the fetch fails.
- **(LOW) cast tidy** — sales/POS GET-settings cast aligned to the real `{settings: ShopSettingsDTO}` shape.
- **(non-finding)** A4 tax-invoice path confirmed fully isolated from the injected `@page` (separate named page + separate print handler).

## Notes
- The injected-`@page` print mechanism is browser-print; the **actual printed paper size is best confirmed on a real device/printer** (Chromium/Edge/Safari reliable; Firefox/macOS has a known system-dialog caveat — non-critical for a Windows+Chromium thermal POS).
- `ShopSettings` is extensible (could later hold seller identity, currently ENV).

## User action (host dev)
Migration #10 applied to the dev DB. Restart `npm run dev`; the admin "ตั้งค่าร้านค้า" nav appears for admins → set receipt width/height; receipts print at the configured size. (Seller/cashier can read the size but not edit.)

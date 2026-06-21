# Admin Receipt Print-Size Settings — Research + Design

- Date: 2026-06-21 · feature: an admin can set the receipt print **width × height** from the app; the printed thermal receipt uses it. (Currently `@page { size: 80mm auto }` is hardcoded in `globals.css`.)

## Current state (cited)
- **Receipt print:** `src/app/globals.css` `@page { size: 80mm auto; margin: 4mm }` (hardcoded) + `.print-receipt { width: 72mm }`. The A4 tax invoice uses a SEPARATE named page (`@page tax-invoice { size: A4 portrait }` assigned via `page: tax-invoice` on the `.print-tax-invoice` element, toggled by `body.printing-tax-invoice`). `printReceipt()` (`pos/page.tsx`) is a bare `window.print()` — no dynamic style injection.
- **Nav/RBAC:** `NavRail.tsx NAV_ITEMS` + `roleAccess.ts NAV_ACCESS` (admin-only: data/products/users/docs). `requireAdmin()` exists. No `settings` key yet.
- **Design IA:** `design/Simple POS.dc.html:1804` lists `Settings · ตั้งค่า · สาขา · ภาษี · เครื่องพิมพ์ · ทั่วไป` as **admin-only**, but no mockup exists in either design file → build the screen in the Taste language (forest/mint, IBM Plex Sans Thai).
- **Settings precedent:** none — `ShopSettings` is new. Seller identity is ENV-based (`sellerConfig.ts`); kept separate for now.
- **Dynamic `@page`:** CSS variables do NOT resolve inside `@page` rules in any browser. The robust mechanism is to inject a `<style>` with the computed `@page { size: <W>mm <H> }` (+ `.print-receipt { width }`) into `<head>` before `window.print()`, then remove it (`afterprint`/timeout). Chromium/Edge/Safari reliable; Firefox/macOS has a known system-dialog caveat (non-critical for a Windows+Chromium POS).

## Design (decisions = recommendations)
- **`ShopSettings` model (singleton, `id @default("singleton")`):** `receiptWidthMm Int @default(80)`, `receiptHeightAuto Boolean @default(true)`, `receiptHeightMm Int?` (+ `createdAt/updatedAt`; extensible nullable slots for future seller fields — NOT populated now). Default matches today's `80mm auto` (no behavior change on deploy). Seed upserts the singleton. New migration.
- **API:** `GET /api/settings` + `PATCH /api/settings` — **requireAdmin**, Zod bounds `receiptWidthMm 40–120`, `receiptHeightMm 50–400` nullable, `receiptHeightAuto` bool; PATCH upserts the singleton (and nulls `receiptHeightMm` when `receiptHeightAuto=true`).
- **Admin UI:** new nav key `settings` (admin-only in NAV_ACCESS + NavRail, label "ตั้งค่าร้านค้า · Shop Settings", a Settings/SlidersHorizontal icon), route `/settings` (`(shell)/settings/page.tsx`). A "เครื่องพิมพ์ · Printer" card: width = preset chips (58 / 80) + free mm input (40–120); height = "อัตโนมัติ/Auto" toggle + mm input when fixed; a live "กว้าง 80mm × สูงอัตโนมัติ" preview; Save (brand). Taste language.
- **Apply at print:** `printReceipt()` (or ReceiptModal) reads the settings (fetched once) and injects `<style id="receipt-page-size-dynamic">@media print { @page { size: ${w}mm ${h}; margin:4mm } .print-receipt { width:${w-8}mm } }</style>` before `window.print()`, removes it after. The `globals.css` 80mm rule stays as the fallback default; the A4 tax-invoice named page is untouched (isolated).

## Decisions (recommendations)
- **D1 height:** BOTH auto + fixed (default auto).
- **D2 width:** presets (58/80) + free input, bounds 40–120mm.
- **D3 mechanism:** inject `<style>` before `window.print()` (CSS-var-in-@page doesn't work).
- **D4 storage:** singleton `ShopSettings` DB row for receipt size (extensible); keep seller identity in ENV for now.

## Sequencing (single pass)
Schema+migration+seed → `GET/PATCH /api/settings` (requireAdmin+Zod) → admin `/settings` page + nav/RBAC → ReceiptModal/printReceipt dynamic `@page`. Verify: type-check+build; live — admin saves width/height; non-admin 403; receipt print uses the configured size; A4 tax invoice + thermal default unaffected; e2e green.

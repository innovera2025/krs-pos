# Phase 6c Research — Design Spec docs hub (final sub-phase of P6)

- Date: 2026-06-21 (researched read-only by orchestrator; Agent tool was temporarily unavailable)
- Scope: the admin `/docs` screen — a pill **tab switcher + 10 static content panels**. **No API / no DB / no schema / no migration** — lowest-risk sub-phase. Closes P6. Then P7 (hardening) remains.
- Reconciliation: 6a (10) + 6b (45) + **6c (12)** = 67. The 12 = `screen-design-spec-hub` + `action-docs-tab` + 10 `display-docs-*` panels.

## 1. Current state
- `src/app/(shell)/docs/page.tsx` = placeholder card ("จะพัฒนาในเฟสถัดไป"). No state/tabs.
- **Reusable**: `AdminOnly` guard (P4 — /docs is admin-only per Simple POS `navAccess` `docs:['admin']`); the /data 4-tab **pill switcher** pattern; Taste tokens/fonts already in `globals.css` (IBM Plex Sans Thai/Mono, forest/mint/accent). NO API/DB/schema/seed/migration needed.
- Simple POS source: docs hub template = `design/Simple POS.dc.html` **lines 560–820**; data arrays = **lines 1794–1880**; tab list = line 1882.

## 2. Target — 10 panels (faithful reproduction; it's a DESIGN-SPEC document)
Pill tab switcher (`docTabs`, line 1882; active `#0f172a`/white, inactive white/`#64748b` border; `action-docs-tab`/setDocsTab). Tabs (key · TH · EN):
`overview·ภาพรวม·Overview` · `ia·โครงสร้าง IA·Sitemap` · `flows·User Flows·Flows` · `screens·รายการหน้าจอ·Screens` · `components·Components` · `tokens·Design Tokens` · `copy·UX Copy` · `rules·กฎ UX บัญชี·Rules` · `visual·2 แนว Visual·Visual` · `impl·Dev Notes`.

Panel-by-panel (template line → data):
1. **overview** (570–594, inline): dark hero card ("KRS — Simple POS …" + paragraph) + 3 pillar cards (ขายเร็วบนแท็บเล็ต / Sync queue กันล่ม / แยกเลข POS-บัญชี) + **6 design principles** (01 ขายมาก่อนบัญชีตามหลัง · 02 ห้ามลบบิล · 03 สถานะบัญชีต้องมองเห็น · 04 error actionable · 05 MVP ไม่ใช่ ERP · 06 ต่อยอด multi-branch).
2. **ia** (597–621 ← `iaRows` 1794–1805): "Sitemap & สิทธิ์การเข้าถึง" + role legend (Cashier green / Owner blue / Accountant-Admin purple) + **10 rows** (POS/Checkout, Sales History, Products, Inventory, Customers, Shift Close, Reports, KRS Data Link, Users & Roles, Settings) each with subs + 3 role-access dots (on/off color).
3. **flows** (624–639 ← `flowRows` 1806–1813): "Key user flows" + **6 flow cards** (tag CASHIER/DATA/ADMIN + colored chip + step chain with arrows): เริ่มกะ→ขาย→รับเงิน · ส่งข้อมูลเข้า KRS · ปิดรอบขาย · เชื่อม KRS · คืนเงิน/ยกเลิก · แก้ sync ที่ล้มเหลว.
4. **screens** (642–662 ← `screenGroups` 1814–1832): "Screen list (MVP)" + **4 groups** (A·POS Core green, B·KRS Data Link blue, C·Inventory teal, D·Reporting/Admin purple); ~9 screen cards each w/ name·purpose·user + Components / Actions / States lines.
5. **components** (665–677 ← `componentRows` 1833–1847): "Component inventory" + **13 rows** `<Name/>` + mono prop signature (ProductCard, CartItem, PaymentMethodButton, ReceiptPreview, SyncStatusBadge, ShiftSummaryCard, SyncJobTable, MappingTable, TaxBadge, RefundDialog, VoidConfirmDialog, CashCountingPanel, ErrorResponsePanel).
6. **tokens** (680–711 ← `tokenColors` 1854–1863, rest inline): "Design tokens" — **8 color swatches** (Navy/Green/Blue/Teal/Amber/Red/Slate/Surface w/ hex+use) + Typography demo (IBM Plex Sans Thai; ฿ display / title / body / mono) + Spacing (4·8·12·16·20·24) / Radius (8·11·14) / Shadow (`0 6px 18px rgba(15,23,42,.10)`) / Hit target ≥44px.
7. **copy** (714–729 ← `copyGroups` 1848–1853): "UX copy — ไทย/English" + **4 groups** (ปุ่ม·Buttons 9 pairs, สถานะ·Status 6, ข้อความ Error 5, ยืนยัน·Confirm 2) — TH/EN 2-col rows.
8. **rules** (732–742 ← `ruleRows` 1864–1872): "Accounting UX rules" + **7 rows** (icon tile + TH + EN): show doc-no on sync success · error+retry on fail · synced bills locked · refund via credit-note · warn before tax-invoice w/o tax info · block sync when mapping incomplete · POS keeps selling when accounting down.
9. **visual** (745–802, inline): "2 แนวทาง Visual — POS Checkout" — **2 direction cards** (1·Clean modern SaaS [prototype base] + 2·Friendly small-business) each w/ 5-swatch palette + Type/Radius/Spacing/Icon/Tone + a mini-mock; + blue recommendation banner (use Direction 1, borrow warmth from 2 for cashier).
10. **impl** (805–815 ← `implRows` 1873–1880): "Implementation notes (frontend)" — **6 cards** title+body: sync-queue architecture (IndexedDB/backoff) · split posNo vs accountingDocNo · idempotency key · state-machine statuses · no destructive delete · multi-branch branchId.

## 3. Exact 6c function list (12)
`screen-design-spec-hub`, `action-docs-tab`, `display-docs-overview-panel`, `display-docs-ia-matrix`, `display-docs-flows-panel`, `display-docs-screen-list`, `display-docs-component-inventory`, `display-docs-tokens-panel`, `display-docs-copy-panel`, `display-docs-rules-panel`, `display-docs-visual-directions`, `display-docs-impl-notes`. → 6a 10 + 6b 45 + 6c 12 = **67** ✓.

## 4. Decisions (minimal)
| # | Gap | Recommendation |
|---|---|---|
| A | static vs data-driven | **static** const arrays in a `docsContent.ts` + per-panel render (mirrors Simple POS data shape); no API/DB |
| B | content source for "live" panels (tokens/components/screens/IA) | **reproduce Simple POS's design-spec content faithfully** — the docs hub is a *design document*, not a live mirror. Some entries are aspirational/production-readiness (impl: IndexedDB queue, idempotency; components: CartItem vs the built CartLine, CustomerSelector vs CustomerPickerModal). Keep them as the documented spec; do NOT rewrite to current code. (Optional: a one-line "spec — some items are roadmap" note.) Don't drop any panel/row. |
| C | file structure | one `(shell)/docs/page.tsx` (`"use client"` for the tab state, `AdminOnly`-wrapped) + `src/components/docs/*` per-panel components + `docsContent.ts` static data |
| D | tokens panel honesty | the Taste palette differs slightly from Simple POS's navy/green (Taste = forest/mint). Reproduce Simple POS's token table as the spec; this is acceptable (design-spec doc). |

## 5. Files
- **Rewrite** `src/app/(shell)/docs/page.tsx` (AdminOnly + pill tabs + panel switch).
- **New** `src/components/docs/{OverviewPanel,IaPanel,FlowsPanel,ScreensPanel,ComponentsPanel,TokensPanel,CopyPanel,RulesPanel,VisualPanel,ImplPanel}.tsx` (or fewer files with sections) + `src/components/docs/docsContent.ts` (the static arrays from lines 1794–1880).
- **No** API / seed / schema / migration. Reuse globals.css tokens; do not modify shared globals/NavRail.

## 6. Risks
1. **Completeness** — 10 panels, don't drop one (esp. the data rows: ia 10, flows 6, screens 9, components 13, copy 22 pairs, rules 7, tokens 8, impl 6). 2. **Don't over-correct** the spec to current build (it's a documented design; faithful repro). 3. **Admin-only** — must wrap in `AdminOnly` (seller → redirect /pos). 4. Large static authoring — Taste-port the styling (forest/mint, IBM Plex) rather than copy Simple POS's navy inline styles verbatim. 5. Don't regress shared `globals.css`/NavRail (this is /docs-only).

## 7. Readiness + recommendation
**Ready for EXECUTE — static, lowest-risk, no consequential decisions.** Recommend **Full faithful**: reproduce all 10 panels + every data row from `design/Simple POS.dc.html` (template 560–820, data 1794–1880), ported into the Taste visual language, `/docs` wrapped in `AdminOnly`. This closes Phase 6 (165/165 functions) and leaves only P7 (hardening/QA).

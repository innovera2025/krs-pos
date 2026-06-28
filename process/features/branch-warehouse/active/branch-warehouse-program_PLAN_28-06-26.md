# Branch / Warehouse-per-User — Program Plan

**Created:** 28-06-26 · **Type:** multi-phase program · **Status:** Phase 1+2 in progress

## Goal (owner)
(a) Assign a **Branch + Warehouse** when creating/editing a user (editable).
(b) On **login**, the POS is scoped to that user's branch — a sale's BranchCode/Warehouse come from the user.
(c) Show **stock balance per branch/warehouse** — the product "หมด"/stock badge reflects the logged-in user's warehouse.

## Locked decisions (owner-approved 28-06-26)
- **D1** Per-warehouse stock = NEW additive `WarehouseStock` table {productId/sku, warehouseCode, qty}; `KrsStockSnapshot` → composite PK (itemCode, warehouseCode). **Keep `Product.stock` global as fallback.**
- **D2** **One warehouse per user** (`User.warehouseCode`); branch is DERIVED from the Warehouse table (WH→branch is 1:1 in KRS). No login-time picker.
- **D3** **Pull the KRS `Warehouse` table into a POS `Warehouse` model** (mirrors product pull) + seed WH01–WH04 fallback.
- **D4** Stamp `warehouseCode` + derived `branchCode` onto the JWT at sign-in (mirrors tokenVersion/role); ~10s revalidate window accepted.
- **D5** Keep global `Product.stock` as fallback (per-warehouse supplements, not replaces).
- **Stock scope = DISPLAY-ONLY** → Phase 6 (warehouse oversell guard) is **OUT OF SCOPE**; checkout keeps the global decrement/guard.

## ⚠️ ID namespaces (never conflate)
POS `branchId='BR-01'` (internal stub) · KRS `WarehouseCode='WH01–WH04'` · KRS `BranchCode='00000–00004'`.
**User.warehouseCode stores the KRS WarehouseCode; branchCode is derived via the Warehouse table.**

## ⛔ Vendor blocker (gates Phase 4 only)
Does KRS `InventoryFlow.DeptCode='WHE'` vary per warehouse, or is it shared by all four? Confirmed only for WH01. Needed before the writeback can be parameterized per-warehouse (writeback is LIVE — wrong DeptCode = corrupt ERP).

## Phases (low→high risk; each independently shippable)
| # | Phase | Risk | Status |
|---|-------|------|--------|
| 1 | Warehouse master (POS `Warehouse` model + KRS pull + seed + GET) | low | IN PROGRESS |
| 2 | User ↔ Warehouse assignment (create/edit UI+API; req a) | low | IN PROGRESS |
| 3 | Session carries warehouseCode + derived branchCode (JWT/session plumbing; req b) | medium | pending |
| 4 | Sale + KRS docs scoped to user's branch/warehouse (req b) — GATED on vendor DeptCode; run pricing-tester | medium | pending |
| 5 | Per-warehouse stock storage+sync+**display** ("หมด" per warehouse; req c) — DISPLAY-ONLY | high | pending |
| ~~6~~ | ~~Warehouse oversell guard at checkout~~ | ~~high~~ | **out of scope (display-only)** |

## Phase 1 — touchpoints
- NEW Prisma `Warehouse { warehouseCode @id, warehouseName, branchCode, createdAt, updatedAt }` + additive migration.
- NEW `src/lib/krs/warehouses.ts` (read `SELECT WarehouseCode, WarehouseName, BranchCode FROM dbo.Warehouse`, mirror products.ts).
- NEW `src/lib/krs/importWarehouses.ts` (upsert by warehouseCode, mirror importProducts.ts).
- NEW `POST /api/krs/pull-warehouses` (requireAdmin, uses the configured INBOUND KrsConnectionSettings like pull-products) + `GET /api/warehouses` (list for picker).
- Seed WH01–WH04 in `prisma/seed.ts` (fallback): WH01/คลังปัตตานี/00000, WH02/คลังยะรัง/00002, WH03/คลังสุไหงโก-ลก/00003, WH04/คลังเขต8หาดใหญ่/00004.
- "ดึง Warehouse จาก KRS" button on the /data Connection tab (mirror the "ดึงสินค้า" button).

## Phase 2 — touchpoints
- `User.warehouseCode String?` (nullable, additive) + migration.
- POST /api/users + the PATCH route: accept `warehouseCode`; add to `USER_PUBLIC_SELECT` + `UserDTO`.
- Warehouse picker in `AddUserModal` (options from GET /api/warehouses); edit affordance + label in the users page 'สาขา' column.

Verify gate each phase: `npm run type-check` + `npm run build`. Phase 4/6 also `pricing-tester`.

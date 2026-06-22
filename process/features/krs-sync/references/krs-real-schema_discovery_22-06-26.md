# KRS Real Schema Discovery (Gate 6 — live introspection)

- Date: 2026-06-22 · Read-only introspection of the REAL KRS SQL Server (`43.229.134.162\SQLEXPRESS,1433`, db `db_ACC_SNP`, user `sa`) from the orchestrator. **Connection layer (P1) VERIFIED against the real server** (TCP 1433 reachable; no-TLS connect 284ms; TLS+trust-self-signed connect 175ms; SQL auth `sa` valid). Instance listens on static 1433 → host+port works, no `instanceName` needed.

## CRITICAL finding — KRS is a full accounting ERP, not a simple sales DB
`db_ACC_SNP` has **238 base tables** in a header/detail (Hdr/Dtl) accounting-ERP layout (Thai ERP; GL + AR/AP + inventory + purchasing + payroll-ish modules). **NONE** of the P0/P1 assumed mock table names exist:
- allow-list checked → `sales`, `sale_items`, `stock_movements`, `products`, `price_list`, `stock_balance`, `customers` = **all NOT FOUND**.
- ⇒ the app's hardcoded introspection allow-list (`src/lib/krs/client.ts INTROSPECT_TABLES`) returns EMPTY against the real DB; the P0 conceptual mapping (sale→sales/sale_items, stock→stock_movements) does NOT map to reality.

## Real candidate tables (the actual integration targets)
- **Sales documents:** `SalesInvoiceHdr` (151 cols) / `SalesInvoiceDtl` (58) · `SalesInvoice2Hdr` (148)/`Dtl` (58) · `SalesOrderHdr` (118)/`Dtl` (63) · `SalesReturnHdr` (69)/`Dtl` (37) · `SalesCNHdr` (28)/`Dtl` (15) [credit note] · `SalesConcluHdr`/`Dtl` · `ReceiptHdr`/`Dtl` (payments) · `SalePurchaseTax` (21) · `TaxAndDiscount`.
- **Inventory / stock:** `InventoryItem` (101) [item master] · `InventoryFlowHdr` (75)/`Dtl` (71) · `InventoryLedgers` (7) · `InventoryType` · `tbl_STOCKAVG`/`tbl_StockFiFo`/`tbl_STOCKSTD` · `MeasurementUnits` · `Location`/`shelf`.
- **Customer:** `Customer` (77) · `CustomerItemPrice` · `tbl_CustAddr`.
- **Doc numbering:** `RunningNumber`, `tbl_RunnoItem`. · **GL:** `GeneralJournalHdr`/`Dtl`, `AccountChart`. · **Master:** `Branch`, `Company`, `Currency`, `Employee`, `kuser`. · Audit-ish: `krs_log`.

## Implications for P2 (re-scope — DO NOT guess)
1. Writing a POS sale into a live accounting ERP is **far higher-stakes** than the mock assumed: `SalesInvoiceHdr` has 151 columns (customer FK, branch, running number, GL accounts, tax codes, many required/derived fields) and is GL-linked. A wrong/partial INSERT can **corrupt the books** (unbalanced GL, bad tax, broken running numbers).
2. The **integration path must come from the accounting side / KRS vendor**, not be reverse-engineered: (a) WHICH document does a POS sale become — `SalesInvoiceHdr/Dtl`? `SalesInvoice2`? a daily-summary? (b) Is there a **supported import interface** (staging/import table, stored procedure, or API) rather than direct transactional-table INSERTs? (c) required columns + defaults + the `RunningNumber` scheme + item-code mapping (POS product → `InventoryItem` code) + customer mapping + tax/branch codes. (d) refund/void → `SalesReturn` or `SalesCN`. (e) stock → `InventoryFlow` vs let the sales doc post stock automatically.
3. **P1 follow-up (small):** update `INTROSPECT_TABLES` to the real candidate tables so the in-app Schema view is useful (was returning empty).

## Open questions for the owner / accounting team (gates P2 mapping)
- How does KRS currently RECEIVE external/POS sales today (manual entry? an import? which document)? Is there a vendor-supported integration interface?
- Which sales document type should a POS bill create, and does it auto-post GL + stock, or must we also write inventory/GL?
- The exact required-column set + running-number rule for that document (needs the KRS vendor or a sample row).

## Note
Introspection was READ-ONLY (INFORMATION_SCHEMA only); nothing was written to `db_ACC_SNP`. Column-level mapping deferred until the document-type / import-interface decision (avoid dumping 100s of ERP columns prematurely).

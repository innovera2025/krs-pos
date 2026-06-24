# KRS Outbound Write-Back — Field Analysis (cash sale → SalesInvoice + InventoryFlow)

**Date:** 24/06/2026 · **Feature:** krs-sync (Phase 2 outbound) · **Status:** ANALYSIS (vendor INSERT spec received; gaps → round-2 spec request)
**Source:** vendor-provided INSERT statements for "ยืนยันชำระเงิน (ขายสด) + ตัด Stock". Pairs with `krs-writeback-spec-request_23-06-26.md` (round 1) and `krs-writeback-spec-request-round2_24-06-26.md` (round 2 — the remaining questions).

---

## 1. The cash-sale write flow (5 INSERTs, ONE transaction)

On POS payment confirmation (cash sale), KRS records the sale as **5 inserts** sharing a `TransactionNo`:

```
1. RunningNumber(Name, Number)        → next document number(s)
2. SalesInvoiceHdr (~70 cols)          → sale header: revenue / AR / VAT / payment / GL journals
3. SalesInvoiceDtl  (~21 cols)         → one row per line item
4. InventoryFlowHdr (~25 cols)         → stock-movement header
5. InventoryFlowDtl (~24 cols)         → one row per line stock-out  ← sp_Onhand READS this table
```

Linking: all rows share `TransactionNo`; the inventory side cross-refs the sale via
`InventoryFlowHdr.SalesInvoiceTrNo / SalesInvoiceNo` and the sale side via
`SalesInvoiceDtl.FlowNo / FlowTrNo`.

**Two confirmations:**
- The statements use **bound parameters** (`?xTransNum`, `?cVATAmount`, …) → injection-safe, fits our `mssql` client directly.
- `InventoryFlowDtl` is the SAME table `dbo.sp_Onhand` aggregates (`InOut * MainQuantity` where `Approved=1 AND IsClosed<>1`). So a sale stock-out written here is immediately visible to our inbound reconcile — the loop closes. **Therefore `InventoryFlowDtl.Approved` must be `1` and `IsClosed` `0/<>1` or the cut won't count.**

---

## 2. Field categories

- **✅ HAVE** — POS already has the value (Order / OrderItem / PaymentLine / Product / Customer / ShopSettings seller config).
- **🔧 DERIVE** — a constant or simple computation for a cash sale.
- **⚙️ CONFIG/CONSTANT** — a KRS code/enum or org constant we must be TOLD once (then store as config).
- **📒 GL JOURNAL** — accounting posting string / account code; POS has no chart of accounts → vendor must specify format + codes (or KRS computes).
- **❓ UNKNOWN** — semantics unclear; ask vendor.

### SalesInvoiceHdr
| Field(s) | Category | POS source / value |
|---|---|---|
| TransactionNo, VoucherNo | ❓/⚙️ | from RunningNumber — who/format? |
| VoucherDate, DueDate | ✅/🔧 | `Order.createdAt`; DueDate = VoucherDate (cash) |
| InvoiceType, SaleType, ItemType, TransactionTypeI/T, DocuType | ⚙️ | KRS codes for "cash sale" — **need values** |
| CompanyCode, DeptCode, Department, AccountCode | ⚙️ | org constants — **need values** |
| CustOrSuppCode/Name/Address | 🔧 | `Customer.*` or walk-in default ("เงินสด"); cash-customer code? |
| IsVAT, IsPaid | 🔧 | 1, 1 (cash paid) |
| IsClosed | ❓ | open vs closed for a paid cash sale? |
| Currency, ExchangeRate, TermsofPayment, Paymentinday, CreditLimit | 🔧 | THB, 1, cash, 0, 0 |
| TotalAmount, AmountDue, AmountDueBht | ✅ | `Order.total` (incl VAT) |
| SubTotalAmnt, VATForValue | ✅ | `Order.subtotal` (ex VAT) |
| VATAmount, VATPercent | ✅ | `Order.tax`, 7 |
| DiscountAmount, DiscountPercent | ✅ | `Order.discount`, (0 / computed) |
| TotalMainQty | ✅ | Σ `OrderItem.quantity` |
| CashValue | ✅ | `Order.amountPaid` (cash) |
| TotalCQ, TotalTF, TotalREC, OthExp, BankFree, TotalDR, OthRec, CqValue, TransFerValue | 🔧 | 0 (cash-only sale) |
| TotalCR, ARAPJnl, VATJnl, DiscountJnl, AccountsDescription, ChargeOrDiscountAccount, DiscountAccount | 📒 | GL journals — **need format + account codes** |
| TaxAccount, TaxPercen, WithHoldValue | 📒/🔧 | WHT = 0 (retail); TaxAccount code? |
| VATForValue, DepositAmount, IsUndueVAT | 🔧/❓ | deposit 0; IsUndueVAT 0? confirm |
| SalePerson, SaleName, EntryBy | ✅ | cashier (User) |
| BranchCode, BranchName | ✅ | **ShopSettings seller config** (just shipped) |
| Remarks | 🔧 | `Order.orderNumber` (trace + idempotency anchor) |
| EntryDate | — | KRS `GETDATE()` |

### SalesInvoiceDtl (per OrderItem)
| Field(s) | Category | POS source / value |
|---|---|---|
| TransactionNo | 🔧 | = Hdr TransactionNo |
| ItemOrder | 🔧 | line index 1..N |
| ItemCode | ✅ | `Product.sku` |
| Description | ✅ | `Product.name` |
| MainQuantity | ✅ | `OrderItem.quantity` |
| MainUnits | ⚙️/❓ | unit of measure — from KRS `InventoryItem`? which column? |
| UnitPrice, Amount | ✅ | `OrderItem.unitPrice`, `lineTotal` — **incl or ex VAT? confirm** |
| DiscountPercent, DiscountAmount | ✅ | per-line discount (`lineDiscountSatang`) |
| SourceType | ⚙️ | KRS code — **need value** |
| AccountCode, Currency | ⚙️ | constants |
| InventoryJnl, RevenueJnl, CostOfSaleJnl | 📒 | GL — revenue/inventory/COGS; **CostOfSaleJnl needs COST (POS has none)** |
| ForItemCode | ❓ | purpose? (usually blank) |
| OrderNo, OrderTrNo | ❓ | sales-order link (no SO in POS → blank?) |
| FlowNo, FlowTrNo | ❓ | link to InventoryFlow rows — how assigned? |

### InventoryFlowHdr
| Field(s) | Category | POS source / value |
|---|---|---|
| TransactionNo | ❓ | own number (linked) — from RunningNumber? |
| IsStock, IncludeVat | 🔧/❓ | 1 ; includeVat? |
| TransactionType, ReasonIndex, ReasonName | ⚙️ | "ตัดออกจากการขาย" codes — **need values** |
| Approved, IsClosed, IsAssetForm | 🔧 | **Approved=1, IsClosed=0** (so sp_Onhand counts), asset=0 |
| InOutDate, InOut | ✅/🔧 | `Order.createdAt`, `InOut = -1` (out) |
| SalesInvoiceTrNo, SalesInvoiceNo, SalesInvoiceDate | 🔧 | = the SalesInvoice just written |
| CompanyCode, DeptCode, Department, VoucherNo | ⚙️ | constants / RunningNumber |
| CustOrSupCode/Name/Address | 🔧 | customer / walk-in |
| Remark, RequestBy, EntryBy | 🔧 | orderNumber / cashier |
| EntryDate | — | `GETDATE()` |

### InventoryFlowDtl (per OrderItem) — THE stock cut
| Field(s) | Category | POS source / value |
|---|---|---|
| TransactionNo, Number | 🔧 | = Hdr ; line index |
| ItemCode | ✅ | `Product.sku` |
| Description | ✅ | `Product.name` |
| MainQuantity, MainUnits | ✅/❓ | `OrderItem.quantity` ; unit ❓ |
| InOut | 🔧 | -1 (out) |
| Warehouse | ⚙️ | **`WHFG`? confirm** |
| Approved, IsClosed, IsStock, IsAssetForm | 🔧 | **Approved=1, IsClosed=0** (critical for sp_Onhand), 1, 0 |
| TransactionType, ReasonIndex, ReasonName | ⚙️ | codes |
| SONo, SOTrNo, ForItemCode | ❓ | SO link / blank |
| LotNo | ❓ | lot tracking — needed? blank? |
| CompanyCode, Department, VoucherNo | ⚙️ | constants |
| RemarkDTL | 🔧 | orderNumber |

---

## 3. What POS can supply vs what's missing

**POS already has (~70%):** all line data (sku/name/qty/unitPrice/lineTotal/per-line discount), all header money (total/subtotal/VAT/discount/cash paid/qty totals), dates, cashier, branch (seller config), order number (trace/idempotency), and the sale-vs-reversal direction (`Order.status`).

**Missing / blocked (→ round-2 spec request, 11 items):**
1. **GL journal strings (`*Jnl`) + account codes** (cash 1010 / revenue 4000 / output-VAT / inventory 1510 / COGS 5000) — POS has no chart of accounts. POS-supplied or KRS-computed?
2. **COGS / item cost** — `CostOfSaleJnl` needs cost; POS stores only `Saleprice1` (no cost). KRS computes COGS itself?
3. **Constant codes:** InvoiceType, SaleType, ItemType, TransactionType(I/T), DocuType, SourceType, TransactionType, ReasonIndex/Name (sale + stock-out).
4. **RunningNumber:** the `Name` key(s) (SalesInvoice vs InventoryFlow), number format (e.g. `ORCM…`), and the safe-increment/lock pattern.
5. **TransactionNo** generation (links all 5 tables).
6. **Linkage fields:** SalesInvoiceTrNo/No, FlowNo/FlowTrNo, OrderNo/OrderTrNo, SONo/SOTrNo.
7. **Idempotency field** (anchor `orderNumber` where? `Remarks`?).
8. **Org constants:** CompanyCode, DeptCode, Department, AccountCode.
9. **Warehouse** code for sale stock-out (`WHFG`?).
10. **MainUnits** source + whether `UnitPrice`/`Amount` are incl or ex VAT.
11. **Sandbox** + a least-privilege write login — MANDATORY before any live write.

---

## 4. Recommended write approach (Phase 2, once gaps closed)

- On cash-payment confirm: create a `SyncJob` row **inside** the checkout Postgres `$transaction` (fail-open — never block the sale).
- A dispatcher executes the **5 INSERTs in ONE KRS mssql transaction** (parameterized, the vendor's `?` placeholders bind directly), idempotent on `orderNumber`.
- The `InventoryFlowDtl` write cuts stock → `sp_Onhand` reflects it → the existing inbound reconcile auto-verifies the outbound succeeded.
- **Do NOT write to the live ERP until verified on a vendor sandbox.**

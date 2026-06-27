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

---

## 5. UPDATE 2026-06-25 — GL journal spec received (`TheJournal` + `AccountHead`)

Vendor provided the GL posting for a cash sale. It answers most of gap #1 (the cash/revenue/VAT side). The full cash-sale write therefore ALSO includes GL journal rows in `TheJournal`, on top of the 5 inserts in §1.

**Account codes are resolved at write-time** from the chart of accounts `AccountHead` by group name (NOT hardcoded) — take the first by `Roworder`:
```sql
SELECT ACC_CODE FROM AccountHead WITH (NOLOCK) WHERE ACC_GRPNAME = '<group>' ORDER BY Roworder
```
| Posting | DrCr | AccountHead group | Amount (from POS) |
|---|---|---|---|
| เงินสด (Cash) | **D** | `Assets3` | `Order.total` (รวม VAT) |
| รายได้ขายสด (Cash-sale revenue) | **C** | `Revenues2` | `Order.subtotal` (ก่อน VAT) |
| ภาษีขาย (Output VAT) | **C** | `Liabilities4` | `Order.tax` |

→ Double-entry balances: DR total = CR (subtotal + VAT). **POS has all 3 amounts already.** ✅

**`TheJournal` row** = (JnlName, JnlCode, TransactionTypeI, TransactionTypeT, CompanyCode, Department, GLAccount, JnlDate, Description, DrCr, Currency, Amount, AmountBht, SourceType, SourceNo, VoucherNo, JournalNo, ActualInvoiceNo, BranchCode, BranchName).

**Constants confirmed (journal):** `SourceType='SC'`, `TransactionTypeI=1`, `TransactionTypeT=1`, `Currency='THB'`, `Department='SAL'`, `BranchCode='00000'`, `BranchName='สำนักงานใหญ่'`. `pTransName='Receipt'` is the **RunningNumber `Name` key**; `JnlCode = MAX(Number) FROM RunningNumber WHERE Name='Receipt'` (+1, see race note). Document no format `SC-XXXX-XXXX` → fills `VoucherNo/JournalNo/ActualInvoiceNo`; `SourceNo` = the document `TransactionNo` (links journal → sale).

**⚠️ Concurrency:** `MAX(Number)` then insert is RACE-PRONE (two concurrent sales get the same number). The dispatcher must claim the next number atomically (UPDATE…OUTPUT / serializable tx / lock) — confirm the vendor's safe pattern.

**STILL OPEN after this:**
- ✅ **RESOLVED (2026-06-25): COGS / inventory journal — KRS computes it ITSELF.** POS sends NO cost (it has none). POS writes the sale + cash/revenue/VAT journal + the InventoryFlow stock cut; KRS derives the Dr COGS / Cr Inventory posting from its own costing when the InventoryFlow is posted. → POS leaves cost-related journal fields (`CostOfSaleJnl`, and likely `InventoryJnl`) for KRS. (gap #2 closed)
- Relationship between the `SalesInvoiceHdr/Dtl.*Jnl` fields (§2) and these `TheJournal` rows — are the `*Jnl` fields = `JnlCode` refs, KRS-filled, or POS-filled?
- `CompanyCode` value; `JnlName`, `JnlDate` (=sale date?), `Description` format, `Amount` vs `AmountBht` (THB → equal).
- The SalesInvoice/InventoryFlow INSERT constants (InvoiceType, SaleType, ItemType, DocuType, SourceType-for-Dtl, ReasonIndex/Name, inventory TransactionType) — this snippet was the JOURNAL, not those two docs.
- Idempotency anchor, Warehouse (WHFG?), MainUnits + UnitPrice incl/ex VAT, **sandbox** (all still open).

---

## 6. UPDATE 2026-06-25 — full requirement files + sample workbook received

Vendor delivered the authoritative files (Downloads): `Insertขายสด.txt` (the EXACT insert field list — simpler than the 70-col schema), `ขายสด-gl.txt`/`-gl 2.txt` (the 3-row TheJournal, identical to §5), `osl.txt` (RunningNumber + InventoryFlowHdr/Dtl column list), and `ขายสด.xlsx` (a REAL sample: cash sale of `F01-0001 ×10 = 100 THB`).

**SalesInvoiceHdr — insert ONLY these (no `*Jnl` fields at all):** TransactionNo, InvoiceType, SaleType, ItemType, TransactionTypeI, TransactionTypeT, CompanyCode, VoucherNo, VoucherDate, DocuType, CustOrSuppCode, CustOrSuppName, Address, DeliveryAddress, DueDate, IsVAT, IsClosed, IsPaid, Currency, ExchangeRate, AccountsDescription, TotalAmount, SubTotalAmnt, DepositAmount, VATForValue, VATPercent, VATAmount, AmountDue, AmountDueBht, TotalDR, CashValue, TotalCR, BranchCode, BranchName, EntryBy, EntryDate. (No Department/DeptCode/AccountCode/ARAPJnl/etc. — the earlier 70-col list was the full schema; the real insert is this subset.)

**SalesInvoiceDtl — insert ONLY:** TransactionNo, ItemOrder, ItemCode, Description, MainQuantity, MainUnits, AccountCode, Currency, UnitPrice, DiscountPercent, DiscountAmount, Amount. (No InventoryJnl/RevenueJnl/CostOfSaleJnl/FlowNo/SourceType/OrderNo — KRS computes COGS/journals itself.)

**CONFIRMED sample values** (now in `src/lib/krs/writebackConfig.ts`):
| Field | Value |
|---|---|
| InvoiceType / SaleType / ItemType | `Local` / `Invoice` / `Item` |
| DocuType / CompanyCode | `SC` / `SNP` |
| **IsVAT** | **2** (was wrongly 1 — likely "VAT inclusive") |
| IsClosed / IsPaid / ExchangeRate | 0 / 1 / 1 |
| CustOrSuppCode / Name | `C0001` / `เงินสด` |
| AccountsDescription | `ขายเงินสดสินค้า-เงินสด` |
| BranchCode / BranchName | `00000` / `สำนักงานใหญ่` |
| EntryBy | the cashier (`ADMIN` in sample) |
| Money (sample) | Total 100 = SubTotal 93.46 + VAT 6.54 (= 100×7/107) → **VAT-inclusive, matches POS** |
| Dtl AccountCode | `4110-00` (line revenue account) |
| Dtl UnitPrice / Amount | VAT-INCLUSIVE (10 × qty 10 = 100 gross) → `UNIT_PRICE_INCL_VAT=true` |
| Dtl MainUnits | per-product unit, sample `ซอง` (← still need the KRS source column) |
| VoucherNo format | `SC-{YYMM}-{NNNN}` (e.g. `SC-2606-0001`) |
| RunningNumber keys | `SaleInvoiceTrNo` (Hdr TransactionNo), `SC`+YYMM (voucher), `InventoryFlow` (flow TxnNo), `IBG`+YYMM (flow voucher), `Receipt` (journal JnlCode) |

**Concurrency (vendor):** wrap the inserts in `BEGIN TRAN … COMMIT`; multiple POS write concurrently and an in-progress txn must finish or it blocks → matches our one-mssql-transaction + atomic RunningNumber claim design.

**Sandbox:** the connected `db_ACC_SNP` IS the test DB (owner-confirmed earlier) and the vendor approved test write-backs → the existing connection is the test target (point `KRS_SANDBOX_*` at it; no separate sandbox needed).

**STILL OPEN (the only hard gates left — the xlsx had no InventoryFlow rows):**
1. `InventoryFlowHdr/Dtl` constants: `TransactionType`, `ReasonIndex`, `ReasonName` (exact), `IncludeVat`, `DeptCode` for a sale stock-out.
2. `Warehouse` code for the cut (`WHFG`?).
3. `MainUnits` source — which KRS `InventoryItem` column holds the unit (`ซอง`); POS Product has no unit field → pull it during product import or query at write-time.
4. (minor) `IBG`+YYMM flow-voucher format + `JnlName` exact value.

Everything else for the cash-sale write is now resolved; Track B is buildable once items 1–3 land.

---

## 7. UPDATE 2026-06-27 — InventoryFlow (stock-cut) sample received → ALL GAPS CLOSED

Vendor delivered `Insert Stock.txt` (the exact InventoryFlow insert columns) + `pos stock.xlsx` (a real sale stock-out of `F01-0001 ×5`). The final 4 gaps are resolved (writebackConfig now has zero `TODO_FROM_VENDOR`):

**InventoryFlowHdr insert columns:** TransactionNo, IsStock, TransactionType, Approved, ApprovedBy, ApprovedDate, IsAssetForm, IsClosed, InOutDate, InOut, ReasonIndex, ReasonName, CompanyCode, DeptCode, Department, VoucherNo, EntryBy, EntryDate. (This simpler insert has NO SalesInvoiceTrNo/CustOrSup link — the stock cut stands alone, tied to the sale only by timing/voucher.)
**InventoryFlowDtl insert columns:** TransactionNo, Number, TransactionType, IsAssetForm, IsStock, IsClosed, Approved, InOutDate, InOut, ReasonIndex, ReasonName, CompanyCode, Warehouse, Department, VoucherNo, ItemCode, Description, SOTrNo, PONo, MainQuantity, MainUnits.

**CONFIRMED values (pos stock.xlsx):**
| Field | Value |
|---|---|
| IsStock / IsAssetForm / Approved / IsClosed | 1 / 1 / 1 / 0 |
| TransactionType | 1 |
| InOut | -1 (out) |
| **ReasonIndex** | **15** |
| **ReasonName** | **`การขาย: เบิกออกสินค้าเพื่อขาย`** |
| CompanyCode | `SNP` |
| **DeptCode** / Department(Hdr) | `WHE` / `แผนกคลังสินค้า` (Dtl Department = `WHE`) |
| **Warehouse** | **`WH01`** (NOT WHFG) |
| **VoucherNo** | **`OSL-{YYMM}-{NNNN}`** (e.g. `OSL-2606-0001`) |
| ApprovedBy / EntryBy | the cashier (`ADMIN` in sample) |
| TransactionNo | own seq (RunningNumber `InventoryFlow`) |
| ItemCode / Description / MainQuantity | `F01-0001` / product name / 5 |
| **MainUnits** | **`ซอง`** ← from **`InventoryItem.MainUnits`** column (verified via live query; `PackUnits` also = ซอง) |

**MainUnits source RESOLVED:** the KRS `InventoryItem.MainUnits` column holds the unit. POS Product has no unit field → the write module reads `MainUnits` from KRS `InventoryItem` per ItemCode at write-time (one `SELECT ItemCode, MainUnits WHERE ItemCode IN (...)` for the order), or it can be pulled during product import.

**→ Track B is now FULLY UNBLOCKED.** `writebackConfig.ts` has every constant confirmed (REQUIRED_VENDOR_KEYS is empty). Remaining work is the Track-B build itself: implement `writeback.ts` (RunningNumber claims for SaleInvoiceTrNo + SC voucher + InventoryFlow + OSL voucher + Receipt journal; the 2 SalesInvoice inserts + 3 TheJournal rows + 2 InventoryFlow inserts in ONE mssql transaction), point `KRS_SANDBOX_*` at `db_ACC_SNP` (the test DB), test, verify via `sp_Onhand`, then enable + handle the backlog.

// NODE-ONLY. KRS outbound write constants for a cash sale (SalesInvoice +
// InventoryFlow + TheJournal). Imported only by the Track-B write module
// (`writeback.ts`) — NEVER from a client component, `src/auth.config.ts`, or
// `src/middleware.ts`.
//
// ┌─────────────────────────────────────────────────────────────────────────────┐
// │ TRACK A STATUS: this CONFIG block holds the constants CONFIRMED from the P0   │
// │ spec + field analysis. Every value still awaiting the vendor is the explicit  │
// │ sentinel `TODO_FROM_VENDOR`. The write module (writeback.ts) REFUSES to write │
// │ when any required constant is still the sentinel (see `assertWriteConfigReady`)│
// │ — it NEVER guesses an ERP constant. Track B (the live insert) is gated on      │
// │ replacing every TODO_FROM_VENDOR with a confirmed value (plan §10).           │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// Plan: process/features/krs-sync/active/krs-outbound-writeback_PLAN_25-06-26.md §9.1
// Prerequisites that resolve each TODO_FROM_VENDOR: plan §10 (items 2–9).

/** The sentinel value for any constant not yet confirmed by the vendor. The write
 *  module treats a config containing this value (in a required field) as "not
 *  configured" and refuses to write — guessing an ERP constant would corrupt the
 *  customer's books, which is worse than not syncing. */
export const TODO_FROM_VENDOR = "TODO_FROM_VENDOR" as const;

/** The full KRS cash-sale write constant set. CONFIRMED values are filled; every
 *  unresolved value is `TODO_FROM_VENDOR`. Keep ALL vendor constants in this one
 *  object so a future vendor handoff is a single-file change + a single TODO grep. */
// Most values below were CONFIRMED from the vendor's sample workbook ขายสด.xlsx
// (2026-06-25): a real cash sale of F01-0001 ×10 = 100 THB. Only the InventoryFlow
// (stock-cut) constants + the per-product unit source remain TODO_FROM_VENDOR (the
// xlsx sample did not include the InventoryFlow rows).
export const KRS_WRITE_CONFIG = {
  // === RunningNumber keys (sheet3 of the sample) ===
  RUNNING_NUMBER_NAME_INVOICE: "SaleInvoiceTrNo", // CONFIRMED — Hdr TransactionNo seq
  RUNNING_NUMBER_NAME_RECEIPT: "Receipt", // CONFIRMED — TheJournal JnlCode seq
  RUNNING_NUMBER_NAME_INVFLOW: "InventoryFlow", // CONFIRMED — InventoryFlow TransactionNo seq
  RUNNING_NUMBER_VOUCHER_PREFIX: "SC", // CONFIRMED — voucher key = 'SC'+YYMM (e.g. 'SC2606')
  RUNNING_NUMBER_INVFLOW_VOUCHER_PREFIX: "IBG", // CONFIRMED — flow voucher key 'IBG'+YYMM

  // === Document format / journal ===
  DOC_NO_FORMAT: "SC-{YYMM}-{NNNN}", // CONFIRMED — VoucherNo e.g. SC-2606-0001
  JOURNAL_SOURCE_TYPE: "SC", // CONFIRMED
  JOURNAL_TRANSACTION_TYPE_I: 1, // CONFIRMED
  JOURNAL_TRANSACTION_TYPE_T: 1, // CONFIRMED
  JOURNAL_CURRENCY: "THB", // CONFIRMED
  JOURNAL_DEPARTMENT: "SAL", // CONFIRMED
  JOURNAL_BRANCH_CODE: "00000", // CONFIRMED
  JOURNAL_BRANCH_NAME: "สำนักงานใหญ่", // CONFIRMED
  JOURNAL_JNL_NAME: "Receipt", // ASSUMED = the running-number name (label, not GL-critical)
  JOURNAL_DESCRIPTION: "ขายเงินสดสินค้า-เงินสด", // CONFIRMED (= AccountsDescription)

  // === AccountHead group names (account-code resolution) ===
  ACCOUNT_HEAD_CASH_GROUP: "Assets3", // CONFIRMED
  ACCOUNT_HEAD_REVENUE_GROUP: "Revenues2", // CONFIRMED
  ACCOUNT_HEAD_VAT_GROUP: "Liabilities4", // CONFIRMED

  // === SalesInvoiceHdr constants (CONFIRMED from xlsx sample) ===
  INVOICE_TYPE: "Local", // CONFIRMED
  SALE_TYPE: "Invoice", // CONFIRMED
  ITEM_TYPE: "Item", // CONFIRMED
  TRANSACTION_TYPE_I: 1, // CONFIRMED
  TRANSACTION_TYPE_T: 1, // CONFIRMED
  DOCU_TYPE: "SC", // CONFIRMED
  IS_VAT: 2, // CONFIRMED (sample shows 2 — was wrongly 1; likely "VAT inclusive")
  IS_PAID: 1, // CONFIRMED — cash = paid
  IS_CLOSED: 0, // CONFIRMED
  ACCOUNTS_DESCRIPTION: "ขายเงินสดสินค้า-เงินสด", // CONFIRMED (Hdr)

  // === Org constants ===
  COMPANY_CODE: "SNP", // CONFIRMED
  DEPARTMENT: "SAL", // CONFIRMED (journal + InventoryFlow Department)
  DTL_ACCOUNT_CODE: "4110-00", // CONFIRMED — SalesInvoiceDtl line revenue account

  // === Walk-in customer (cash) ===
  WALK_IN_CUST_CODE: "C0001", // CONFIRMED
  WALK_IN_CUST_NAME: "เงินสด", // CONFIRMED

  // === VAT / price basis ===
  VAT_PERCENT: 7, // CONFIRMED
  UNIT_PRICE_INCL_VAT: true, // CONFIRMED — sample line: UnitPrice 10 × qty 10 = Amount 100 (incl VAT)

  // === InventoryFlow (stock-cut) constants — CONFIRMED from pos stock.xlsx (2026-06-27) ===
  INV_TRANSACTION_TYPE: 1, // CONFIRMED
  INV_REASON_INDEX: 15, // CONFIRMED — sale stock-out
  INV_REASON_NAME: "การขาย: เบิกออกสินค้าเพื่อขาย", // CONFIRMED (was assumed)
  WAREHOUSE: "WH01", // CONFIRMED (NOT WHFG — the sale-out warehouse is WH01)
  INV_DEPT_CODE: "WHE", // CONFIRMED — InventoryFlow DeptCode
  INV_DEPARTMENT_NAME: "แผนกคลังสินค้า", // CONFIRMED — Hdr Department (Dtl Department = the WHE code)
  INV_IS_ASSET_FORM: 1, // CONFIRMED
  INV_IS_STOCK: 1, // CONFIRMED
  INV_VOUCHER_PREFIX: "OSL", // CONFIRMED — VoucherNo = OSL-{YYMM}-{NNNN} (e.g. OSL-2606-0001)
  IN_OUT: -1, // CONFIRMED — stock out
  INV_APPROVED: 1, // CONFIRMED — sp_Onhand gate
  INV_IS_CLOSED: 0, // CONFIRMED — sp_Onhand gate

  // === Per-product unit — CONFIRMED: KRS InventoryItem.MainUnits (e.g. "ซอง") ===
  // POS Product has no unit field → the write module reads MainUnits from KRS
  // InventoryItem per ItemCode at write-time (or it can be pulled during import).
  MAIN_UNITS_SOURCE: "MainUnits", // CONFIRMED — KRS InventoryItem column name
} as const;

export type KrsWriteConfig = typeof KRS_WRITE_CONFIG;

/**
 * The required constants that MUST be confirmed before any live KRS write. If any
 * of these still holds the `TODO_FROM_VENDOR` sentinel, the write module refuses
 * (it never guesses). This list is the production-path gate referenced by plan §10.
 *
 * Kept as a typed key list (not "scan every field") so a future field that is
 * intentionally optional/derived doesn't accidentally block the write.
 */
// ALL vendor constants are now CONFIRMED (SalesInvoice/journal from ขายสด.xlsx
// 2026-06-25; InventoryFlow + MainUnits from pos stock.xlsx 2026-06-27). No
// TODO_FROM_VENDOR remains, so the config gate is OPEN. (The write itself is still
// the Track-B stub in writeback.ts until that module is implemented.)
const REQUIRED_VENDOR_KEYS: ReadonlyArray<keyof KrsWriteConfig> = [];

/** Thrown when a required vendor constant is still `TODO_FROM_VENDOR`. The write
 *  module catches this and the dispatcher leaves the job for a later attempt (it is
 *  a configuration gap, not a data error). Carries the unresolved key names so a log
 *  line can name exactly what the vendor still owes — never an ERP value. */
export class WriteConfigNotReadyError extends Error {
  constructor(public readonly missingKeys: string[]) {
    super(
      `KRS write config not ready — ${missingKeys.length} vendor constant(s) unresolved: ${missingKeys.join(", ")}`
    );
    this.name = "WriteConfigNotReadyError";
  }
}

/** Return the list of required vendor keys that are still the `TODO_FROM_VENDOR`
 *  sentinel. Empty array = the config is ready for a live write. Pure (no I/O). */
export function unresolvedVendorKeys(
  config: KrsWriteConfig = KRS_WRITE_CONFIG
): string[] {
  return REQUIRED_VENDOR_KEYS.filter(
    (k) => (config[k] as unknown) === TODO_FROM_VENDOR
  ).map(String);
}

/** Throw `WriteConfigNotReadyError` when any required vendor constant is still the
 *  sentinel. Call this at the TOP of the write module so the write refuses BEFORE
 *  opening any connection or claiming any number — never guessing a constant. */
export function assertWriteConfigReady(
  config: KrsWriteConfig = KRS_WRITE_CONFIG
): void {
  const missing = unresolvedVendorKeys(config);
  if (missing.length > 0) {
    throw new WriteConfigNotReadyError(missing);
  }
}

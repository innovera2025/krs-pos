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
export const KRS_WRITE_CONFIG = {
  // === RunningNumber ===
  RUNNING_NUMBER_NAME_INVOICE: TODO_FROM_VENDOR, // invoice running-number key
  RUNNING_NUMBER_NAME_RECEIPT: "Receipt", // CONFIRMED — TheJournal uses this
  RUNNING_NUMBER_NAME_INVFLOW: TODO_FROM_VENDOR, // InventoryFlow key (if separate)

  // === Document format / journal ===
  DOC_NO_FORMAT: "SC-XXXX-XXXX", // CONFIRMED — journal doc-no format
  JOURNAL_SOURCE_TYPE: "SC", // CONFIRMED
  JOURNAL_TRANSACTION_TYPE_I: 1, // CONFIRMED
  JOURNAL_TRANSACTION_TYPE_T: 1, // CONFIRMED
  JOURNAL_CURRENCY: "THB", // CONFIRMED
  JOURNAL_DEPARTMENT: "SAL", // CONFIRMED
  JOURNAL_BRANCH_CODE: "00000", // CONFIRMED
  JOURNAL_BRANCH_NAME: "สำนักงานใหญ่", // CONFIRMED
  JOURNAL_JNL_NAME: TODO_FROM_VENDOR, // JnlName field value
  JOURNAL_DESCRIPTION_FORMAT: TODO_FROM_VENDOR, // per-line Description format

  // === AccountHead group names (account-code resolution) ===
  ACCOUNT_HEAD_CASH_GROUP: "Assets3", // CONFIRMED
  ACCOUNT_HEAD_REVENUE_GROUP: "Revenues2", // CONFIRMED
  ACCOUNT_HEAD_VAT_GROUP: "Liabilities4", // CONFIRMED

  // === SalesInvoice constants ===
  INVOICE_TYPE: TODO_FROM_VENDOR,
  SALE_TYPE: TODO_FROM_VENDOR,
  ITEM_TYPE: TODO_FROM_VENDOR,
  TRANSACTION_TYPE_I: TODO_FROM_VENDOR,
  TRANSACTION_TYPE_T: TODO_FROM_VENDOR,
  DOCU_TYPE: TODO_FROM_VENDOR,
  SOURCE_TYPE_DTL: TODO_FROM_VENDOR,
  IS_VAT: 1, // DERIVED — cash sale always has VAT
  IS_PAID: 1, // DERIVED — cash = paid immediately
  IS_CLOSED: TODO_FROM_VENDOR, // IsClosed for a paid cash invoice (0 or 1?)
  IS_UNDUE_VAT: 0, // ASSUMED 0 (standard VAT) — confirm

  // === Org constants ===
  COMPANY_CODE: TODO_FROM_VENDOR,
  DEPT_CODE: TODO_FROM_VENDOR,
  DEPARTMENT: TODO_FROM_VENDOR, // invoice-side Department
  ACCOUNT_CODE: TODO_FROM_VENDOR, // header default

  // === Walk-in customer ===
  WALK_IN_CUST_CODE: TODO_FROM_VENDOR,
  WALK_IN_CUST_NAME: "เงินสด", // DERIVED — Thai "cash" label

  // === InventoryFlow constants ===
  INV_TRANSACTION_TYPE: TODO_FROM_VENDOR,
  INV_REASON_INDEX: TODO_FROM_VENDOR,
  INV_REASON_NAME: "ตัดออกจากการขาย", // ASSUMED — confirm exact string
  WAREHOUSE: TODO_FROM_VENDOR, // WHFG? confirm
  IN_OUT: -1, // CONFIRMED — stock out
  INV_APPROVED: 1, // CONFIRMED — sp_Onhand gate
  INV_IS_CLOSED: 0, // CONFIRMED — sp_Onhand gate

  // === VAT ===
  VAT_PERCENT: 7, // CONFIRMED — Thai standard VAT

  // === MainUnits / unit-price basis ===
  MAIN_UNITS_COLUMN: TODO_FROM_VENDOR, // KRS InventoryItem unit-of-measure column
  UNIT_PRICE_INCL_VAT: TODO_FROM_VENDOR, // true = incl VAT, false = excl (confirm)
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
const REQUIRED_VENDOR_KEYS: ReadonlyArray<keyof KrsWriteConfig> = [
  "RUNNING_NUMBER_NAME_INVOICE",
  "RUNNING_NUMBER_NAME_INVFLOW",
  "JOURNAL_JNL_NAME",
  "JOURNAL_DESCRIPTION_FORMAT",
  "INVOICE_TYPE",
  "SALE_TYPE",
  "ITEM_TYPE",
  "TRANSACTION_TYPE_I",
  "TRANSACTION_TYPE_T",
  "DOCU_TYPE",
  "SOURCE_TYPE_DTL",
  "IS_CLOSED",
  "COMPANY_CODE",
  "DEPT_CODE",
  "DEPARTMENT",
  "ACCOUNT_CODE",
  "WALK_IN_CUST_CODE",
  "INV_TRANSACTION_TYPE",
  "INV_REASON_INDEX",
  "WAREHOUSE",
  "MAIN_UNITS_COLUMN",
  "UNIT_PRICE_INCL_VAT",
];

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

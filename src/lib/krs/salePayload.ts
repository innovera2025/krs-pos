// Shared SALE outbox payload contract (krs-sync P2). This module is TYPE-ONLY plus a
// pure builder + a pure runtime validator — it imports NO mssql driver and NO Prisma
// singleton, so it is safe to import from BOTH the checkout route (which builds the
// snapshot) and the dispatcher/write module (which consumes it). Keeping it separate
// from `writeback.ts` is deliberate: the checkout route must NEVER pull the mssql
// driver into its module graph.
//
// The snapshot captures ALL POS data the KRS write needs AT ENQUEUE TIME. The
// dispatcher reads ONLY this snapshot (never the live POS DB at dispatch time), so an
// order/product edit between checkout and dispatch can't change what is written to
// KRS (no stale read). Every money field is a Decimal STRING (e.g. "1234.50") — there
// is NO float/Number round-trip anywhere in the money path (plan §5.3).
//
// Plan: process/features/krs-sync/active/krs-outbound-writeback_PLAN_25-06-26.md §5.3

/** One line of a SALE snapshot. Money fields are 2dp Decimal strings. */
export type SalePayloadItem = {
  /** Product.sku → KRS ItemCode. */
  itemCode: string;
  /** Product.name → KRS Description. */
  description: string;
  /** OrderItem.quantity — a positive integer. */
  quantity: number;
  /** OrderItem.unitPrice as a 2dp Decimal string. */
  unitPrice: string;
  /** OrderItem.lineTotal as a 2dp Decimal string. */
  lineTotal: string;
  /** Per-line discount as a 2dp Decimal string (may be "0.00"). */
  lineDiscount: string;
};

/** The full SALE snapshot stored in `SyncJob.payload`. */
export type SalePayload = {
  /** e.g. "POS-20260625-0012" — the idempotency anchor + KRS Remarks value. */
  orderNumber: string;
  /** ISO-8601 instant of the sale (Order.createdAt) → KRS VoucherDate / InOutDate. */
  createdAt: string;
  /** Order.total as a 2dp Decimal string → SalesInvoiceHdr.TotalAmount. */
  total: string;
  /** Order.subtotal as a 2dp Decimal string → revenue journal line. */
  subtotal: string;
  /** Order.tax as a 2dp Decimal string → output-VAT journal line. */
  tax: string;
  /** Order.discount as a 2dp Decimal string. */
  discount: string;
  /** Order.amountPaid as a 2dp Decimal string → CashValue. */
  amountPaid: string;
  /** User.id of the cashier (SalePerson). */
  cashierId: string;
  /** User.name of the cashier (SaleName / EntryBy), or "" when unknown. */
  cashierName: string;
  /** Customer.id, or null for a walk-in. */
  customerId: string | null;
  /** Customer.taxId, or null (the write module substitutes the walk-in code). */
  customerCode: string | null;
  /** Customer.name, or null (the write module substitutes the walk-in name). */
  customerName: string | null;
  /** Customer.address, or null. */
  customerAddress: string | null;
  /** Branch code for all KRS docs — the cashier's warehouse→branch, defaulted to HQ "00000". */
  branchCode: string;
  /** Branch name for all KRS docs — the cashier's branch, defaulted to "สำนักงานใหญ่". */
  branchName: string;
  /** KRS WarehouseCode for the InventoryFlow stock-cut — the cashier's assigned
   *  warehouse, defaulted to HQ "WH01" (SALE_PAYLOAD_HQ_WAREHOUSE). */
  warehouseCode: string;
  /** Per-line snapshot. */
  items: SalePayloadItem[];
};

/** The HQ branch defaults used when the seller config is unset (so the KRS write
 *  never fails on a missing branch). Mirrors getSellerConfig's HQ defaults. */
export const SALE_PAYLOAD_HQ_BRANCH_CODE = "00000";
export const SALE_PAYLOAD_HQ_BRANCH_NAME = "สำนักงานใหญ่";
/** The HQ warehouse default used when the cashier has no assigned warehouse (e.g.
 *  admin), so the InventoryFlow stock-cut never fails on a missing warehouse. Mirrors
 *  the writeback config's WAREHOUSE default ("WH01"). */
export const SALE_PAYLOAD_HQ_WAREHOUSE = "WH01";

/**
 * Validate an `unknown` value (e.g. `SyncJob.payload` read back from the DB as JSON)
 * into a `SalePayload`. The dispatcher calls this at the input boundary so a
 * malformed/legacy payload is rejected with a clear error instead of crashing the
 * write module. Pure: no I/O. Returns the typed payload or throws `Error`.
 *
 * This is deliberately strict on the money/identity fields the KRS write depends on
 * and lenient only where the field is genuinely optional (customer* may be null).
 */
export function parseSalePayload(value: unknown): SalePayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("SalePayload is not an object");
  }
  const v = value as Record<string, unknown>;

  const str = (key: string): string => {
    const x = v[key];
    if (typeof x !== "string" || x.length === 0) {
      throw new Error(`SalePayload.${key} must be a non-empty string`);
    }
    return x;
  };
  const nullableStr = (key: string): string | null => {
    const x = v[key];
    if (x === null || x === undefined) return null;
    if (typeof x !== "string") {
      throw new Error(`SalePayload.${key} must be a string or null`);
    }
    return x;
  };

  if (!Array.isArray(v.items) || v.items.length === 0) {
    throw new Error("SalePayload.items must be a non-empty array");
  }
  const items: SalePayloadItem[] = v.items.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`SalePayload.items[${i}] is not an object`);
    }
    const it = raw as Record<string, unknown>;
    const istr = (key: string): string => {
      const x = it[key];
      if (typeof x !== "string" || x.length === 0) {
        throw new Error(`SalePayload.items[${i}].${key} must be a non-empty string`);
      }
      return x;
    };
    const qty = it.quantity;
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0) {
      throw new Error(`SalePayload.items[${i}].quantity must be a positive integer`);
    }
    return {
      itemCode: istr("itemCode"),
      description: typeof it.description === "string" ? it.description : "",
      quantity: qty,
      unitPrice: istr("unitPrice"),
      lineTotal: istr("lineTotal"),
      lineDiscount: typeof it.lineDiscount === "string" ? it.lineDiscount : "0.00",
    };
  });

  return {
    orderNumber: str("orderNumber"),
    createdAt: str("createdAt"),
    total: str("total"),
    subtotal: str("subtotal"),
    tax: str("tax"),
    discount: str("discount"),
    amountPaid: str("amountPaid"),
    cashierId: str("cashierId"),
    cashierName: typeof v.cashierName === "string" ? v.cashierName : "",
    customerId: nullableStr("customerId"),
    customerCode: nullableStr("customerCode"),
    customerName: nullableStr("customerName"),
    customerAddress: nullableStr("customerAddress"),
    branchCode: str("branchCode"),
    branchName: str("branchName"),
    // warehouseCode is parsed LENIENTLY (not via `str`, which would reject): a
    // legacy/in-flight SALE snapshot enqueued before this field existed has no
    // warehouseCode, and such a job must still dispatch. A missing/blank value falls
    // back to the HQ warehouse so the InventoryFlow stock-cut targets WH01 — matching
    // the pre-Phase-4 fixed behavior — instead of failing the whole write.
    warehouseCode:
      typeof v.warehouseCode === "string" && v.warehouseCode.length > 0
        ? v.warehouseCode
        : SALE_PAYLOAD_HQ_WAREHOUSE,
    items,
  };
}

// Shared VOID outbox payload contract (krs-void-writeback). Pure/type-only + a runtime
// validator — no mssql driver, no Prisma singleton. Mirrors salePayload.ts, so it is
// safe to import from BOTH the orders route (which builds the snapshot inside the void
// transaction) and the dispatcher (which consumes it at dispatch time).
//
// Plan: process/features/krs-sync/active/krs-void-writeback_PLAN_19-07-26.md §4

export type VoidPayloadItem = { itemCode: string; qty: number };

/** Best-effort doc numbers recovered from the original SALE SyncJob's stored
 *  `response` JSON, used as a FALLBACK when the KRS-side PosBillNo lookup in
 *  cancelSale.ts finds nothing (pre-16/17-07-26 bills lack PosBillNo in KRS). All
 *  optional — a crash-recovered SALE job's response may be `{transactionNo,
 *  recovered:true}` only (see krs-writeback-idempotency_PLAN_27-06-26.md
 *  Crash-Point Safety Table row 5), so saleVoucherNo/flowVoucherNo may be absent. */
export type VoidSaleRef = {
  transactionNo?: string;
  saleVoucherNo?: string;
  flowTxnNo?: string;
  flowVoucherNo?: string;
};

export type VoidPayload = {
  /** = the original sale's orderNumber; also the PosBillNo lookup key in KRS. */
  orderNumber: string;
  /** The original sale's KRS WarehouseCode — the stock-cut being reversed. Lifted
   *  from the original SALE SyncJob's own payload.warehouseCode (NOT the voiding
   *  admin's warehouse, which may differ). */
  warehouseCode: string;
  /** POS username/email performing the void → KRS InventoryFlowHdr.IsClosedBy. */
  requestedBy: string;
  /** ISO-8601 instant the void was requested. */
  requestedAt: string;
  /** Lines to restore into KrsStockSnapshot on success — lifted from the original
   *  SALE SyncJob's own payload.items (itemCode + quantity), not re-derived from
   *  live Product rows (sku could theoretically have changed since the sale). */
  items: VoidPayloadItem[];
  saleRef: VoidSaleRef;
};

/**
 * Validate an `unknown` value (e.g. `SyncJob.payload` read back from the DB as JSON)
 * into a `VoidPayload`. LENIENT like salePayload's parser: it throws ONLY on
 * structurally-unusable input (not an object, empty/missing items, a non-positive
 * qty, or a missing structural string like orderNumber/warehouseCode/requestedAt).
 * `requestedBy` and every saleRef field default leniently so a legacy/partial payload
 * still parses. Pure: no I/O.
 */
export function parseVoidPayload(value: unknown): VoidPayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("VoidPayload is not an object");
  }
  const v = value as Record<string, unknown>;
  const str = (key: string): string => {
    const x = v[key];
    if (typeof x !== "string" || x.length === 0) {
      throw new Error(`VoidPayload.${key} must be a non-empty string`);
    }
    return x;
  };
  if (!Array.isArray(v.items) || v.items.length === 0) {
    throw new Error("VoidPayload.items must be a non-empty array");
  }
  const items: VoidPayloadItem[] = v.items.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`VoidPayload.items[${i}] is not an object`);
    }
    const it = raw as Record<string, unknown>;
    const itemCode = it.itemCode;
    const qty = it.qty;
    if (typeof itemCode !== "string" || itemCode.length === 0) {
      throw new Error(`VoidPayload.items[${i}].itemCode must be a non-empty string`);
    }
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0) {
      throw new Error(`VoidPayload.items[${i}].qty must be a positive integer`);
    }
    return { itemCode, qty };
  });
  const rawRef = v.saleRef;
  const ref =
    typeof rawRef === "object" && rawRef !== null
      ? (rawRef as Record<string, unknown>)
      : {};
  const optStr = (key: string): string | undefined =>
    typeof ref[key] === "string" ? (ref[key] as string) : undefined;
  return {
    orderNumber: str("orderNumber"),
    warehouseCode: str("warehouseCode"),
    // LENIENT (mirrors salePayload.cashierName): a legacy/partial payload without
    // requestedBy still parses — it just writes a blank InventoryFlowHdr.IsClosedBy.
    requestedBy: typeof v.requestedBy === "string" ? v.requestedBy : "",
    requestedAt: str("requestedAt"),
    items,
    saleRef: {
      transactionNo: optStr("transactionNo"),
      saleVoucherNo: optStr("saleVoucherNo"),
      flowTxnNo: optStr("flowTxnNo"),
      flowVoucherNo: optStr("flowVoucherNo"),
    },
  };
}

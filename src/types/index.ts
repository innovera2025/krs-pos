export type Product = {
  id: string;
  name: string;
  sku: string;
  price: number;
  stock: number;
  barcode?: string | null;
  imageUrl?: string | null;
  isActive: boolean;
  categoryId?: string | null;
  category?: { id: string; name: string } | null;
};

export type CartItem = {
  product: Product;
  quantity: number;
  /**
   * Per-line item discount in **integer satang** (1 baht = 100 satang).
   * Stored in satang so cart math stays float-drift-free (see lib/pricing.ts).
   * Clamped client-side to [0, line gross].
   */
  lineDiscountSatang: number;
};

export type Category = {
  id: string;
  name: string;
};

/**
 * Stable category slug used to attach a Taste icon/gradient to a fetched
 * Category by name. The DB Category model only carries `name`, so the UI maps
 * name -> { slug, icon } (see components/pos/CategoryPanel). "all" is the
 * synthetic "show everything" chip; "other" is the fallback for unmapped names.
 */
export type CategorySlug =
  | "all"
  | "drink"
  | "food"
  | "dessert"
  | "goods"
  | "other";

/** Bill-level discount input mode for the ฿/% toggle. */
export type DiscountType = "amount" | "percent";

/**
 * The six POS tender methods (mirrors the Prisma PaymentType enum). Lowercase
 * keys are the UI/state representation; they are upper-cased at the API boundary.
 */
export type PayMethod =
  | "cash"
  | "transfer"
  | "qr"
  | "card"
  | "ewallet"
  | "other";

/**
 * One split-payment line in the payment modal.
 * `id` is a stable identity assigned at creation so the rendered list keys and
 * remove-by-id are index-independent (survives reorders/removals).
 * `amount` is the raw baht text as typed (mirrored so the field can be cleared).
 */
export type PayLine = {
  /** Stable identity assigned at creation (used for React keys + removal). */
  id: string;
  method: PayMethod;
  /** Baht as typed (string mirror). */
  amount: string;
};

/** A persisted PaymentLine as returned by the orders API. */
export type OrderPaymentLine = {
  id: string;
  method: string;
  amount: string | number;
  reference: string | null;
};

/** An order item as returned by the orders API (with product joined). */
export type OrderItemDTO = {
  id: string;
  quantity: number;
  unitPrice: string | number;
  lineTotal: string | number;
  product: { id: string; name: string; sku: string };
};

/**
 * Sale status (mirrors the Prisma OrderStatus enum). `VOIDED` was added in Phase
 * 5 — void ≠ cancelled in the POS domain. The Sales History UI surfaces
 * COMPLETED ("ชำระแล้ว"), REFUNDED, and VOIDED.
 */
export type SaleStatus =
  | "PENDING"
  | "COMPLETED"
  | "REFUNDED"
  | "VOIDED"
  | "CANCELLED";

/**
 * Sync lifecycle (mirrors the Prisma SyncStatus enum). Phase 5 stub field; the
 * real KRS sync state machine is Phase 6.
 */
export type SyncStatus = "PENDING" | "DAILY" | "SYNCED" | "FAILED" | "SKIPPED";

/**
 * A customer (member) as returned by GET /api/customers (Phase 6a). `taxId`
 * presence is what the UI keys "มีข้อมูลภาษี" / tax-invoice eligibility on.
 */
export type CustomerDTO = {
  id: string;
  name: string;
  taxId?: string | null;
  phone?: string | null;
  address?: string | null;
  branchId: string;
};

/** The order object returned by the orders API — drives the receipt + history. */
export type OrderDTO = {
  id: string;
  orderNumber: string;
  status: SaleStatus;
  subtotal: string | number;
  tax: string | number;
  discount: string | number;
  total: string | number;
  amountPaid: string | number;
  change: string | number;
  paymentType: string;
  // Phase 5 fields (sales history / sync / tax-invoice filter).
  syncStatus: SyncStatus;
  accountingDocNo?: string | null;
  taxRequested: boolean;
  shiftId?: string | null;
  // Phase 6a — customer linkage (null/undefined = walk-in / ลูกค้าทั่วไป).
  customerId?: string | null;
  customer?: CustomerDTO | null;
  createdAt: string;
  items: OrderItemDTO[];
  payments: OrderPaymentLine[];
  cashier?: { id: string; name: string } | null;
};

/**
 * KRS sync job kinds (mirrors the Prisma SyncJobType enum). Declared in Phase 6a
 * for the type surface; the /data KRS Data Link screen that renders them is 6b.
 */
export type SyncJobType =
  | "SALE"
  | "REFUND"
  | "STOCK"
  | "PULL"
  | "TAX_INVOICE"
  | "STOCK_ADJ"
  | "RECEIVE";

/** Sync job lifecycle (mirrors the Prisma SyncJobStatus enum). */
export type SyncJobStatus =
  | "PENDING"
  | "SYNCED"
  | "FAILED"
  | "RETRYING"
  | "SKIPPED";

/** Outbound (POS → KRS) vs inbound (KRS → POS) direction. */
export type SyncDirection = "INSERT" | "PULL";

/**
 * A sync job as serialized by the /api/sync-jobs API (Phase 6b). Declared now so
 * the request-tax flow + 6b UI share one shape. Money fields are 2dp strings.
 */
export type SyncJobDTO = {
  id: string;
  type: SyncJobType;
  direction: SyncDirection;
  ref: string;
  amount: string | number;
  status: SyncJobStatus;
  provider: string;
  error?: string | null;
  response?: string | null;
  branchId: string;
  createdAt: string;
};

/** A shift row as serialized by the shift API (money fields are 2dp strings). */
export type ShiftDTO = {
  id: string;
  shiftNumber: string;
  status: "OPEN" | "CLOSED";
  openedAt: string;
  closedAt: string | null;
  openingFloat: string;
  countedCash: string | null;
  cashierId: string | null;
  branchId: string;
};

/** One row of the by-payment-method Z-report breakdown. */
export type ZReportMethod = {
  method: string;
  label: string;
  count: number;
  amount: string;
};

/** Z-report aggregates for a shift (all money values are 2dp strings). */
export type ZReportDTO = {
  grossSales: string;
  txnCount: number;
  byMethod: ZReportMethod[];
  refundsTotal: string;
  discountsTotal: string;
  vatTotal: string;
  cashSales: string;
  cashRefunds: string;
  openingFloat: string;
  expectedCash: string;
};

/** The GET /api/shift payload: current shift + its Z-report (null if none). */
export type ShiftResponse = {
  shift: ShiftDTO | null;
  zReport: ZReportDTO | null;
};

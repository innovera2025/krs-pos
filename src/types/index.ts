export type Product = {
  id: string;
  name: string;
  sku: string;
  // Wire format from Prisma JSON: a Decimal serializes to a 2dp numeric STRING
  // (e.g. "59.00"), not a number. All consumers go through bahtToSatang/Number()
  // which accept a string, so this matches the real runtime shape (gap T1).
  price: string;
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
  // Buyer's RD branch designation for a full §86/4 tax invoice (Phase 4). 5-digit
  // RD branch code — "00000" = สำนักงานใหญ่. Defaulted to HQ in the schema.
  buyerBranchCode: string;
  branchId: string;
};

/**
 * Seller identity block for the A4 full tax invoice (Phase 4, §86/4). Mirrors
 * `SellerConfig` in src/lib/sellerConfig.ts (which reads it from env, NODE-only).
 * Declared here so the client document + the GET /api/seller-config fetch share
 * one shape without importing the NODE-only env module into the client bundle.
 */
export type SellerConfigDTO = {
  name: string;
  address: string;
  taxId: string;
  branchCode: string;
  branchLabel: string;
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
  // Tax-invoice ISSUE date (§86/4(7), FIX 1) — ISO string, serialized like other
  // dates via the Date → toJSON() pass in serializeOrder. Null for bills with no
  // tax invoice and legacy pre-FIX-1 rows; the A4 document falls back to createdAt.
  taxIssuedAt?: string | null;
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
  // `updatedAt` drives the "เวลา"/time column + drawer "อัปเดต" line — every
  // server action (retry/skip/pull/insert-all) advances it. Serialized by the
  // /api/sync-jobs API (Phase 6b).
  updatedAt: string;
};

/**
 * Per-status SyncJob counts for the Data Flow KPI cards + (potential) future
 * server aggregation. The /data screen derives these client-side from the fetched
 * job list; the shape is shared so a server count endpoint can reuse it later.
 */
export type SyncCountsDTO = {
  pending: number;
  synced: number;
  failed: number;
  retrying: number;
  skipped: number;
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

/**
 * Store-level receipt print-size settings (Receipt print-size feature). Mirrors
 * the `ShopSettings` singleton's receipt fields. Shared by GET /api/settings (read
 * by the cashier to size the printed receipt) and PATCH /api/settings (admin save)
 * and the Settings screen, so the client never imports the NODE-only Zod schema.
 *
 * `receiptWidthMm` is bounded 40–120 by the API; when `receiptHeightAuto` is true
 * `receiptHeightMm` is null (height = `auto`), otherwise it is the fixed mm value
 * (50–400). The print path computes the @page size from this shape.
 */
export type ShopSettingsDTO = {
  receiptWidthMm: number;
  receiptHeightAuto: boolean;
  receiptHeightMm: number | null;
};

/**
 * KRS connection settings as returned by GET /api/krs/settings (krs-sync P1).
 * `passwordSet` is true when an encrypted password is stored; the plaintext and
 * the ciphertext blob are NEVER returned (P0 spec §2.5). Shared by the GET/PATCH
 * routes and the Connection tab so the client never imports the NODE-only schema.
 */
export type KrsConnectionSettingsDTO = {
  host: string;
  port: number;
  database: string;
  username: string;
  passwordSet: boolean;
  ssl: boolean;
  /** Trust a self-signed KRS cert when SSL is on (on-prem-friendly; default true).
   *  Only meaningful when `ssl` is true. */
  trustServerCert: boolean;
  engine: string;
  syncMode: string;
};

/**
 * One reconciled item row from GET /api/krs/reconcile (krs-sync R1 stock
 * reconciliation): a POS product matched to its KRS on-hand balance (sp_Onhand) by
 * sku == itemCode. `krsStock` is the rounded/floored KRS balance (the baseline a
 * sync-stock import would write); `diff` = posStock − krsStock; `status` is "match"
 * when diff is 0, else "mismatch".
 */
export type KrsReconcileRowDTO = {
  sku: string;
  name: string;
  posStock: number;
  krsStock: number;
  diff: number;
  isActive: boolean;
  status: "match" | "mismatch";
};

/** A KRS on-hand item (from sp_Onhand) with no matching POS sku (มีใน KRS ไม่มีใน POS). */
export type KrsOnlyInKrsDTO = {
  itemCode: string;
  krsStock: number;
};

/** A POS product with no KRS on-hand row (มีใน POS ไม่มีใน KRS). */
export type KrsOnlyInPosDTO = {
  sku: string;
  name: string;
  posStock: number;
  isActive: boolean;
};

/** Roll-up counts for the reconcile dashboard summary cards. */
export type KrsReconcileSummaryDTO = {
  total: number;
  matched: number;
  mismatched: number;
  onlyInKrs: number;
  onlyInPos: number;
};

/** Full GET /api/krs/reconcile success payload (krs-sync R1). */
export type KrsReconcileDTO = {
  ok: true;
  rows: KrsReconcileRowDTO[];
  onlyInKrs: KrsOnlyInKrsDTO[];
  onlyInPos: KrsOnlyInPosDTO[];
  summary: KrsReconcileSummaryDTO;
  checkedAt: string;
};

/** POST /api/krs/sync-stock success payload (krs-sync R1 baseline import). */
export type KrsSyncStockResultDTO = {
  ok: true;
  updated: number;
  skipped: number;
  notInKrs: number;
  total: number;
};

/**
 * Status of a KRS inbound auto-pull run (krs-sync inbound auto-pull). Mirrors the
 * `AutoSyncStatus` union in src/lib/krs/autoSync.ts. Declared here (client-safe, no
 * NODE-only import) so the auto-sync API response + any future UI badge share one
 * shape.
 *  - OK / PARTIAL          — run completed (PARTIAL = one or more item writes failed)
 *  - SKIPPED_LOCKED        — another run holds the single-run lock
 *  - SKIPPED_MANUAL_MODE   — KrsConnectionSettings.syncMode === "manual"
 *  - ABORTED_EMPTY_KRS     — empty sp_Onhand while prior snapshots exist (fail-safe)
 *  - FAILED_PRODUCT_UPSERT — KRS product upsert threw (run aborted, no stock change)
 *  - FAILED_KRS_FETCH      — sp_Onhand threw (run aborted, no stock change)
 */
export type AutoSyncStatus =
  | "OK"
  | "PARTIAL"
  | "SKIPPED_LOCKED"
  | "SKIPPED_MANUAL_MODE"
  | "ABORTED_EMPTY_KRS"
  | "FAILED_PRODUCT_UPSERT"
  | "FAILED_KRS_FETCH";

/**
 * Typed result of a KRS inbound auto-pull run (krs-sync inbound auto-pull). Mirrors
 * the return shape of `runAutoSync` in src/lib/krs/autoSync.ts. `delta` is the net
 * signed stock change applied; `errors` are sanitized strings (never KRS secrets).
 */
export type AutoSyncResult = {
  status: AutoSyncStatus;
  runId: string;
  delta: number;
  updated: number;
  skipped: number;
  newProducts?: number;
  errors: string[];
};

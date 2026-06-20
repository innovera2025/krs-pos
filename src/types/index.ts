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

/** The order object returned by POST /api/orders — drives the receipt. */
export type OrderDTO = {
  id: string;
  orderNumber: string;
  subtotal: string | number;
  tax: string | number;
  discount: string | number;
  total: string | number;
  amountPaid: string | number;
  change: string | number;
  paymentType: string;
  createdAt: string;
  items: OrderItemDTO[];
  payments: OrderPaymentLine[];
  cashier?: { id: string; name: string } | null;
};

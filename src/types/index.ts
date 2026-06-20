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

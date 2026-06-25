import {
  LayoutGrid,
  Coffee,
  Utensils,
  CakeSlice,
  ShoppingBag,
  Package,
  type LucideIcon,
} from "lucide-react";
import type { CategorySlug } from "@/types";

/**
 * Visual metadata per category slug (icon + Taste thumb gradient + EN label).
 *
 * NOTE: the POS category SIDEBAR no longer uses this slug taxonomy — it groups by
 * the real product category (id + name) data-driven (see CategoryPanel + pos/page).
 * This slug machinery now serves ONLY the aesthetic icon/gradient/tint lookup for
 * product cards (ProductCard), cart lines (CartLine), and the products-table
 * monogram tint (components/products/productMeta). The DB Category model only
 * carries `name`, so those consumers derive a stable slug from the seed's 4 Thai
 * category names and look up icon/gradient here; any unmapped name falls back to
 * "other" (generic Package icon, neutral gradient) so cards/lines never break.
 */
export type CategoryMeta = {
  slug: CategorySlug;
  icon: LucideIcon;
  /** EN sublabel shown under the Thai name on a chip. */
  en: string;
  /** Taste thumbnail/line-icon gradient (CSS `background`). */
  gradient: string;
};

/** Slug -> visual metadata. */
export const CATEGORY_META: Record<CategorySlug, CategoryMeta> = {
  all: {
    slug: "all",
    icon: LayoutGrid,
    en: "All items",
    gradient: "linear-gradient(135deg,#edf2f7,#dce7f2)",
  },
  drink: {
    slug: "drink",
    icon: Coffee,
    en: "Beverage",
    gradient: "linear-gradient(135deg,#cff7ef,#d7f3ff)",
  },
  food: {
    slug: "food",
    icon: Utensils,
    en: "Food",
    gradient: "linear-gradient(135deg,#fff0c9,#ffe2cc)",
  },
  dessert: {
    slug: "dessert",
    icon: CakeSlice,
    en: "Dessert",
    gradient: "linear-gradient(135deg,#fde7f0,#eee6ff)",
  },
  goods: {
    slug: "goods",
    icon: ShoppingBag,
    en: "Retail",
    gradient: "linear-gradient(135deg,#edf2f7,#dce7f2)",
  },
  other: {
    slug: "other",
    icon: Package,
    en: "Other",
    gradient: "linear-gradient(135deg,#edf2f7,#dce7f2)",
  },
};

/** Map a DB Category name (Thai) -> a stable slug. Unknown names -> "other". */
export function slugForCategoryName(name: string | null | undefined): CategorySlug {
  switch ((name ?? "").trim()) {
    case "เครื่องดื่ม":
      return "drink";
    case "อาหาร":
      return "food";
    case "ขนมหวาน":
      return "dessert";
    case "ของใช้":
      return "goods";
    default:
      return "other";
  }
}

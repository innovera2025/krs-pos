import { slugForCategoryName } from "@/components/pos/categoryMeta";
import type { CategorySlug } from "@/types";

/** Low-stock threshold (amber). At or below this (and >0) = "สต็อกต่ำ". */
export const LOW_STOCK = 10;

export type StockStatus = "out" | "low" | "ok";

/** Classify a stock count into the three Taste statuses. */
export function stockStatus(stock: number): StockStatus {
  if (!Number.isFinite(stock) || stock <= 0) return "out";
  if (stock <= LOW_STOCK) return "low";
  return "ok";
}

/**
 * Category-tinted monogram colors for the products-table tile
 * (state-product-row-monogram). Mirrors the POS category gradients but rendered
 * as a flat tinted chip (bg + fg) keyed by category slug.
 */
const MONOGRAM_TINT: Record<CategorySlug, { bg: string; fg: string }> = {
  all: { bg: "#eef2f7", fg: "#475467" },
  drink: { bg: "#d7f3ff", fg: "#0e7490" },
  food: { bg: "#fff0c9", fg: "#b45309" },
  dessert: { bg: "#fde7f0", fg: "#be185d" },
  goods: { bg: "#e7eefc", fg: "#3730a3" },
  other: { bg: "#eef2f7", fg: "#475467" },
};

/** Tint for a product's monogram tile based on its category name. */
export function monogramTint(categoryName: string | null | undefined): {
  bg: string;
  fg: string;
} {
  return MONOGRAM_TINT[slugForCategoryName(categoryName)];
}

/** First grapheme of the (Thai) name for the monogram. Falls back to "?". */
export function monogramChar(name: string): string {
  const trimmed = (name ?? "").trim();
  return trimmed.length > 0 ? Array.from(trimmed)[0] : "?";
}

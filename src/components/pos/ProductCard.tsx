"use client";

import React, { useState } from "react";
import { Boxes, Plus, Check, BadgePercent } from "lucide-react";
import type { Product } from "@/types";
import { money } from "@/lib/money";
import { CATEGORY_META, slugForCategoryName } from "./categoryMeta";

type ProductCardProps = {
  product: Product;
  /** Effective stock (already defaulted to 50 if the payload omitted it). */
  stock: number;
  /** Qty of this product currently in the cart (0 = not in cart). */
  inCartQty: number;
  onAdd: (product: Product) => void;
  /**
   * Best qty-1 promotion badge for this product (promotions program, Phase 7), or
   * null when no line-level promo is scoped to it. `struckPrice` + `promoUnitPriceSatang`
   * are set for PRODUCT_DISCOUNT / FIXED_PRICE (an honest struck price at qty 1);
   * BUY_X_GET_Y carries only a rule `label` (its effective price depends on qty).
   * Derived ONCE per product upstream so this React.memo'd card keeps a stable prop.
   */
  promo?: {
    label: string;
    struckPrice?: boolean;
    promoUnitPriceSatang?: number;
  } | null;
};

/** Low-stock threshold (amber) and out-of-stock (disable add). */
const LOW_STOCK = 10;

/**
 * Taste product card — thumbnail w/ category gradient + icon, SKU pill, name,
 * price, stock, add affordance. Shows:
 *  - low-stock amber border when stock <= 10
 *  - "หมด" (out of stock) + disabled add when stock === 0
 *  - in-cart ✓ badge + qty when the product is already in the cart
 */
export const ProductCard = React.memo(function ProductCard({
  product,
  stock,
  inCartQty,
  onAdd,
  promo,
}: ProductCardProps) {
  const slug = slugForCategoryName(product.category?.name);
  const meta = CATEGORY_META[slug];
  const Icon = meta.icon;

  // KRS product image (mapped by PictureName). Falls back to the category Icon when
  // the product has no image filename OR the proxied fetch errors (onError flips the
  // flag). imageUrl is a stable prop from the product object, so React.memo holds.
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = Boolean(product.imageUrl) && !imgFailed;

  const isOut = stock === 0;
  const isLow = !isOut && stock <= LOW_STOCK;
  const inCart = inCartQty > 0;

  return (
    <button
      type="button"
      disabled={isOut}
      onClick={() => onAdd(product)}
      aria-label={`เพิ่ม ${product.name} (${product.sku}) ลงตะกร้า · ${money(
        Number(product.price)
      )}${isOut ? " · สินค้าหมด" : ""}`}
      className="flex min-h-[154px] flex-col gap-2.5 rounded-[22px] border p-3 text-left transition enabled:hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        background: "#fff",
        borderColor: isLow ? "#fed7aa" : "var(--line)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      {/* Thumbnail — enlarged so the product image dominates the card */}
      <div
        className="product-thumb relative grid place-items-center overflow-hidden rounded-[17px]"
        style={{ background: showImg ? "#fff" : meta.gradient, color: "#0b8060" }}
      >
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/products/image?code=${encodeURIComponent(product.sku)}`}
            alt={product.name}
            className="h-full w-full object-contain p-1.5"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <Icon size={44} strokeWidth={2} />
        )}
        <span
          className="mono absolute right-2 top-[7px] rounded-full px-[7px] py-0.5 text-[10px]"
          style={{ background: "rgba(255,255,255,.75)", color: "#667085" }}
        >
          {product.barcode || product.sku}
        </span>
        {inCart && (
          <span
            className="mono absolute left-2 top-[7px] flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
            style={{ background: "var(--brand-2)" }}
          >
            <Check size={11} strokeWidth={3} /> {inCartQty}
          </span>
        )}
        {/* Promotion pill (promotions program, Phase 7) — bottom-left so it never
            collides with the in-cart ✓ (top-left) or the barcode chip (top-right).
            Solid mint #11865a; the label is the type-appropriate short copy. */}
        {promo && (
          <span
            className="absolute bottom-[7px] left-2 flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold text-white"
            style={{ background: "#11865a" }}
          >
            <BadgePercent size={11} strokeWidth={2.5} /> {promo.label}
          </span>
        )}
      </div>

      {/* Name — one step smaller so the enlarged image dominates */}
      <div className="text-[13px] font-bold leading-tight">{product.name}</div>

      {/* Bottom: stock + price + add */}
      <div className="mt-auto flex items-end justify-between">
        <div>
          <div
            className="flex items-center gap-1 text-[11px]"
            style={{ color: isOut ? "#dc2626" : isLow ? "#c2410c" : "var(--muted)" }}
          >
            <Boxes size={13} strokeWidth={2} />
            {isOut ? "หมด" : `${stock} คงเหลือ`}
          </div>
          {/* Price — struck original above the mint promo price for %/฿/fixed promos;
              BUY_X_GET_Y (no struckPrice) keeps the normal catalog price + rule pill. */}
          {promo?.struckPrice && promo.promoUnitPriceSatang != null ? (
            <>
              <del
                className="mono block text-[11px] font-semibold"
                style={{ color: "var(--muted)" }}
              >
                {money(Number(product.price))}
              </del>
              <div
                className="price mono text-[18px] font-bold tracking-tight"
                style={{ color: "#11865a" }}
              >
                {money(promo.promoUnitPriceSatang / 100)}
              </div>
            </>
          ) : (
            <div className="price mono text-[18px] font-bold tracking-tight">
              {money(Number(product.price))}
            </div>
          )}
        </div>
        <span
          aria-hidden="true"
          className="grid h-[38px] w-[38px] place-items-center rounded-[14px] border"
          style={{
            background: isLow ? "#fff7ed" : "#eafbf2",
            color: isLow ? "#c2410c" : "var(--brand-2)",
            borderColor: isLow ? "#fed7aa" : "#cdf3dd",
          }}
        >
          <Plus size={19} strokeWidth={2} />
        </span>
      </div>
    </button>
  );
});

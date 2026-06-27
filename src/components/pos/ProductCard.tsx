"use client";

import React, { useState } from "react";
import { Boxes, Plus, Check } from "lucide-react";
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
      {/* Thumbnail */}
      <div
        className="relative grid h-[58px] place-items-center overflow-hidden rounded-[17px]"
        style={{ background: meta.gradient, color: "#0b8060" }}
      >
        {showImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/products/image?code=${encodeURIComponent(product.sku)}`}
            alt={product.name}
            className="h-full w-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <Icon size={25} strokeWidth={2} />
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
      </div>

      {/* Name */}
      <div className="text-[14px] font-bold leading-tight">{product.name}</div>

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
          <div className="price mono text-[18px] font-bold tracking-tight">
            {money(Number(product.price))}
          </div>
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

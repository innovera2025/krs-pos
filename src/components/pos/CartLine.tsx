"use client";

import { useState } from "react";
import { Minus, Plus, Trash2, Tag } from "lucide-react";
import type { CartItem } from "@/types";
import { money, formatSatang } from "@/lib/money";
import { CATEGORY_META, slugForCategoryName } from "./categoryMeta";
import { bahtToSatang } from "@/lib/pricing";

type CartLineProps = {
  item: CartItem;
  /** Line gross in satang (unit price * qty) — the per-line discount ceiling. */
  lineGrossSatang: number;
  onInc: (productId: string) => void;
  onDec: (productId: string) => void;
  onRemove: (productId: string) => void;
  /** Set the per-line discount (already clamped) in satang. */
  onLineDiscount: (productId: string, discountSatang: number) => void;
};

/**
 * A single cart line — Taste line card with category-tinted icon, qty stepper,
 * remove control, and an inline per-line discount (฿) input. The discount is
 * clamped to [0, line gross] and stored in integer satang.
 */
export function CartLine({
  item,
  lineGrossSatang,
  onInc,
  onDec,
  onRemove,
  onLineDiscount,
}: CartLineProps) {
  const { product, quantity, lineDiscountSatang } = item;
  const slug = slugForCategoryName(product.category?.name);
  const meta = CATEGORY_META[slug];
  const Icon = meta.icon;

  const [open, setOpen] = useState(lineDiscountSatang > 0);
  // Local text mirror so the field can be cleared while typing.
  const [draft, setDraft] = useState(
    lineDiscountSatang > 0 ? (lineDiscountSatang / 100).toString() : ""
  );

  const lineNetSatang = Math.max(lineGrossSatang - lineDiscountSatang, 0);

  function commitDiscount(raw: string) {
    setDraft(raw);
    const satang = Math.min(Math.max(bahtToSatang(raw), 0), lineGrossSatang);
    onLineDiscount(product.id, satang);
  }

  return (
    <div
      className="rounded-[18px] border p-3"
      style={{
        background: "#fff",
        borderColor: "var(--line)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div className="flex items-start gap-2.5">
        <span
          className="grid h-[42px] w-[42px] flex-shrink-0 place-items-center rounded-[14px]"
          style={{ background: meta.gradient, color: "#0b8060" }}
        >
          <Icon size={18} strokeWidth={2} />
        </span>
        <div className="min-w-0 flex-1">
          <strong className="block text-[13.5px] leading-tight">
            {product.name}
          </strong>
          <span className="mono mt-0.5 block text-[10.5px]" style={{ color: "var(--muted)" }}>
            {product.sku} · {money(Number(product.price))}
          </span>
        </div>
        <div className="mono text-[14px] font-bold">
          {formatSatang(lineNetSatang)}
        </div>
      </div>

      <div className="mt-[11px] flex items-center gap-2">
        <button
          type="button"
          onClick={() => onDec(product.id)}
          aria-label={`ลดจำนวน ${product.name}`}
          className="grid h-[30px] w-[30px] place-items-center rounded-[10px] border"
          style={{ background: "#f8fafc", borderColor: "var(--line)" }}
        >
          <Minus size={15} strokeWidth={2} />
        </button>
        <div
          className="mono min-w-[24px] text-center font-bold"
          aria-label={`จำนวน ${quantity}`}
        >
          {quantity}
        </div>
        <button
          type="button"
          onClick={() => onInc(product.id)}
          aria-label={`เพิ่มจำนวน ${product.name}`}
          className="grid h-[30px] w-[30px] place-items-center rounded-[10px] border"
          style={{ background: "#f8fafc", borderColor: "var(--line)" }}
        >
          <Plus size={15} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => onRemove(product.id)}
          aria-label={`นำ ${product.name} ออกจากตะกร้า`}
          className="grid h-[30px] w-[30px] place-items-center rounded-[10px] border"
          style={{ background: "#fffafa", borderColor: "#fecaca", color: "#dc2626" }}
        >
          <Trash2 size={15} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`ส่วนลดรายการ ${product.name}`}
          className="ml-auto flex items-center gap-1 rounded-full px-2 py-[5px] text-[11px]"
          style={{
            background: lineDiscountSatang > 0 ? "#eef4ff" : "#f2f4f7",
            color: lineDiscountSatang > 0 ? "#2563eb" : "#667085",
          }}
        >
          <Tag size={12} strokeWidth={2} />
          ส่วนลดรายการ
        </button>
      </div>

      {open && (
        <div className="mt-2.5 flex items-center gap-2">
          <label
            htmlFor={`line-disc-${product.id}`}
            className="text-[11px]"
            style={{ color: "var(--muted)" }}
          >
            ส่วนลด (฿)
          </label>
          <input
            id={`line-disc-${product.id}`}
            inputMode="decimal"
            value={draft}
            onChange={(e) => commitDiscount(e.target.value)}
            placeholder="0"
            className="mono h-[34px] w-[96px] rounded-[10px] border px-2.5 text-right font-semibold"
            style={{ borderColor: "var(--line)" }}
          />
          <span className="text-[10.5px]" style={{ color: "var(--soft)" }}>
            สูงสุด {formatSatang(lineGrossSatang)}
          </span>
        </div>
      )}
    </div>
  );
}

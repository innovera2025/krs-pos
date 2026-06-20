"use client";

import { useEffect, useState } from "react";
import { PackagePlus, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import type { Product } from "@/types";

type ReceiveStockModalProps = {
  open: boolean;
  /** All sellable products to pick from. */
  products: Product[];
  /** Optional product to preselect (e.g. the row that triggered receive). */
  preselectId?: string | null;
  submitting: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (input: { productId: string; qty: number; reference: string }) => void;
};

/**
 * Receive-stock (GRN) modal (action-receive-stock). Picks a product, enters a
 * positive integer qty + optional reference, and posts to /api/stock-movements.
 */
export function ReceiveStockModal({
  open,
  products,
  preselectId,
  submitting,
  error,
  onClose,
  onSubmit,
}: ReceiveStockModalProps) {
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("");
  const [reference, setReference] = useState("");

  // Reset fields when the modal (re)opens; honor a preselected product.
  useEffect(() => {
    if (open) {
      setProductId(preselectId ?? products[0]?.id ?? "");
      setQty("");
      setReference("");
    }
  }, [open, preselectId, products]);

  const qtyNum = Number(qty);
  const qtyValid = Number.isInteger(qtyNum) && qtyNum > 0;
  const canSubmit = productId.length > 0 && qtyValid && !submitting;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({ productId, qty: qtyNum, reference: reference.trim() });
  }

  const selected = products.find((p) => p.id === productId);

  return (
    <Modal open={open} onClose={onClose} label="รับสินค้าเข้า">
      <form
        onSubmit={handleSubmit}
        className="w-[min(440px,calc(100vw-32px))] rounded-[22px] bg-white"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <header
          className="flex items-center gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <span
            className="grid h-10 w-10 place-items-center rounded-[14px]"
            style={{ background: "#eafbf2", color: "var(--brand-2)" }}
          >
            <PackagePlus size={20} strokeWidth={2} />
          </span>
          <div className="flex-1">
            <strong className="block text-[15px]">รับสินค้าเข้า</strong>
            <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
              Receive stock (GRN) · เพิ่มจำนวนคงเหลือ
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="grid h-9 w-9 place-items-center rounded-[12px] border"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          >
            <X size={18} strokeWidth={2} />
          </button>
        </header>

        <div className="flex flex-col gap-3.5 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">สินค้า · Product</span>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: "var(--line)", background: "#fff" }}
            >
              {products.length === 0 && <option value="">ไม่มีสินค้า</option>}
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sku}) — คงเหลือ {p.stock}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">
              จำนวนรับเข้า · Quantity
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              inputMode="numeric"
              placeholder="เช่น 50"
              className="mono h-11 rounded-[12px] border px-3 text-[15px]"
              style={{ borderColor: "var(--line)" }}
            />
            {selected && qtyValid && (
              <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                คงเหลือใหม่ · New on-hand:{" "}
                <strong className="mono" style={{ color: "var(--ink)" }}>
                  {selected.stock + qtyNum}
                </strong>
              </span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">
              อ้างอิง · Reference (ไม่บังคับ)
            </span>
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="เลขที่ใบสั่งซื้อ / PO-2024-001"
              autoComplete="off"
              className="h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: "var(--line)" }}
            />
          </label>

          {error && (
            <p
              role="alert"
              className="m-0 rounded-[12px] px-3 py-2 text-[12.5px]"
              style={{ background: "var(--red-soft)", color: "#b42318" }}
            >
              {error}
            </p>
          )}
        </div>

        <footer
          className="flex justify-end gap-2.5 border-t px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-[12px] border px-4 text-[13.5px] font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            ยกเลิก
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="h-11 rounded-[12px] px-5 text-[13.5px] font-bold text-white disabled:opacity-50"
            style={{ background: "var(--brand)" }}
          >
            {submitting ? "กำลังบันทึก…" : "รับสินค้าเข้า"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

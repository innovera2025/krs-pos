"use client";

import { useEffect, useState } from "react";
import { Package, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import type { Category, Product } from "@/types";

export type ProductFormValues = {
  name: string;
  sku: string;
  price: number;
  stock: number;
  categoryId: string | null;
  barcode: string | null;
};

type ProductFormModalProps = {
  open: boolean;
  /** When set, the form is in EDIT mode for this product; else CREATE mode. */
  editing: Product | null;
  categories: Category[];
  submitting: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (values: ProductFormValues) => void;
};

/**
 * Add / edit product form (action-add-product-button + row edit). Create mode
 * posts to /api/products; edit mode patches /api/products/[id]. SKU is only
 * editable on create (it is the stable unique identifier).
 */
export function ProductFormModal({
  open,
  editing,
  categories,
  submitting,
  error,
  onClose,
  onSubmit,
}: ProductFormModalProps) {
  const isEdit = editing !== null;

  const [name, setName] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [barcode, setBarcode] = useState("");

  // Hydrate the form when it opens (from the editing row, or blank on create).
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setSku(editing.sku);
      setPrice(String(editing.price));
      setStock(String(editing.stock));
      setCategoryId(editing.categoryId ?? "");
      setBarcode(editing.barcode ?? "");
    } else {
      setName("");
      setSku("");
      setPrice("");
      setStock("");
      setCategoryId(categories[0]?.id ?? "");
      setBarcode("");
    }
  }, [open, editing, categories]);

  const priceNum = Number(price);
  const stockNum = Number(stock);
  const nameOk = name.trim().length > 0;
  const skuOk = isEdit || sku.trim().length > 0;
  const priceOk = Number.isFinite(priceNum) && priceNum >= 0;
  const stockOk = Number.isInteger(stockNum) && stockNum >= 0;
  const canSubmit = nameOk && skuOk && priceOk && stockOk && !submitting;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      sku: sku.trim(),
      price: priceNum,
      stock: stockNum,
      categoryId: categoryId.length > 0 ? categoryId : null,
      barcode: barcode.trim().length > 0 ? barcode.trim() : null,
    });
  }

  return (
    <Modal open={open} onClose={onClose} label={isEdit ? "แก้ไขสินค้า" : "เพิ่มสินค้า"}>
      <form
        onSubmit={handleSubmit}
        className="w-[min(480px,calc(100vw-32px))] rounded-[22px] bg-white"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <header
          className="flex items-center gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <span
            className="grid h-10 w-10 place-items-center rounded-[14px]"
            style={{ background: "#eef4ff", color: "#2563eb" }}
          >
            <Package size={20} strokeWidth={2} />
          </span>
          <div className="flex-1">
            <strong className="block text-[15px]">
              {isEdit ? "แก้ไขสินค้า" : "เพิ่มสินค้าใหม่"}
            </strong>
            <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
              {isEdit ? "Edit product" : "Add product"}
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

        <div className="grid grid-cols-2 gap-3.5 px-5 py-4">
          <label className="col-span-2 flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">ชื่อสินค้า · Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น ลาเต้ (ร้อน)"
              autoComplete="off"
              className="h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: "var(--line)" }}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">SKU</span>
            <input
              type="text"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder="BV-001"
              autoComplete="off"
              disabled={isEdit}
              className="mono h-11 rounded-[12px] border px-3 text-[14px] disabled:opacity-60"
              style={{ borderColor: "var(--line)" }}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">บาร์โค้ด · Barcode</span>
            <input
              type="text"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="(ไม่บังคับ)"
              autoComplete="off"
              className="mono h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: "var(--line)" }}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">ราคา (฿) · Price</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              inputMode="decimal"
              placeholder="0.00"
              className="mono h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: "var(--line)" }}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">สต็อก · Stock</span>
            <input
              type="number"
              min={0}
              step={1}
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              inputMode="numeric"
              placeholder="0"
              className="mono h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: "var(--line)" }}
            />
          </label>

          <label className="col-span-2 flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">หมวดหมู่ · Category</span>
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: "var(--line)", background: "#fff" }}
            >
              <option value="">— ไม่ระบุ —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <p
              role="alert"
              className="col-span-2 m-0 rounded-[12px] px-3 py-2 text-[12.5px]"
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
            {submitting ? "กำลังบันทึก…" : isEdit ? "บันทึกการแก้ไข" : "เพิ่มสินค้า"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

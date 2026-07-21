"use client";

import { useEffect, useMemo, useState } from "react";
import { Gift, X } from "lucide-react";
import { Modal } from "@/components/Modal";
import { RewardProductPicker } from "@/components/members/RewardProductPicker";
import { GOLD, fmtPoints, type RewardDTO } from "@/components/members/rewardMeta";
import { money } from "@/lib/money";
import type { Product } from "@/types";

/**
 * The create/edit payload posted to the rewards API (loyalty program, Phase 3A). `name`,
 * `pointsCost` (whole points), and `productId` (the free product) are required; `isActive`
 * toggles live/disabled. NO money on the reward itself — the product's baht price is
 * resolved server-side at read time.
 */
export type RewardFormPayload = {
  name: string;
  pointsCost: number;
  productId: string;
  isActive: boolean;
};

type RewardFormModalProps = {
  open: boolean;
  /** When set, EDIT mode for this reward; else CREATE mode. */
  editing: RewardDTO | null;
  submitting: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (values: RewardFormPayload) => void;
};

/** Whole integer ≥ 1 (mirrors the API pointsCost bound). */
function pointsOk(v: number): boolean {
  return Number.isInteger(v) && v >= 1;
}

/**
 * Add / edit reward form (loyalty program, Phase 3A). Structure mirrors
 * PromotionFormModal (shared Modal primitive, header/body/footer) but scoped to a
 * reward's three fields + active toggle. Loyalty accent = GOLD (points figures in gold),
 * distinct from the promotion mint form. Validation is derived booleans + a disabled
 * submit (no red-per-keystroke).
 */
export function RewardFormModal({
  open,
  editing,
  submitting,
  error,
  onClose,
  onSubmit,
}: RewardFormModalProps) {
  const isEdit = editing !== null;

  const [name, setName] = useState("");
  const [pointsCost, setPointsCost] = useState("");
  const [productId, setProductId] = useState("");
  const [isActive, setIsActive] = useState(true);

  // The picker's fetched product list, lifted here so the preview can show the selected
  // product's current name + price.
  const [pickerProducts, setPickerProducts] = useState<Product[]>([]);

  // Hydrate on open — from the editing row, or blank defaults on create.
  useEffect(() => {
    if (!open) return;
    setPickerProducts([]);
    if (editing) {
      setName(editing.name);
      setPointsCost(String(editing.pointsCost));
      setProductId(editing.productId);
      setIsActive(editing.isActive);
    } else {
      setName("");
      setPointsCost("");
      setProductId("");
      setIsActive(true);
    }
  }, [open, editing]);

  const pc = Number(pointsCost);
  const nameOk = name.trim().length > 0;
  const pcOk = pointsOk(pc);
  const productOk = productId.length > 0;
  const canSubmit = nameOk && pcOk && productOk && !submitting;

  // Live preview — resolve the selected product from the picker list, falling back to the
  // editing row's product snapshot (a product not in the fetched list is shown by name).
  const selectedProduct = useMemo(
    () => pickerProducts.find((p) => p.id === productId) ?? null,
    [pickerProducts, productId]
  );
  const previewProductName =
    selectedProduct?.name ??
    (editing && editing.productId === productId ? editing.product?.name : undefined) ??
    null;
  const previewProductPrice =
    selectedProduct != null
      ? money(Number(selectedProduct.price))
      : editing && editing.productId === productId && editing.product
        ? `฿${editing.product.price}`
        : null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      pointsCost: pc,
      productId,
      isActive,
    });
  }

  return (
    <Modal open={open} onClose={onClose} label={isEdit ? "แก้ไขของรางวัล" : "เพิ่มของรางวัล"}>
      <form
        onSubmit={handleSubmit}
        className="flex max-h-[86vh] w-[min(520px,calc(100vw-32px))] flex-col rounded-[22px] bg-white"
        style={{ boxShadow: "var(--shadow)" }}
      >
        {/* Header */}
        <header
          className="flex items-center gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <span
            className="grid h-10 w-10 place-items-center rounded-[14px]"
            style={{ background: GOLD.bg, color: GOLD.fg }}
          >
            <Gift size={20} strokeWidth={2} />
          </span>
          <div className="flex-1">
            <strong className="block text-[15px]">
              {isEdit ? "แก้ไขของรางวัล" : "เพิ่มของรางวัล"}
            </strong>
            <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
              {isEdit ? "Edit reward" : "Add reward"}
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

        {/* Body (scrolls) */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {/* Name */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">ชื่อของรางวัล · Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น กาแฟเย็นฟรี 1 แก้ว"
              autoComplete="off"
              className="h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: "var(--line)" }}
            />
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>
              ชื่อนี้จะแสดงบนหน้าขายและใบเสร็จ
            </span>
          </label>

          {/* Points cost */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">แต้มที่ใช้แลก · Points cost</span>
            <div className="flex items-center gap-2.5">
              <input
                type="number"
                min={1}
                step={1}
                inputMode="numeric"
                value={pointsCost}
                onChange={(e) => setPointsCost(e.target.value)}
                placeholder="100"
                className="mono h-11 flex-1 rounded-[12px] border px-3 text-right text-[14px]"
                style={{ borderColor: "var(--line)" }}
              />
              <span className="text-[13px] font-bold" style={{ color: GOLD.fg }}>
                แต้ม
              </span>
            </div>
          </label>

          {/* Product picker (single-select) */}
          <RewardProductPicker
            value={productId}
            onChange={setProductId}
            onProductsLoaded={setPickerProducts}
          />

          {/* Live preview */}
          {pcOk && productOk && previewProductName && (
            <div
              className="flex flex-col gap-0.5 rounded-[12px] px-3 py-2.5 text-[12.5px]"
              style={{ background: GOLD.bg, color: GOLD.fg }}
            >
              <span className="font-semibold">
                แลก {fmtPoints(pc)} แต้ม รับ “{previewProductName}” ฟรี
              </span>
              {previewProductPrice && (
                <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                  มูลค่าสินค้า {previewProductPrice}
                </span>
              )}
            </div>
          )}

          {/* Activate now */}
          <label className="flex cursor-pointer items-center gap-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={isActive}
              onClick={() => setIsActive((v) => !v)}
              className="relative h-6 w-11 flex-shrink-0 rounded-full transition"
              style={{ background: isActive ? GOLD.fg : "#cbd5e1" }}
            >
              <span
                aria-hidden="true"
                className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
                style={{ left: isActive ? 22 : 2 }}
              />
            </button>
            <span className="text-[13px] font-semibold">เปิดใช้งานทันที · Activate now</span>
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

        {/* Footer */}
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
            style={{ background: GOLD.fg }}
          >
            {submitting ? "กำลังบันทึก…" : isEdit ? "บันทึกการแก้ไข" : "เพิ่มของรางวัล"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

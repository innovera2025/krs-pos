"use client";

import { Gift, X, Check, AlertTriangle } from "lucide-react";
import { Modal } from "@/components/Modal";
import type { RewardDTO } from "@/types";
import { money } from "@/lib/money";

type RewardPickerModalProps = {
  open: boolean;
  /** Active rewards (from GET /api/rewards?view=pos) with a live product. */
  rewards: RewardDTO[];
  /** Member's current points balance. */
  pointsBalance: number;
  /**
   * Points ALREADY committed on this bill = baht-redemption points + the points of every
   * reward already selected. An UNSELECTED reward is addable only when
   * `pointsCost ≤ pointsBalance − committedPoints`; a selected reward is always removable.
   */
  committedPoints: number;
  /** Ids of rewards currently selected (each reward is redeemable at most once per bill). */
  selectedIds: Set<string>;
  /** Available stock for a reward's product (from the POS grid); a reward whose free unit
   *  can't be covered by stock is disabled with a "สินค้าหมด" note. */
  stockByProductId: Map<string, number>;
  /**
   * ProductIds carrying an active LINE-level promotion this sale (FIX A). A reward can't
   * be honestly stacked on a promo'd product, so any reward whose product is in this set
   * is disabled with a "มีโปรโมชันอยู่แล้ว" note (the server also rejects it with
   * REWARD_PROMO_CONFLICT). Empty set = no line promos → nothing disabled on this account.
   */
  promoProductIds: ReadonlySet<string>;
  /** Toggle a reward on/off (the parent adds/removes the cart unit + tracks the id). */
  onToggle: (reward: RewardDTO) => void;
  onClose: () => void;
};

/**
 * Reward picker (loyalty program, Phase 3B) — "แลกของรางวัล". Lists the store's active
 * rewards a member can redeem for a free product unit. Gold/amber Taste accent, distinct
 * from the mint promo + blue tax surfaces. The parent owns the cart mutation + the redeemed
 * ids; this modal is display + toggle only. Server stays authoritative (it re-validates
 * every reward, its product-in-cart, and the combined points spend at checkout).
 */
export function RewardPickerModal({
  open,
  rewards,
  pointsBalance,
  committedPoints,
  selectedIds,
  stockByProductId,
  promoProductIds,
  onToggle,
  onClose,
}: RewardPickerModalProps) {
  const remaining = Math.max(pointsBalance - committedPoints, 0);

  return (
    <Modal open={open} onClose={onClose} label="แลกของรางวัล">
      <div
        className="flex max-h-[86vh] w-[520px] max-w-[94vw] flex-col overflow-hidden rounded-[18px] bg-white"
        style={{ boxShadow: "0 30px 70px rgba(0,0,0,.35)" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b p-[18px]"
          style={{ borderColor: "var(--line)" }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="grid h-[38px] w-[38px] place-items-center rounded-[13px]"
              style={{ background: "#FFFBEB", color: "#B45309" }}
            >
              <Gift size={19} strokeWidth={2} />
            </span>
            <div>
              <h2 className="m-0 text-[16px] font-bold">แลกของรางวัล</h2>
              <div className="text-[11.5px]" style={{ color: "var(--soft)" }}>
                คงเหลือ {remaining} แต้ม · Redeem rewards
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิดหน้าต่างแลกของรางวัล"
            className="grid h-[34px] w-[34px] place-items-center rounded-[9px]"
            style={{ color: "#94a3b8" }}
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Reward list */}
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-[18px]">
          {rewards.length === 0 ? (
            <div
              className="grid place-items-center py-10 text-center text-[13px]"
              style={{ color: "var(--soft)" }}
            >
              ยังไม่มีของรางวัลให้แลก
            </div>
          ) : (
            rewards.map((r) => {
              const selected = selectedIds.has(r.id);
              const productName = r.product?.name ?? "สินค้าถูกลบ";
              const stock = stockByProductId.get(r.productId) ?? 0;
              const outOfStock = stock <= 0;
              // FIX A — a reward on a product that already has an active line-level promo
              // can't be honestly stacked (the server 422s REWARD_PROMO_CONFLICT), so block
              // a NEW add and note why. A selected reward stays removable.
              const hasLinePromo = promoProductIds.has(r.productId);
              // Affordable to ADD when the remaining balance covers the cost; a selected
              // reward is always toggleable (to remove). Out-of-stock / an existing line
              // promo block a NEW add.
              const canAdd =
                r.pointsCost <= remaining &&
                !outOfStock &&
                !hasLinePromo &&
                r.product !== null;
              const disabled = !selected && !canAdd;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => onToggle(r)}
                  disabled={disabled}
                  aria-pressed={selected}
                  className="flex items-center gap-3 rounded-[14px] border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-55"
                  style={
                    selected
                      ? {
                          background: "#FFFBEB",
                          borderColor: "#F59E0B",
                          boxShadow: "0 2px 8px rgba(180,83,9,.12)",
                        }
                      : { background: "#fff", borderColor: "var(--line)" }
                  }
                >
                  <span
                    className="grid h-[42px] w-[42px] flex-shrink-0 place-items-center rounded-[13px]"
                    style={{
                      background: selected ? "#FDE68A" : "#FFFBEB",
                      color: "#B45309",
                    }}
                  >
                    {selected ? (
                      <Check size={19} strokeWidth={2.4} />
                    ) : (
                      <Gift size={19} strokeWidth={2} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-[13.5px]">{r.name}</strong>
                    <span
                      className="block truncate text-[11.5px]"
                      style={{ color: "var(--muted)" }}
                    >
                      ฟรี: {productName}
                      {r.product ? ` · ${money(Number(r.product.price))}` : ""}
                    </span>
                    {outOfStock && (
                      <span
                        className="mt-0.5 flex items-center gap-1 text-[11px] font-medium"
                        style={{ color: "#dc2626" }}
                      >
                        <AlertTriangle size={12} strokeWidth={1.8} />
                        สินค้าหมด
                      </span>
                    )}
                    {/* Line-promo conflict note (FIX A) — shown when in stock but the product
                        already carries an active line-level promo, so the reward can't stack. */}
                    {!outOfStock && hasLinePromo && (
                      <span
                        className="mt-0.5 flex items-center gap-1 text-[11px] font-medium"
                        style={{ color: "#dc2626" }}
                      >
                        <AlertTriangle size={12} strokeWidth={1.8} />
                        มีโปรโมชันอยู่แล้ว
                      </span>
                    )}
                    {!outOfStock && !hasLinePromo && disabled && (
                      <span
                        className="mt-0.5 block text-[11px] font-medium"
                        style={{ color: "#dc2626" }}
                      >
                        แต้มไม่พอ
                      </span>
                    )}
                  </div>
                  <span
                    className="flex-shrink-0 rounded-md px-2 py-[3px] text-[11.5px] font-semibold"
                    style={{
                      background: "#FFFBEB",
                      color: "#B45309",
                      border: "1px solid #FCD34D",
                    }}
                  >
                    {r.pointsCost} แต้ม
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          className="border-t p-[14px_18px]"
          style={{ borderColor: "var(--line)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="flex h-[46px] w-full items-center justify-center rounded-[12px] text-[14px] font-bold text-white"
            style={{ background: "#0f172a" }}
          >
            เสร็จสิ้น · Done
          </button>
        </div>
      </div>
    </Modal>
  );
}

"use client";

import { CreditCard } from "lucide-react";
import type { DiscountType } from "@/types";
import type { Totals } from "@/lib/pricing";
import { formatSatang } from "@/lib/money";

type TotalsBarProps = {
  totals: Totals;
  /** Raw text in the bill-discount input (mirror so it can be cleared). */
  discountDraft: string;
  discountType: DiscountType;
  onDiscountChange: (raw: string) => void;
  onToggleDiscountType: () => void;
  onHoldBill: () => void;
  onCancelBill: () => void;
  /** In-flight park (พักบิล) POST — disables the hold button so a double-tap can't
   *  write two identical held bills (M1). */
  isHolding: boolean;
  /** Number of bills the current cashier has parked (drives the "บิลที่พักไว้" link). */
  heldCount: number;
  /** Open the held-bills (พักบิล) list modal. */
  onOpenHeldBills: () => void;
  onPay: () => void;
  /** Disable pay (empty cart or in-flight checkout). */
  payDisabled: boolean;
  checkingOut: boolean;
  /**
   * Bill-level PROMOTION discount in satang (promotions program, Phase 7) — the promo
   * slice of `totals.billDiscountSatang`. The manual bill-discount row shows the rest
   * (`billDiscountSatang − promoBillDiscountSatang`), so the footing stays
   * `subtotal − promoBill − manual = total`.
   */
  promoBillDiscountSatang?: number;
  /** Name of the applied threshold promo (shown small beside the promo row). */
  billPromoName?: string | null;
  /**
   * Points-redemption slice of `totals.billDiscountSatang` (loyalty program, Phase 2) —
   * the gold discount row. The manual bill-discount row subtracts BOTH the promo AND this
   * redemption, so the footing stays `subtotal − promoBill − redemption − manual = total`
   * (the redeem is never absorbed into the manual row). 0/omitted → the row is hidden.
   */
  pointsRedemptionSatang?: number;
  /**
   * Nearest UNMET spend-&-save promo (promotions program, Phase 7): buy `missingSatang`
   * more to unlock `rewardLabel`. Null when none is unmet or one is already applied.
   */
  thresholdHint?: { missingSatang: number; rewardLabel: string } | null;
};

/**
 * Cart summary footer — bill discount (฿/% toggle), VAT-inclusive totals,
 * cancel bill, and the preserved pay button.
 *
 * VAT is shown as "VAT 7% (รวมในราคา)" extracted inclusive; totals foot to
 * `subtotal − billDiscount = total` (the invariant guaranteed by computeTotals).
 */
export function TotalsBar({
  totals,
  discountDraft,
  discountType,
  onDiscountChange,
  onToggleDiscountType,
  onHoldBill,
  onCancelBill,
  isHolding,
  heldCount,
  onOpenHeldBills,
  onPay,
  payDisabled,
  checkingOut,
  promoBillDiscountSatang,
  billPromoName,
  pointsRedemptionSatang,
  thresholdHint,
}: TotalsBarProps) {
  // Split the combined bill discount into its promo + redemption + manual slices for the
  // rows. `totals.billDiscountSatang` is the combined value the engine handed to pricing;
  // the manual portion is whatever is left after the promo AND redemption slices (so a
  // points redemption is never double-counted into the manual "ส่วนลดท้ายบิล" row).
  const promoBill = promoBillDiscountSatang ?? 0;
  const redemption = pointsRedemptionSatang ?? 0;
  const manualBill = Math.max(
    totals.billDiscountSatang - promoBill - redemption,
    0
  );
  return (
    <div
      className="border-t px-[18px] pb-[18px] pt-4"
      style={{
        borderColor: "var(--line)",
        background: "linear-gradient(180deg,#fff,#f8fafc)",
      }}
    >
      {/* Nearest unmet spend-&-save nudge (promotions program, Phase 7) — slim mint
          pill above the bill-discount input, shown only while a threshold is unmet. */}
      {thresholdHint && (
        <div
          className="mb-2.5 flex items-center gap-1.5 rounded-[11px] px-2.5 py-2 text-[11.5px] font-semibold"
          style={{
            background: "#ecfdf5",
            color: "#11865a",
            border: "1px solid #cdf3dd",
          }}
        >
          <span aria-hidden="true">✦</span>
          <span>
            ซื้อเพิ่มอีก {formatSatang(thresholdHint.missingSatang)} ลดทันที{" "}
            {thresholdHint.rewardLabel}
          </span>
        </div>
      )}

      {/* Bill discount row */}
      <div
        className="mb-[13px] grid items-center gap-2"
        style={{ gridTemplateColumns: "1fr 88px 44px" }}
      >
        <label
          htmlFor="bill-discount"
          className="text-[12px]"
          style={{ color: "#667085" }}
        >
          ส่วนลดท้ายบิล
        </label>
        <input
          id="bill-discount"
          inputMode="decimal"
          value={discountDraft}
          onChange={(e) => onDiscountChange(e.target.value)}
          placeholder="0"
          className="mono h-[38px] rounded-xl border px-2.5 text-right font-semibold"
          style={{ borderColor: "var(--line)" }}
        />
        <button
          type="button"
          onClick={onToggleDiscountType}
          aria-label={
            discountType === "amount"
              ? "ส่วนลดเป็นบาท · สลับเป็นเปอร์เซ็นต์"
              : "ส่วนลดเป็นเปอร์เซ็นต์ · สลับเป็นบาท"
          }
          className="h-[38px] rounded-xl border font-bold"
          style={{
            borderColor: "#dbeafe",
            background: "#eef4ff",
            color: "#2563eb",
          }}
        >
          {discountType === "amount" ? "฿" : "%"}
        </button>
      </div>

      {/* Totals */}
      <div
        className="flex flex-col gap-[7px] border-t border-dashed pt-3"
        style={{ borderColor: "var(--line-strong)" }}
      >
        <div className="flex justify-between text-[12.5px]" style={{ color: "#667085" }}>
          <span>ยอดก่อนภาษี · Subtotal</span>
          <span className="mono">{formatSatang(totals.subtotalSatang)}</span>
        </div>
        {/* Bill-level PROMOTION discount (mint) — sits between subtotal and the manual
            discount row; line-level promos are already inside the subtotal. */}
        {promoBill > 0 && (
          <div className="flex justify-between text-[12.5px]" style={{ color: "#11865a" }}>
            <span className="min-w-0 truncate pr-2">
              ส่วนลดโปรโมชัน · Promotions
              {billPromoName ? (
                <span className="ml-1 opacity-70">· {billPromoName}</span>
              ) : null}
            </span>
            <span className="mono flex-shrink-0">-{formatSatang(promoBill)}</span>
          </div>
        )}
        {manualBill > 0 && (
          <div className="flex justify-between text-[12.5px]" style={{ color: "#dc2626" }}>
            <span>ส่วนลดท้ายบิล · Discount</span>
            <span className="mono">-{formatSatang(manualBill)}</span>
          </div>
        )}
        {/* Points redemption (loyalty program, Phase 2) — gold/amber, distinct from the
            mint promo + red manual rows so the cashier reads the three slices apart. */}
        {redemption > 0 && (
          <div className="flex justify-between text-[12.5px]" style={{ color: "#B45309" }}>
            <span>ใช้แต้มแลกส่วนลด · Points</span>
            <span className="mono">-{formatSatang(redemption)}</span>
          </div>
        )}
        <div className="flex justify-between text-[12.5px]" style={{ color: "#667085" }}>
          <span>VAT 7% (รวมในราคา)</span>
          <span className="mono">{formatSatang(totals.vatSatang)}</span>
        </div>
        <div className="mt-2 flex items-end justify-between">
          <span className="text-[13px] font-bold">ยอดสุทธิ · Total</span>
          <strong
            className="mono pos-grand-total font-bold leading-none"
            style={{ letterSpacing: "-.04em" }}
          >
            {formatSatang(totals.totalSatang)}
          </strong>
        </div>
      </div>

      {/* Actions — hold (พักบิล) + cancel (ยกเลิกบิล), side by side per Taste. The
          "บิลที่พักไว้" link sits under พักบิล when the cashier has parked bills. */}
      <div className="mt-[15px] grid grid-cols-2 items-start gap-[9px]">
        <div className="flex flex-col items-center gap-1">
          <button
            type="button"
            onClick={onHoldBill}
            disabled={isHolding || payDisabled}
            className="h-[46px] w-full rounded-[15px] border bg-white text-[13px] font-bold disabled:cursor-not-allowed disabled:opacity-50"
            style={{ borderColor: "var(--line)", color: "#475569" }}
          >
            {isHolding ? "กำลังพักบิล…" : "พักบิล"}
          </button>
          {heldCount > 0 && (
            <button
              type="button"
              onClick={onOpenHeldBills}
              className="text-[11px] font-semibold underline-offset-2 hover:underline"
              style={{ color: "var(--brand)" }}
            >
              บิลที่พักไว้ ({heldCount})
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onCancelBill}
          className="h-[46px] w-full rounded-[15px] border text-[13px] font-bold"
          style={{
            borderColor: "#fecaca",
            color: "#dc2626",
            background: "#fffafa",
          }}
        >
          ยกเลิกบิล
        </button>
      </div>

      <button
        type="button"
        onClick={onPay}
        disabled={payDisabled}
        className="mt-2.5 flex h-[60px] w-full items-center justify-center gap-2.5 rounded-[18px] text-[16px] font-bold text-white disabled:cursor-not-allowed"
        style={{
          border: 0,
          background: payDisabled
            ? "#cbd5e1"
            : "linear-gradient(180deg,#22b877,#11865a)",
          boxShadow: payDisabled ? "none" : "0 15px 30px rgba(31,169,113,.24)",
        }}
      >
        <CreditCard size={20} strokeWidth={2} />
        <span>{checkingOut ? "กำลังชำระเงิน…" : "ชำระเงิน"}</span>
        <span className="mono">{formatSatang(totals.totalSatang)}</span>
      </button>
    </div>
  );
}

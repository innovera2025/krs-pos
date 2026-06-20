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
  onCancelBill: () => void;
  onPay: () => void;
  /** Disable pay (empty cart or in-flight checkout). */
  payDisabled: boolean;
  checkingOut: boolean;
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
  onCancelBill,
  onPay,
  payDisabled,
  checkingOut,
}: TotalsBarProps) {
  return (
    <div
      className="border-t px-[18px] pb-[18px] pt-4"
      style={{
        borderColor: "var(--line)",
        background: "linear-gradient(180deg,#fff,#f8fafc)",
      }}
    >
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
        {totals.billDiscountSatang > 0 && (
          <div className="flex justify-between text-[12.5px]" style={{ color: "#dc2626" }}>
            <span>ส่วนลดท้ายบิล · Discount</span>
            <span className="mono">-{formatSatang(totals.billDiscountSatang)}</span>
          </div>
        )}
        <div className="flex justify-between text-[12.5px]" style={{ color: "#667085" }}>
          <span>VAT 7% (รวมในราคา)</span>
          <span className="mono">{formatSatang(totals.vatSatang)}</span>
        </div>
        <div className="mt-2 flex items-end justify-between">
          <span className="text-[13px] font-bold">ยอดสุทธิ · Total</span>
          <strong
            className="mono text-[32px] font-bold leading-none"
            style={{ letterSpacing: "-.04em" }}
          >
            {formatSatang(totals.totalSatang)}
          </strong>
        </div>
      </div>

      {/* Actions */}
      <div className="mt-[15px]">
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

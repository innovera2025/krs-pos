"use client";

import { money } from "@/lib/money";

type ShiftSummaryCardProps = {
  refundsTotal: string;
  discountsTotal: string;
  vatTotal: string;
};

/**
 * The 3 summary cards (refunds −, discounts −, output VAT), ported from the
 * Simple POS source-of-truth into Taste. Refunds + discounts are shown as
 * negatives (sign-prefixed); VAT is the output VAT.
 */
export function ShiftSummaryCard({
  refundsTotal,
  discountsTotal,
  vatTotal,
}: ShiftSummaryCardProps) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Card label="คืนเงิน · Refunds" value={`−${money(refundsTotal)}`} valueColor="#c2410c" />
      <Card label="ส่วนลด · Discounts" value={`−${money(discountsTotal)}`} valueColor="#16a34a" />
      <Card label="VAT 7% · Output VAT" value={money(vatTotal)} valueColor="var(--ink)" />
    </div>
  );
}

function Card({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor: string;
}) {
  return (
    <div
      className="rounded-[14px] border bg-white px-4 py-3.5"
      style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
    >
      <div className="text-[12px]" style={{ color: "var(--soft)" }}>
        {label}
      </div>
      <div className="mono mt-[3px] text-[18px] font-bold" style={{ color: valueColor }}>
        {value}
      </div>
    </div>
  );
}

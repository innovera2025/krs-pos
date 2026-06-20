"use client";

import { money } from "@/lib/money";

type CashCountingPanelProps = {
  openingFloat: string;
  cashSales: string;
  cashRefunds: string;
  expectedCash: string;
  /** Counted-cash input value (raw baht text as typed). */
  counted: string;
  onCountedChange: (value: string) => void;
  /** Whether the close request is in flight. */
  closing: boolean;
  onClose: () => void;
  /** Daily summary number after a successful close (e.g. "DS-20260616"), or null. */
  dailySummaryNo: string | null;
};

/**
 * Cash-counting panel (action-counted-cash / state-variance / action-close-shift),
 * ported from the Simple POS source-of-truth into Taste.
 *
 * Variance = counted − expected, computed in integer satang to avoid float drift.
 * Color: green when balanced (|variance| < 0.01), amber when over (> 0), red when
 * short (< 0). Shown sign-prefixed only once a counted value is entered.
 */
export function CashCountingPanel({
  openingFloat,
  cashSales,
  cashRefunds,
  expectedCash,
  counted,
  onCountedChange,
  closing,
  onClose,
  dailySummaryNo,
}: CashCountingPanelProps) {
  const countedTrim = counted.trim();
  const countedNum = Number(countedTrim);
  const hasCounted = countedTrim !== "" && Number.isFinite(countedNum);

  // Variance in integer satang (counted − expected).
  const expectedSatang = Math.round(Number(expectedCash) * 100);
  const countedSatang = hasCounted ? Math.round(countedNum * 100) : 0;
  const varianceSatang = countedSatang - expectedSatang;

  const balanced = Math.abs(varianceSatang) < 1; // < 0.01 baht
  const varianceColor = balanced ? "#15803d" : varianceSatang > 0 ? "#b45309" : "#dc2626";
  const varianceSign = varianceSatang >= 0 ? "+" : "−";
  const varianceStr = `${varianceSign}${money(Math.abs(varianceSatang) / 100)}`;

  return (
    <div
      className="flex flex-col gap-3.5 rounded-[16px] border bg-white p-5"
      style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
    >
      <div className="text-[14px] font-bold">นับเงินสด · Cash counting</div>

      <div className="flex flex-col gap-[9px]">
        <CashRow label="เงินทอนเปิดรอบ · Opening" value={money(openingFloat)} />
        <CashRow label="ขายเงินสด · Cash sales" value={`+${money(cashSales)}`} />
        <CashRow label="คืนเงินสด · Cash refunds" value={`−${money(cashRefunds)}`} />
        <div
          className="flex items-center justify-between border-t border-dashed pt-[9px] text-[13.5px] font-bold"
          style={{ borderColor: "var(--line-strong)", color: "var(--ink)" }}
        >
          <span>เงินสดที่ควรมี · Expected</span>
          <span className="mono">{money(expectedCash)}</span>
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[13px]" style={{ color: "var(--soft)" }}>
          เงินสดนับจริง · Counted cash
        </div>
        <div
          className="flex h-[52px] items-center gap-2 rounded-[11px] border px-3.5"
          style={{ borderColor: "var(--line)", borderWidth: 1.5 }}
        >
          <span className="mono text-[18px]" style={{ color: "var(--soft)" }}>
            ฿
          </span>
          <input
            value={counted}
            onChange={(e) => onCountedChange(e.target.value)}
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            aria-label="เงินสดนับจริง"
            className="mono min-w-0 flex-1 border-0 bg-transparent text-right text-[22px] font-semibold outline-none"
          />
        </div>
      </div>

      {hasCounted && (
        <div
          className="flex items-center justify-between rounded-[12px] border px-[15px] py-[13px]"
          style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
        >
          <span className="text-[13.5px] font-semibold" style={{ color: "#475569" }}>
            ผลต่าง · Variance
          </span>
          <span className="mono text-[20px] font-bold" style={{ color: varianceColor }}>
            {varianceStr}
          </span>
        </div>
      )}

      <div className="flex-1" />

      {dailySummaryNo && (
        <div
          className="rounded-[12px] border p-3.5 text-center"
          style={{ background: "#f0fdf4", borderColor: "#bbf7d0" }}
        >
          <div className="text-[13.5px] font-bold" style={{ color: "#15803d" }}>
            ปิดรอบเรียบร้อย ✓
          </div>
          <div className="mt-0.5 text-[11.5px]" style={{ color: "#16a34a" }}>
            สร้างสรุปบัญชีรายวัน {dailySummaryNo} แล้ว
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={onClose}
        disabled={closing || dailySummaryNo !== null}
        className="flex h-[52px] items-center justify-center gap-[9px] rounded-[13px] text-[15px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
        style={{
          background: "linear-gradient(180deg,#16a34a,#15803d)",
          boxShadow: "0 6px 16px rgba(22,163,74,.25)",
        }}
      >
        {closing
          ? "กำลังปิดรอบ…"
          : dailySummaryNo
          ? "ปิดรอบแล้ว"
          : "ปิดรอบ + สร้างสรุปบัญชีรายวัน"}
      </button>
      <div className="text-center text-[11px]" style={{ color: "var(--soft)" }}>
        Close shift &amp; generate daily accounting summary
      </div>
    </div>
  );
}

function CashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[13px]" style={{ color: "#64748b" }}>
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

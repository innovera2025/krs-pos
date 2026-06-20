"use client";

import { money } from "@/lib/money";

type KpiCardsProps = {
  grossSales: string;
  shiftNumber: string;
  openedAt: string;
  txnCount: number;
};

/**
 * Dark forest KPI card (display: gross sales + shift number + open time + txn
 * count), ported from the Simple POS source-of-truth `#0f172a` gross-sales card
 * into the Taste forest palette.
 */
export function KpiCards({ grossSales, shiftNumber, openedAt, txnCount }: KpiCardsProps) {
  const openTime = formatOpenTime(openedAt);
  return (
    <div
      className="rounded-[16px] px-[22px] py-5 text-white"
      style={{ background: "linear-gradient(155deg,#103d30,#0a211b)" }}
    >
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px]" style={{ color: "#93c5b1" }}>
            ยอดขายรวมรอบนี้ · Gross sales
          </div>
          <div className="mono mt-0.5 text-[32px] font-bold">{money(grossSales)}</div>
        </div>
        <div className="text-right">
          <div className="text-[12px]" style={{ color: "#93c5b1" }}>
            รอบ {shiftNumber}
          </div>
          <div className="text-[12px]" style={{ color: "#cbd5e1" }}>
            เปิด {openTime} · {txnCount} บิล
          </div>
        </div>
      </div>
    </div>
  );
}

function formatOpenTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("th-TH", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
  });
}

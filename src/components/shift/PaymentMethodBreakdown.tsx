"use client";

import { money } from "@/lib/money";
import type { ZReportMethod } from "@/types";

type PaymentMethodBreakdownProps = {
  methods: ZReportMethod[];
};

/**
 * Sales-by-payment-method breakdown (display-payment-method-breakdown), ported
 * from the Simple POS shiftMethods list into a Taste panel. Each row is
 * label · count บิล · amount (mono, right).
 */
export function PaymentMethodBreakdown({ methods }: PaymentMethodBreakdownProps) {
  return (
    <div
      className="rounded-[16px] border bg-white px-5 py-[18px]"
      style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
    >
      <div className="mb-3.5 text-[14px] font-bold">
        ยอดขายแยกตามวิธีชำระ · Sales by payment method
      </div>
      {methods.length === 0 ? (
        <div className="py-4 text-center text-[12.5px]" style={{ color: "var(--soft)" }}>
          ยังไม่มียอดขายในรอบนี้
        </div>
      ) : (
        methods.map((m) => (
          <div
            key={m.method}
            className="flex items-center gap-3 border-b py-2.5 last:border-b-0"
            style={{ borderColor: "#f4f7fa" }}
          >
            <div className="flex-1">
              <span className="text-[13.5px] font-semibold" style={{ color: "#334155" }}>
                {m.label}
              </span>{" "}
              <span className="text-[11.5px]" style={{ color: "var(--soft)" }}>
                · {m.count} บิล
              </span>
            </div>
            <div className="mono text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
              {money(m.amount)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

"use client";

import { money } from "@/lib/money";

/** One per-promotion Z-report breakdown row (line-level + bill-level merged). */
export type PromoBreakdownRow = {
  promotionId: string;
  promotionName: string | null;
  orders: number;
  amount: string;
};

/**
 * Phase 8 additions to the Z-report payload. Defined LOCALLY here (not in
 * src/types/index.ts) so this phase never touches the shared types file while the
 * POS UI is edited concurrently. The shift page casts `data.zReport` to this shape
 * at the call boundary.
 */
export type ZReportPromoFields = {
  promoDiscountTotal: string;
  manualDiscountTotal: string;
  promoBreakdown: PromoBreakdownRow[];
};

/**
 * Promotions summary card for the Z-report (promotions program, Phase 8). Splits
 * the shift's discounts into promotion vs. cashier-entered (manual) — using the
 * system-wide color coding (promo = mint green var(--brand-2); manual = blue
 * var(--blue)) — and lists the per-promotion breakdown (name · n บิล · −฿amount).
 *
 * NOTE ON SCOPE: the existing "ส่วนลด · Discounts" card shows Σ Order.discount
 * (bill-level total only). The numbers here INCLUDE line-level discounts folded
 * into lineTotal, so they intentionally report a wider figure than that card.
 */
export function PromotionSummaryCard({ zReport }: { zReport: ZReportPromoFields }) {
  const { promoDiscountTotal, manualDiscountTotal, promoBreakdown } = zReport;

  return (
    <div
      className="rounded-[16px] border bg-white px-5 py-[18px]"
      style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
    >
      <div className="mb-3.5 text-[14px] font-bold">
        ส่วนลดโปรโมชัน · Promotions
      </div>

      {/* Promo vs. manual split (both numbers visible; system color coding). */}
      <div className="grid grid-cols-2 gap-3">
        <div
          className="rounded-[12px] border px-3.5 py-3"
          style={{ background: "var(--mint)", borderColor: "var(--line)" }}
        >
          <div className="text-[12px]" style={{ color: "var(--brand-2)" }}>
            โปรโมชัน · Promotions
          </div>
          <div
            className="mono mt-[3px] text-[18px] font-bold"
            style={{ color: "var(--brand-2)" }}
          >
            −{money(promoDiscountTotal)}
          </div>
        </div>
        <div
          className="rounded-[12px] border px-3.5 py-3"
          style={{ background: "var(--blue-soft)", borderColor: "var(--line)" }}
        >
          <div className="text-[12px]" style={{ color: "var(--blue)" }}>
            ที่พนักงานกดเอง · Manual
          </div>
          <div
            className="mono mt-[3px] text-[18px] font-bold"
            style={{ color: "var(--blue)" }}
          >
            −{money(manualDiscountTotal)}
          </div>
        </div>
      </div>

      {/* Per-promotion breakdown list. */}
      <div className="mt-3.5">
        <div className="mb-1.5 text-[12px]" style={{ color: "var(--soft)" }}>
          แยกตามโปรโมชัน · By promotion
        </div>
        {promoBreakdown.length === 0 ? (
          <div className="py-3 text-center text-[12.5px]" style={{ color: "var(--soft)" }}>
            ยังไม่มีส่วนลดโปรโมชันในรอบนี้
          </div>
        ) : (
          promoBreakdown.map((p) => (
            <div
              key={p.promotionId}
              className="flex items-center gap-3 border-b py-2.5 last:border-b-0"
              style={{ borderColor: "#f4f7fa" }}
            >
              <div className="flex-1">
                <span
                  className="text-[13.5px] font-semibold"
                  style={{ color: "#334155" }}
                >
                  {p.promotionName ?? "โปรโมชัน"}
                </span>{" "}
                <span className="text-[11.5px]" style={{ color: "var(--soft)" }}>
                  · {p.orders} บิล
                </span>
              </div>
              <div
                className="mono text-[14px] font-semibold"
                style={{ color: "var(--brand-2)" }}
              >
                −{money(p.amount)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

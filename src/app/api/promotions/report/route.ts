import { NextResponse } from "next/server";
import { OrderStatus, type PromotionType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireStrictAdmin } from "@/lib/auth";
import { bangkokDateParts, bangkokDayWindow } from "@/lib/datetime";
import { satangToString, toSatang } from "@/lib/orderSerialize";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * GET /api/promotions/report?from=YYYY-MM-DD&to=YYYY-MM-DD — date-range promotion
 * sales report (promotions program, Phase 9). STRICT-ADMIN only (owner-only, the
 * same gate as the rest of the promotions surface — MANAGER is excluded).
 *
 * Money discipline mirrors the Z-report (shift/route.ts, Phase 8): every aggregate
 * is summed in integer satang and serialized as a 2dp baht STRING via
 * satangToString — never Number() — to avoid float drift across many bills. Scope
 * is COMPLETED-only (the money-aggregate rule); REFUNDED/VOIDED bills never count.
 *
 * DATE SEMANTICS: `from`/`to` are Asia/Bangkok CALENDAR dates, INCLUSIVE on both
 * ends. They convert to a UTC instant window [from-00:00 Bangkok, to+1day-00:00
 * Bangkok) — the SAME half-open convention the promotion form uses (from → 00:00
 * Bangkok that day; to → 00:00 Bangkok of the day AFTER as the exclusive bound),
 * built from the shared Bangkok helpers in src/lib/datetime.ts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Max span (inclusive days) — guards an unbounded index scan on a huge range. */
const MAX_RANGE_DAYS = 366;

/** `YYYY-MM-DD` for the Asia/Bangkok calendar date of an instant. */
function bangkokDateStr(now: Date): string {
  const { y, m, d } = bangkokDateParts(now);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parse a `YYYY-MM-DD` string as a Bangkok calendar date and return its
 * [startOfDay, startOfNextDay) UTC window. Returns null for a malformed or
 * impossible date (e.g. 2026-02-30). Noon Bangkok (05:00 UTC) unambiguously lands
 * INSIDE the target Bangkok day, so bangkokDayWindow yields that day's window;
 * round-tripping the Bangkok date parts back to the input rejects overflow dates
 * (Feb 30 → Mar 2 would not round-trip).
 */
function parseBangkokDay(
  s: string
): { start: Date; nextDay: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const noonBangkok = new Date(Date.UTC(y, m - 1, d, 5, 0, 0, 0));
  const parts = bangkokDateParts(noonBangkok);
  if (parts.y !== y || parts.m !== m || parts.d !== d) return null;
  const { startOfDay, startOfNextDay } = bangkokDayWindow(noonBangkok);
  return { start: startOfDay, nextDay: startOfNextDay };
}

/**
 * Per-promotion aggregate row (line-level OR bill-level — a promotion appears at
 * exactly ONE level because `PromotionType` is immutable and the line types 1-3
 * write `OrderItem.promotionId` while BILL_THRESHOLD writes `Order.billPromotionId`).
 * `orderIds` is a Set so DISTINCT bills are counted even when a line promo appears
 * on several lines of the same bill. `name` keeps the max snapshot (deterministic
 * regardless of row order).
 *
 * `salesSatang` attribution DIFFERS BY LEVEL, by design:
 *   LINE → Σ OrderItem.lineTotal of the lines carrying the promo (line revenue).
 *   BILL → Σ Order.total of the bills the promo applied to (whole-bill revenue).
 */
type PromoRowAgg = {
  name: string | null;
  orderIds: Set<string>;
  discountSatang: number;
  salesSatang: number;
  level: "LINE" | "BILL";
};

export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireStrictAdmin();
    if ("response" in gate) return gate.response;

    try {
      const url = new URL(req.url);
      const today = bangkokDateStr(new Date());
      // Missing / empty params default to today (Bangkok) on BOTH ends.
      const fromStr = (url.searchParams.get("from") || "").trim() || today;
      const toStr = (url.searchParams.get("to") || "").trim() || today;

      const fromWin = parseBangkokDay(fromStr);
      const toWin = parseBangkokDay(toStr);
      if (!fromWin || !toWin) {
        return NextResponse.json(
          { error: "รูปแบบวันที่ไม่ถูกต้อง", code: "BAD_DATE" },
          { status: 400 }
        );
      }
      if (fromWin.start.getTime() > toWin.start.getTime()) {
        return NextResponse.json(
          { error: "ช่วงวันที่ไม่ถูกต้อง (จากต้องไม่เกินถึง)", code: "BAD_DATE_WINDOW" },
          { status: 400 }
        );
      }
      // Inclusive-day span = (exclusive end − inclusive start) / 1 day. Bangkok has
      // no DST, so every day is exactly DAY_MS and the division is exact.
      const spanDays = Math.round(
        (toWin.nextDay.getTime() - fromWin.start.getTime()) / DAY_MS
      );
      if (spanDays > MAX_RANGE_DAYS) {
        return NextResponse.json(
          { error: "ช่วงวันที่กว้างเกินไป (สูงสุด 366 วัน)", code: "RANGE_TOO_LARGE" },
          { status: 400 }
        );
      }

      const windowFilter = {
        status: OrderStatus.COMPLETED,
        createdAt: { gte: fromWin.start, lt: toWin.nextDay },
      } as const;

      // Completed orders in the window — header (bill-level) promo fields. Uses the
      // @@index([status, createdAt]) composite.
      const orders = await prisma.order.findMany({
        where: windowFilter,
        select: {
          id: true,
          total: true,
          promoBillDiscount: true,
          billPromotionId: true,
          billPromotionName: true,
        },
      });

      // Line items of those same in-scope orders (filter via the order relation, as
      // the shift route does with shiftId) — line-level promo fields.
      const items = await prisma.orderItem.findMany({
        where: { order: windowFilter },
        select: {
          orderId: true,
          lineTotal: true,
          promoDiscount: true,
          promotionId: true,
          promotionName: true,
        },
      });

      // Per-promotion accumulator + header totals — all integer satang.
      const promoAgg = new Map<string, PromoRowAgg>();
      function accumulate(
        promotionId: string,
        name: string | null,
        orderId: string,
        discountSatang: number,
        salesSatang: number,
        level: "LINE" | "BILL"
      ) {
        const existing = promoAgg.get(promotionId);
        if (existing) {
          existing.orderIds.add(orderId);
          existing.discountSatang += discountSatang;
          existing.salesSatang += salesSatang;
          if (name && (existing.name === null || name > existing.name)) {
            existing.name = name;
          }
          // level is never overwritten — a promo lives at one level (type immutable).
        } else {
          promoAgg.set(promotionId, {
            name,
            orderIds: new Set([orderId]),
            discountSatang,
            salesSatang,
            level,
          });
        }
      }

      // Distinct bills carrying ANY promotion (bill-level OR any line-level).
      const ordersWithPromo = new Set<string>();
      let promoDiscountTotalSatang = 0;

      for (const o of orders) {
        const billPromo = toSatang(o.promoBillDiscount);
        promoDiscountTotalSatang += billPromo;
        if (o.billPromotionId) {
          ordersWithPromo.add(o.id);
          accumulate(
            o.billPromotionId,
            o.billPromotionName,
            o.id,
            billPromo,
            toSatang(o.total),
            "BILL"
          );
        }
      }

      for (const it of items) {
        const linePromo = toSatang(it.promoDiscount);
        promoDiscountTotalSatang += linePromo;
        if (it.promotionId) {
          ordersWithPromo.add(it.orderId);
          accumulate(
            it.promotionId,
            it.promotionName,
            it.orderId,
            linePromo,
            toSatang(it.lineTotal),
            "LINE"
          );
        }
      }

      // Resolve the CURRENT type of each promotion (one findMany). A promo is only
      // ever soft-deleted (the DB role has no DELETE), so the row normally still
      // exists; tolerate a missing row → type null (defensive).
      const promoIds = [...promoAgg.keys()];
      const typeRows = promoIds.length
        ? await prisma.promotion.findMany({
            where: { id: { in: promoIds } },
            select: { id: true, type: true },
          })
        : [];
      const typeById = new Map<string, PromotionType>(
        typeRows.map((p) => [p.id, p.type])
      );

      const rows = [...promoAgg.entries()]
        .map(([promotionId, agg]) => ({
          promotionId,
          promotionName: agg.name,
          type: typeById.get(promotionId) ?? null,
          level: agg.level,
          orders: agg.orderIds.size,
          discount: satangToString(agg.discountSatang),
          sales: satangToString(agg.salesSatang),
          _discountSatang: agg.discountSatang,
        }))
        .sort((a, b) => b._discountSatang - a._discountSatang)
        .map(({ _discountSatang: _omit, ...rest }) => rest);

      return NextResponse.json({
        range: { from: fromStr, to: toStr },
        ordersTotal: orders.length,
        ordersWithPromo: ordersWithPromo.size,
        promoDiscountTotal: satangToString(promoDiscountTotalSatang),
        rows,
      });
    } catch (err) {
      logger.error({ err }, "GET /api/promotions/report failed");
      return NextResponse.json(
        { error: "ไม่สามารถโหลดรายงานได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

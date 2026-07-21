import { NextResponse } from "next/server";
import { OrderStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { bangkokDateParts, bangkokDayWindow } from "@/lib/datetime";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * GET /api/loyalty/report?from=YYYY-MM-DD&to=YYYY-MM-DD — date-range loyalty POINTS
 * report (loyalty program, Phase 1B). Open to EVERY signed-in role via `requireUser`
 * — the same gate as the /members surface. Scope is COMPLETED-only (the money-
 * aggregate rule) AND member-only (`customer.isMember = true`); REFUNDED/VOIDED bills
 * and walk-in / non-member sales never count.
 *
 * ALL FIGURES ARE POINTS (plain Int) — there is NO Decimal / money field, so no
 * satang serializer is involved (unlike the promotions report). `pointsRedeemed`
 * reads the existing `Order.pointsRedeemed` column; it is 0 for every bill until the
 * redemption path lands in Phase 2, and the field is surfaced now so the UI shape is
 * stable.
 *
 * DATE SEMANTICS: `from`/`to` are Asia/Bangkok CALENDAR dates, INCLUSIVE on both ends,
 * converted to a UTC instant window [from-00:00 Bangkok, to+1day-00:00 Bangkok) — the
 * SAME half-open convention the promotions report uses, via the shared Bangkok helpers
 * in src/lib/datetime.ts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Max span (inclusive days) — guards an unbounded index scan on a huge range. */
const MAX_RANGE_DAYS = 366;
/** Per-member breakdown size (top earners). */
const TOP_MEMBERS = 20;

/** `YYYY-MM-DD` for the Asia/Bangkok calendar date of an instant. */
function bangkokDateStr(now: Date): string {
  const { y, m, d } = bangkokDateParts(now);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parse a `YYYY-MM-DD` string as a Bangkok calendar date and return its
 * [startOfDay, startOfNextDay) UTC window. Returns null for a malformed or impossible
 * date (e.g. 2026-02-30). Noon Bangkok (05:00 UTC) unambiguously lands INSIDE the
 * target Bangkok day; round-tripping the Bangkok date parts back to the input rejects
 * overflow dates. Identical to the promotions-report helper.
 */
function parseBangkokDay(s: string): { start: Date; nextDay: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const noonBangkok = new Date(Date.UTC(y, m - 1, d, 5, 0, 0, 0));
  const parts = bangkokDateParts(noonBangkok);
  if (parts.y !== y || parts.m !== m || parts.d !== d) return null;
  const { startOfDay, startOfNextDay } = bangkokDayWindow(noonBangkok);
  return { start: startOfDay, nextDay: startOfNextDay };
}

/** Per-member points accumulator over the window. */
type MemberAgg = {
  name: string | null;
  phone: string | null;
  earned: number;
  redeemed: number;
  orders: number;
};

export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
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
      // Inclusive-day span. Bangkok has no DST, so every day is exactly DAY_MS.
      const spanDays = Math.round(
        (toWin.nextDay.getTime() - fromWin.start.getTime()) / DAY_MS
      );
      if (spanDays > MAX_RANGE_DAYS) {
        return NextResponse.json(
          { error: "ช่วงวันที่กว้างเกินไป (สูงสุด 366 วัน)", code: "RANGE_TOO_LARGE" },
          { status: 400 }
        );
      }

      // COMPLETED, member-attributed orders in the window. `customer: { isMember }`
      // filters to member sales; the loyalty point columns are plain Ints (no money
      // serializer). Uses the @@index([status, createdAt]) composite for the range.
      const orders = await prisma.order.findMany({
        where: {
          status: OrderStatus.COMPLETED,
          createdAt: { gte: fromWin.start, lt: toWin.nextDay },
          customer: { isMember: true },
        },
        select: {
          customerId: true,
          pointsEarned: true,
          pointsRedeemed: true,
          customer: { select: { name: true, phone: true } },
        },
      });

      let pointsEarnedTotal = 0;
      let pointsRedeemedTotal = 0;
      let ordersWithEarn = 0;
      const byMember = new Map<string, MemberAgg>();

      for (const o of orders) {
        pointsEarnedTotal += o.pointsEarned;
        pointsRedeemedTotal += o.pointsRedeemed;
        if (o.pointsEarned > 0) ordersWithEarn += 1;

        // customerId is non-null here (the where filters to member customers), but
        // guard defensively so a null can never key the breakdown map.
        const key = o.customerId;
        if (!key) continue;
        const existing = byMember.get(key);
        if (existing) {
          existing.earned += o.pointsEarned;
          existing.redeemed += o.pointsRedeemed;
          existing.orders += 1;
        } else {
          byMember.set(key, {
            name: o.customer?.name ?? null,
            phone: o.customer?.phone ?? null,
            earned: o.pointsEarned,
            redeemed: o.pointsRedeemed,
            orders: 1,
          });
        }
      }

      const topMembers = [...byMember.entries()]
        .map(([customerId, agg]) => ({
          customerId,
          name: agg.name,
          phone: agg.phone,
          pointsEarned: agg.earned,
          pointsRedeemed: agg.redeemed,
          orders: agg.orders,
        }))
        .sort((a, b) => b.pointsEarned - a.pointsEarned)
        .slice(0, TOP_MEMBERS);

      return NextResponse.json({
        range: { from: fromStr, to: toStr },
        pointsEarnedTotal,
        pointsRedeemedTotal,
        ordersWithEarn,
        memberOrders: orders.length,
        topMembers,
      });
    } catch (err) {
      logger.error({ err }, "GET /api/loyalty/report failed");
      return NextResponse.json(
        { error: "ไม่สามารถโหลดรายงานแต้มได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

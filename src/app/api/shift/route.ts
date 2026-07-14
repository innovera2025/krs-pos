import { NextResponse } from "next/server";
import { Prisma, OrderStatus, PaymentType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { bangkokYyyymmdd, bangkokDayWindow } from "@/lib/datetime";
import { methodLabel } from "@/components/pos/paymentMeta";
import { requireUser } from "@/lib/auth";
// WRAP-style Zod (D1): validate the action SHAPE only. Money bounds are validated
// MANUALLY below (Number(raw) coercion, mirroring the existing close-path pattern,
// so a numeric string like "50" is still accepted). The invalid-action case keeps
// the existing 400 BAD_ACTION; the route keeps round2(), the SHIFT_ALREADY_OPEN /
// NO_OPEN_SHIFT gates, and the close-path no-count handling.
import { ShiftActionSchema } from "@/lib/schemas/shift";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// Shift lifecycle + Z-report (Phase 5: flow-shift-lifecycle, screen-shift-close).
//
// Money discipline: every aggregate is summed in integer satang (1 baht = 100
// satang) and serialized as a String via `.toFixed(2)` — never `Number()` — to
// avoid float drift across many bills (Decimal→String, matching the Phase 3
// precedent). The full end-to-end Decimal recompute is production-readiness.
//
// AUTH (auth Phase 2): requireUser on BOTH GET and POST — the shift screen is
// available to both roles (a cashier opens/closes their own shift), so any
// authenticated active session is the correct gate (NOT admin).
// TODO(production-readiness): audit trail and idempotency on open/close.

/** Convert a Prisma Decimal | string | number to integer satang. */
function toSatang(v: Prisma.Decimal | string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  // Prisma.Decimal has a precise toString; parse via integer-satang to stay exact.
  const str = typeof v === "object" ? v.toString() : String(v);
  const n = Number(str);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

/** Format integer satang as a 2dp baht string (e.g. 19234 -> "192.34"). */
function satangToString(satang: number): string {
  return (satang / 100).toFixed(2);
}

const SHIFT_SELECT = {
  id: true,
  shiftNumber: true,
  status: true,
  openedAt: true,
  closedAt: true,
  openingFloat: true,
  countedCash: true,
  cashierId: true,
  branchId: true,
} as const;

/** Serialize a Shift row with money fields as strings. */
function serializeShift(shift: {
  id: string;
  shiftNumber: string;
  status: string;
  openedAt: Date;
  closedAt: Date | null;
  openingFloat: Prisma.Decimal;
  countedCash: Prisma.Decimal | null;
  cashierId: string | null;
  branchId: string;
}) {
  return {
    id: shift.id,
    shiftNumber: shift.shiftNumber,
    status: shift.status,
    openedAt: shift.openedAt.toISOString(),
    closedAt: shift.closedAt ? shift.closedAt.toISOString() : null,
    openingFloat: satangToString(toSatang(shift.openingFloat)),
    countedCash:
      shift.countedCash === null ? null : satangToString(toSatang(shift.countedCash)),
    cashierId: shift.cashierId,
    branchId: shift.branchId,
  };
}

/**
 * Compute Z-report aggregates for a shift from its orders (by shiftId).
 * All sums are integer satang; the returned values are 2dp strings.
 */
async function buildZReport(shiftId: string, openingFloatSatang: number) {
  // Completed orders drive gross sales / VAT / discounts.
  //
  // Promotions program (Phase 8): the select is EXTENDED (additive) with the
  // bill-level promo columns so the promo breakdown + manual/promo split are
  // computed in JS integer satang — the same money discipline as the rest of
  // this route. `promoBillDiscount` is the promo SLICE of `discount` (manual
  // bill slice = discount − promoBillDiscount); `billPromotionId` /
  // `billPromotionName` snapshot the applied BILL_THRESHOLD promo. `id` is
  // needed to count DISTINCT bills per promotion. The pre-existing gross/VAT/
  // discount sums below are byte-identical (only new fields were added).
  const completed = await prisma.order.findMany({
    where: { shiftId, status: OrderStatus.COMPLETED },
    select: {
      id: true,
      total: true,
      tax: true,
      discount: true,
      promoBillDiscount: true,
      billPromotionId: true,
      billPromotionName: true,
    },
  });
  // Refunded orders drive refundsTotal (their total is stored negative).
  const refunded = await prisma.order.findMany({
    where: { shiftId, status: OrderStatus.REFUNDED },
    select: { total: true },
  });

  // Per-promotion breakdown accumulator (line-level + bill-level merged by
  // promotionId). `orderIds` is a Set so DISTINCT bills are counted even when a
  // promotion appears on several lines of the same bill. `name` snapshots are
  // identical per promo; we keep the max (deterministic regardless of row order).
  type PromoAgg = { name: string | null; orderIds: Set<string>; amountSatang: number };
  const promoAgg = new Map<string, PromoAgg>();
  function accumulatePromo(
    promotionId: string,
    name: string | null,
    orderId: string,
    amountSatang: number
  ) {
    const existing = promoAgg.get(promotionId);
    if (existing) {
      existing.orderIds.add(orderId);
      existing.amountSatang += amountSatang;
      if (name && (existing.name === null || name > existing.name)) existing.name = name;
    } else {
      promoAgg.set(promotionId, {
        name,
        orderIds: new Set([orderId]),
        amountSatang,
      });
    }
  }

  let grossSatang = 0;
  let vatSatang = 0;
  let discountSatang = 0;
  // Σ Order.promoBillDiscount — the bill-level promo slice of `discount`.
  let promoBillSatang = 0;
  for (const o of completed) {
    grossSatang += toSatang(o.total);
    vatSatang += toSatang(o.tax);
    discountSatang += toSatang(o.discount);
    const oPromoBill = toSatang(o.promoBillDiscount);
    promoBillSatang += oPromoBill;
    if (o.billPromotionId) {
      accumulatePromo(o.billPromotionId, o.billPromotionName, o.id, oPromoBill);
    }
  }
  const txnCount = completed.length;

  // Line-level promo/manual split (Phase 8). Fetch the minimal OrderItem fields
  // for this shift's COMPLETED orders and sum in JS integer satang — Prisma's
  // `_sum` cannot multiply two columns (unitPrice × quantity), so a per-row JS
  // pass is the cheapest correct query (single findMany, no raw SQL). Per the
  // Money Contract `lineTotal = unitPrice×qty − manualLine − promoDiscount`, so:
  //   line promo   = promoDiscount
  //   line manual  = unitPrice×qty − lineTotal − promoDiscount  (≥ 0 by invariant)
  const items = await prisma.orderItem.findMany({
    where: { order: { shiftId, status: OrderStatus.COMPLETED } },
    select: {
      orderId: true,
      quantity: true,
      unitPrice: true,
      lineTotal: true,
      promoDiscount: true,
      promotionId: true,
      promotionName: true,
    },
  });
  let linePromoSatang = 0;
  let lineManualSatang = 0;
  for (const it of items) {
    const grossLineSatang = toSatang(it.unitPrice) * it.quantity;
    const promoSatang = toSatang(it.promoDiscount);
    linePromoSatang += promoSatang;
    lineManualSatang += grossLineSatang - toSatang(it.lineTotal) - promoSatang;
    if (it.promotionId) {
      accumulatePromo(it.promotionId, it.promotionName, it.orderId, promoSatang);
    }
  }

  // Promo total = bill promo + line promo; manual total = bill manual + line
  // manual (bill manual = discount − promoBillDiscount, per the Money Contract).
  const promoDiscountSatang = promoBillSatang + linePromoSatang;
  const manualDiscountSatang = discountSatang - promoBillSatang + lineManualSatang;

  const promoBreakdown = [...promoAgg.entries()]
    .map(([promotionId, agg]) => ({
      promotionId,
      promotionName: agg.name,
      orders: agg.orderIds.size,
      amount: satangToString(agg.amountSatang),
      amountSatang: agg.amountSatang,
    }))
    .sort((a, b) => b.amountSatang - a.amountSatang)
    .map(({ amountSatang: _omit, ...rest }) => rest);

  // refundsTotal: magnitude of refunded order totals (stored negative → abs).
  let refundsSatang = 0;
  for (const o of refunded) refundsSatang += Math.abs(toSatang(o.total));

  // By-payment-method breakdown over the shift's COMPLETED orders (groupBy on
  // PaymentLine). The completed-status filter excludes REFUNDED/VOIDED bills so
  // this panel reconciles with grossSales/cashSales (COMPLETED-only) above.
  const grouped = await prisma.paymentLine.groupBy({
    by: ["method"],
    where: { order: { shiftId, status: OrderStatus.COMPLETED } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const byMethod = grouped
    .map((g) => ({
      method: g.method,
      label: methodLabel(String(g.method).toLowerCase()),
      count: g._count._all,
      amount: satangToString(toSatang(g._sum.amount)),
      amountSatang: toSatang(g._sum.amount),
    }))
    .sort((a, b) => b.amountSatang - a.amountSatang)
    .map(({ amountSatang: _omit, ...rest }) => rest);

  // Cash flows: cash PaymentLines on COMPLETED vs REFUNDED orders.
  const cashSalesAgg = await prisma.paymentLine.aggregate({
    where: {
      method: PaymentType.CASH,
      order: { shiftId, status: OrderStatus.COMPLETED },
    },
    _sum: { amount: true },
  });
  const cashRefundsAgg = await prisma.paymentLine.aggregate({
    where: {
      method: PaymentType.CASH,
      order: { shiftId, status: OrderStatus.REFUNDED },
    },
    _sum: { amount: true },
  });
  const cashSalesSatang = toSatang(cashSalesAgg._sum.amount);
  // Refund cash lines may be stored negative; expected cash subtracts their abs.
  const cashRefundsSatang = Math.abs(toSatang(cashRefundsAgg._sum.amount));

  const expectedCashSatang =
    openingFloatSatang + cashSalesSatang - cashRefundsSatang;

  return {
    grossSales: satangToString(grossSatang),
    txnCount,
    byMethod,
    refundsTotal: satangToString(refundsSatang),
    discountsTotal: satangToString(discountSatang),
    // Promotions program (Phase 8) — additive Z-report fields. `discountsTotal`
    // above KEEPS its meaning (Σ Order.discount = bill-level total). These new
    // fields report the promo/manual split INCLUDING line-level discounts (which
    // are folded into lineTotal, not into Order.discount), plus a per-promotion
    // breakdown. All COMPLETED-only, Decimal→2dp-string.
    promoDiscountTotal: satangToString(promoDiscountSatang),
    manualDiscountTotal: satangToString(manualDiscountSatang),
    promoBreakdown,
    vatTotal: satangToString(vatSatang),
    cashSales: satangToString(cashSalesSatang),
    cashRefunds: satangToString(cashRefundsSatang),
    openingFloat: satangToString(openingFloatSatang),
    expectedCash: satangToString(expectedCashSatang),
  };
}

// GET /api/shift — the current OPEN shift (or the most recent shift) plus the
// Z-report aggregates for that shift. Returns { shift, zReport } or
// { shift: null, zReport: null } when no shift has ever been opened.
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    try {
      const shift =
        (await prisma.shift.findFirst({
          where: { status: "OPEN" },
          orderBy: { openedAt: "desc" },
          select: SHIFT_SELECT,
        })) ??
        (await prisma.shift.findFirst({
          orderBy: { openedAt: "desc" },
          select: SHIFT_SELECT,
        }));

      if (!shift) {
        return NextResponse.json({ shift: null, zReport: null });
      }

      const zReport = await buildZReport(shift.id, toSatang(shift.openingFloat));
      return NextResponse.json({ shift: serializeShift(shift), zReport });
    } catch (err) {
      logger.error({ err }, "GET /api/shift failed");
      return NextResponse.json(
        { error: "Could not load shift", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

type ShiftPostBody = {
  action?: unknown;
  openingFloat?: unknown;
  countedCash?: unknown;
};

/** Round a baht number to 2dp via integer satang (guards non-finite). */
function round2(baht: number): number {
  if (!Number.isFinite(baht)) return 0;
  return Math.round(baht * 100) / 100;
}

/**
 * Next shift number: SH-YYYYMMDD-## where ## = (count of shifts opened today, in
 * Asia/Bangkok) + 1, zero-padded to 2.
 */
async function nextShiftNumber(now: Date): Promise<string> {
  const yyyymmdd = bangkokYyyymmdd(now);
  const { startOfDay, startOfNextDay } = bangkokDayWindow(now);
  const countToday = await prisma.shift.count({
    where: { openedAt: { gte: startOfDay, lt: startOfNextDay } },
  });
  const seq = String(countToday + 1).padStart(2, "0");
  return `SH-${yyyymmdd}-${seq}`;
}

// POST /api/shift — open or close a shift.
//   { action: "open", openingFloat } — 409 SHIFT_ALREADY_OPEN if one is open;
//     else creates an OPEN shift with SH-YYYYMMDD-## and the opening float.
//   { action: "close", countedCash } — 409 NO_OPEN_SHIFT if none open; else marks
//     the open shift CLOSED with closedAt + countedCash, returns the daily
//     summary number DS-YYYYMMDD.
export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
  // Start time for the success request-log line (D3 — mutation route).
  const startedAt = Date.now();
  const gate = await requireUser();
  if ("response" in gate) return gate.response;

  let body: ShiftPostBody;
  try {
    body = (await req.json()) as ShiftPostBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // WRAP-style Zod validates the action SHAPE. On failure we keep the EXISTING 400
  // BAD_ACTION response (same code/status/message the client already handles). The
  // discriminated union also strips fields not belonging to the action; the money
  // bounds are validated manually below to mirror the close-path coercion behavior
  // (Number(raw)) exactly — accepting numeric strings as the close path already does.
  const actionParse = ShiftActionSchema.safeParse(body);
  if (!actionParse.success) {
    return NextResponse.json(
      { error: "action must be 'open' or 'close'", code: "BAD_ACTION" },
      { status: 400 }
    );
  }
  const action = actionParse.data.action;

  // Decimal(10,2) max — shared cap for both money inputs.
  const MONEY_MAX = 99_999_999.99;

  try {
    const now = new Date();

    if (action === "open") {
      const existingOpen = await prisma.shift.findFirst({
        where: { status: "OPEN" },
        select: { id: true },
      });
      if (existingOpen) {
        return NextResponse.json(
          { error: "มีรอบที่เปิดอยู่แล้ว", code: "SHIFT_ALREADY_OPEN" },
          { status: 409 }
        );
      }

      // §2B fix: validate the RAW openingFloat BEFORE round2 (round2 returns 0 for
      // non-finite input, so validating after rounding would let NaN/"abc" silently
      // open at 0). Mirrors the close-path countedCash pattern. Also caps at the
      // Decimal(10,2) max so an oversized float is a 400, not a 500 overflow.
      const floatRaw = Number(body.openingFloat ?? 0);
      if (!Number.isFinite(floatRaw) || floatRaw < 0 || floatRaw > MONEY_MAX) {
        return NextResponse.json(
          { error: "เงินทอนเปิดรอบไม่ถูกต้อง", code: "BAD_FLOAT" },
          { status: 400 }
        );
      }
      const openingFloat = round2(floatRaw);

      const shiftNumber = await nextShiftNumber(now);
      const created = await prisma.shift.create({
        data: {
          shiftNumber,
          status: "OPEN",
          openingFloat,
          openedAt: now,
        },
        select: SHIFT_SELECT,
      });
      const zReport = await buildZReport(created.id, toSatang(created.openingFloat));
      // Success request-log line (D3 — mutation route). No PII / no amounts.
      logger.info(
        { method: "POST", path: "/api/shift", status: 201, action, durationMs: Date.now() - startedAt },
        "shift opened"
      );
      return NextResponse.json(
        { shift: serializeShift(created), zReport },
        { status: 201 }
      );
    }

    // action === "close"
    const openShift = await prisma.shift.findFirst({
      where: { status: "OPEN" },
      orderBy: { openedAt: "desc" },
      select: { id: true },
    });
    if (!openShift) {
      return NextResponse.json(
        { error: "ไม่มีรอบที่เปิดอยู่", code: "NO_OPEN_SHIFT" },
        { status: 409 }
      );
    }

    const countedRaw = body.countedCash;
    const noCount =
      countedRaw === null || countedRaw === undefined || countedRaw === "";
    // Validate the RAW value first: round2 returns 0 for non-finite input, so
    // validating after rounding would let NaN silently close the shift at 0. The
    // MONEY_MAX cap matches the Decimal(10,2) column so an oversized count is a 400,
    // not a 500 overflow (consistent with the openingFloat fix above).
    const n = Number(countedRaw);
    if (!noCount && (!Number.isFinite(n) || n < 0 || n > MONEY_MAX)) {
      return NextResponse.json(
        { error: "เงินสดนับจริงไม่ถูกต้อง", code: "BAD_COUNTED" },
        { status: 400 }
      );
    }
    const counted = noCount ? null : round2(n);

    const closed = await prisma.shift.update({
      where: { id: openShift.id },
      data: {
        status: "CLOSED",
        closedAt: now,
        countedCash: counted,
      },
      select: SHIFT_SELECT,
    });

    const dailySummaryNo = `DS-${bangkokYyyymmdd(now)}`;
    // Success request-log line (D3 — mutation route). No PII / no amounts.
    logger.info(
      { method: "POST", path: "/api/shift", status: 200, action, durationMs: Date.now() - startedAt },
      "shift closed"
    );
    return NextResponse.json({
      shift: serializeShift(closed),
      dailySummaryNo,
    });
  } catch (err) {
    logger.error({ err }, "POST /api/shift failed");
    return NextResponse.json(
      { error: "Could not update shift", code: "INTERNAL" },
      { status: 500 }
    );
  }
  });
}

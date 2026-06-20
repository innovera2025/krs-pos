import { NextResponse } from "next/server";
import { Prisma, OrderStatus, PaymentType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { bangkokYyyymmdd, bangkokDayWindow } from "@/lib/datetime";
import { methodLabel } from "@/components/pos/paymentMeta";

// Shift lifecycle + Z-report (Phase 5: flow-shift-lifecycle, screen-shift-close).
//
// Money discipline: every aggregate is summed in integer satang (1 baht = 100
// satang) and serialized as a String via `.toFixed(2)` — never `Number()` — to
// avoid float drift across many bills (Decimal→String, matching the Phase 3
// precedent). The full end-to-end Decimal recompute is production-readiness.
// TODO(production-readiness): auth (only an authenticated cashier/manager may
// open/close), audit trail, and idempotency on open/close.

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
  const completed = await prisma.order.findMany({
    where: { shiftId, status: OrderStatus.COMPLETED },
    select: { total: true, tax: true, discount: true },
  });
  // Refunded orders drive refundsTotal (their total is stored negative).
  const refunded = await prisma.order.findMany({
    where: { shiftId, status: OrderStatus.REFUNDED },
    select: { total: true },
  });

  let grossSatang = 0;
  let vatSatang = 0;
  let discountSatang = 0;
  for (const o of completed) {
    grossSatang += toSatang(o.total);
    vatSatang += toSatang(o.tax);
    discountSatang += toSatang(o.discount);
  }
  const txnCount = completed.length;

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
export async function GET() {
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
    console.error("GET /api/shift failed:", err);
    return NextResponse.json(
      { error: "Could not load shift", code: "INTERNAL" },
      { status: 500 }
    );
  }
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
  let body: ShiftPostBody;
  try {
    body = (await req.json()) as ShiftPostBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const action = body.action;
  if (action !== "open" && action !== "close") {
    return NextResponse.json(
      { error: "action must be 'open' or 'close'", code: "BAD_ACTION" },
      { status: 400 }
    );
  }

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

      const openingFloat = round2(Number(body.openingFloat ?? 0));
      if (openingFloat < 0) {
        return NextResponse.json(
          { error: "เงินทอนเปิดรอบต้องไม่ติดลบ", code: "BAD_FLOAT" },
          { status: 400 }
        );
      }

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
    // validating after rounding would let NaN silently close the shift at 0.
    const n = Number(countedRaw);
    if (!noCount && (!Number.isFinite(n) || n < 0)) {
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
    return NextResponse.json({
      shift: serializeShift(closed),
      dailySummaryNo,
    });
  } catch (err) {
    console.error("POST /api/shift failed:", err);
    return NextResponse.json(
      { error: "Could not update shift", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

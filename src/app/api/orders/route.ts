import { NextResponse } from "next/server";
import {
  Prisma,
  PaymentType,
  OrderStatus,
  SyncStatus,
  StockMovementType,
  AuditAction,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { bangkokYyyymmdd, bangkokDayWindow } from "@/lib/datetime";
import { requireUser } from "@/lib/auth";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
import {
  computeOrderTotals,
  OrderProductMissingError,
  type BillDiscount,
  type OrderRequestLine,
} from "@/lib/pricing";
// Shared wire serializer + satang helpers (FIX 1): every order response
// (GET/POST here, and every PATCH return in [id]/route.ts) emits identical 2dp
// string money fields. The serializer lives in its own module so both route
// files can share it without coupling their include constants.
import {
  serializeOrder,
  toSatang,
  satangToString,
} from "@/lib/orderSerialize";

/** Valid OrderStatus values for the optional `?status=` filter (Phase 5 history). */
function isOrderStatus(v: string): v is OrderStatus {
  return (Object.values(OrderStatus) as string[]).includes(v);
}

/** Valid SyncStatus values for the optional `?sync=` filter (Phase 5 history). */
function isSyncStatus(v: string): v is SyncStatus {
  return (Object.values(SyncStatus) as string[]).includes(v);
}

/**
 * The relation graph returned by both GET and POST. Shared so the response shape
 * (and the explicit Decimal→string serializer in lib/orderSerialize) stay in
 * lock-step across handlers.
 */
const ORDER_INCLUDE = {
  items: { include: { product: true } },
  payments: true,
  cashier: { select: { id: true, name: true } },
  customer: true,
} satisfies Prisma.OrderInclude;

// GET /api/orders — list recent orders (Phase 5 Sales History).
//
// AUTH (security-review FIX A): requires an authenticated session. Sales history
// (/sales) is available to BOTH roles (cashier + admin), so requireUser (any
// authenticated active user) is the correct gate — NOT requireAdmin. Without this
// gate an anonymous request would leak the full sales ledger incl. Customer PII
// (name/taxId/phone/address), payment refs/amounts, cashier names, and totals.
//
// Optional query filters (validated against the enums; unknown values are
// ignored so a stray param never 500s the history page):
//   ?status=COMPLETED|REFUNDED|VOIDED|PENDING|CANCELLED
//   ?sync=PENDING|DAILY|SYNCED|FAILED|SKIPPED
// `payments` is included so the sales list + reprint (ReceiptModal) have tenders.
export async function GET(req: Request) {
  const gate = await requireUser();
  if ("response" in gate) return gate.response;

  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");
  const syncParam = searchParams.get("sync");

  const where: Prisma.OrderWhereInput = {};
  if (statusParam && isOrderStatus(statusParam)) where.status = statusParam;
  if (syncParam && isSyncStatus(syncParam)) where.syncStatus = syncParam;

  const orders = await prisma.order.findMany({
    where,
    include: ORDER_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json(orders.map(serializeOrder));
}

type IncomingItem = {
  productId: string;
  quantity: number;
  // Optional per-line discount in INTEGER SATANG (the cart's "ส่วนลดรายการ"
  // feature). The server clamps it to [0, line gross] and folds it into the
  // server recompute so the authoritative total matches the cart. Money authority
  // still rests entirely with the server — this is a discount INPUT, not an amount.
  lineDiscountSatang?: number;
};

type IncomingPaymentLine = {
  method: string;
  amount: number; // baht
  reference?: string | null;
};

type OrderRequestBody = {
  items: IncomingItem[];
  paymentLines: IncomingPaymentLine[];
  // Bill-level discount INPUT (not an amount): the server recomputes ALL money
  // (subtotal/discount/tax/total/per-line) from DB prices + these two fields.
  // discountValue >= 0; for percent additionally 0..100.
  discountType?: "amount" | "percent";
  discountValue?: number;
  // NOTE: any client-sent subtotal/discount/tax/total/amountPaid/change is IGNORED
  // — the server recomputes them. They are intentionally NOT in this type.
  // NOTE: no `cashierId` here by design — the server forces it from the session
  // (any client-sent cashierId is ignored, anti-forgery; see POST handler).
  // Phase 6a — customer linkage + tax-invoice request. customerId nullable =
  // walk-in. taxRequested requires a customerId whose Customer has a taxId.
  customerId?: string | null;
  taxRequested?: boolean;
};

// The six valid tender methods (mirrors the PaymentType enum).
const VALID_METHODS = new Set<PaymentType>([
  PaymentType.CASH,
  PaymentType.CARD,
  PaymentType.QR,
  PaymentType.TRANSFER,
  PaymentType.EWALLET,
  PaymentType.OTHER,
]);

function isPaymentType(v: string): v is PaymentType {
  return (VALID_METHODS as Set<string>).has(v);
}

/**
 * Generate the daily POS number: POS-YYYYMMDD-#### where #### = (count of orders
 * created today, in Asia/Bangkok) + 1, zero-padded to 4.
 *
 * The calendar date AND the count window are computed in Asia/Bangkok (not the
 * process-local/UTC clock) so an early-morning Thai sale doesn't roll onto the
 * previous UTC day (shared helpers in lib/datetime.ts).
 *
 * TODO(production-readiness): this count-based sequence is not collision-safe
 * under concurrency — a DB sequence/counter is the hardening owned by the
 * production-readiness program. Do not regress to a timestamp id.
 */
async function nextPosNo(
  tx: Prisma.TransactionClient,
  now: Date
): Promise<string> {
  const yyyymmdd = bangkokYyyymmdd(now);
  const { startOfDay, startOfNextDay } = bangkokDayWindow(now);
  const countToday = await tx.order.count({
    where: { createdAt: { gte: startOfDay, lt: startOfNextDay } },
  });
  const seq = String(countToday + 1).padStart(4, "0");
  return `POS-${yyyymmdd}-${seq}`;
}

// POST /api/orders — create an order (checkout)
//
// AUTH (production-readiness Phase 1): requires an authenticated session. The
// cashier is taken from the SESSION (session.user.id), never from the client body
// — a client-supplied `cashierId` is ignored (anti-forgery). This per-handler
// check is the real authorization boundary (defense-in-depth); middleware is only
// a UX redirect.
//
// TODO(production-readiness): Decimal-safe server recompute, idempotency key,
// atomic conditional stock decrement. Those hardenings are owned by the
// production-readiness program; Phase 3 must not regress them.
export async function POST(req: Request) {
  const gate = await requireUser();
  if ("response" in gate) return gate.response;
  const { session } = gate;
  // The cashier is the authenticated user — authoritative, never the client body.
  const cashierId = session.user.id;

  let body: Partial<OrderRequestBody>;
  try {
    body = (await req.json()) as Partial<OrderRequestBody>;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const {
    items,
    paymentLines = [],
    discountType = "amount",
    discountValue = 0,
    // NOTE: subtotal/discount/tax/total/amountPaid/change are intentionally NOT
    // read from the body — the server recomputes ALL of them below. Any value the
    // client sends for those is ignored (anti-tamper).
    // NOTE: `cashierId` is intentionally NOT destructured from the body — it is
    // forced from the session above. Any client-sent cashierId is ignored.
    customerId,
    taxRequested = false,
  } = body;

  // --- input boundary validation ---
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: "No items in order", code: "NO_ITEMS" },
      { status: 400 }
    );
  }
  // INT4 cap matches the Postgres Int4 quantity column so an oversized qty returns
  // 400 instead of overflowing to a 500 (mirrors stock-movements/route.ts).
  const INT4_MAX = 2_147_483_647;
  if (
    items.some(
      (i) =>
        !i ||
        typeof i.productId !== "string" ||
        !Number.isFinite(i.quantity) ||
        !Number.isInteger(i.quantity) ||
        i.quantity <= 0 ||
        i.quantity > INT4_MAX ||
        // Per-line discount (if present) must be a non-negative integer (satang).
        (i.lineDiscountSatang !== undefined &&
          (!Number.isFinite(i.lineDiscountSatang) ||
            !Number.isInteger(i.lineDiscountSatang) ||
            i.lineDiscountSatang < 0))
    )
  ) {
    return NextResponse.json(
      { error: "Invalid line item", code: "BAD_ITEM" },
      { status: 400 }
    );
  }

  // --- bill-level discount input boundary (server is authoritative) ---
  if (discountType !== "amount" && discountType !== "percent") {
    return NextResponse.json(
      { error: "Invalid discount type", code: "BAD_DISCOUNT" },
      { status: 400 }
    );
  }
  if (
    !Number.isFinite(discountValue) ||
    discountValue < 0 ||
    (discountType === "percent" && discountValue > 100)
  ) {
    return NextResponse.json(
      { error: "Invalid discount value", code: "BAD_DISCOUNT" },
      { status: 400 }
    );
  }
  // Sub-cent precision guard (FIX 6). pricing.ts converts an "amount" discount to
  // satang via roundSatang(value * 100); a value with more than 2 decimal places
  // (e.g. 1.005 -> float 100.4999… -> 100 instead of 101) silently under-discounts
  // by 1 satang. Reject any discountValue carrying >2dp so the satang conversion is
  // EXACT. (For percent the value feeds subtotal*pct/100 and is already rounded to
  // satang, but bounding precision keeps the input contract uniform and clean.)
  if (Math.round(discountValue * 100) !== discountValue * 100) {
    return NextResponse.json(
      { error: "discountValue must have at most 2 decimal places", code: "BAD_DISCOUNT" },
      { status: 400 }
    );
  }

  if (!Array.isArray(paymentLines) || paymentLines.length === 0) {
    return NextResponse.json(
      { error: "No payment lines", code: "NO_PAYMENT" },
      { status: 422 }
    );
  }
  // Upper bound on split lines (FIX 5 — hardening). A real split is a handful of
  // tenders; without a cap a crafted POST with thousands of 1-satang lines that
  // still sum to the total would pass the sum check and write thousands of
  // PaymentLine rows. 20 is comfortably above any legitimate split.
  const MAX_PAYMENT_LINES = 20;
  if (paymentLines.length > MAX_PAYMENT_LINES) {
    return NextResponse.json(
      { error: "Too many payment lines", code: "TOO_MANY_PAYMENTS" },
      { status: 422 }
    );
  }
  // Cap on a payment reference (FIX 5). A legitimate slip/txn ref is short; an
  // unbounded reference is a write-amplification / abuse vector. Reject (422)
  // rather than silently truncate so the money path fails loudly at the boundary.
  const MAX_REFERENCE_LEN = 100;

  // Normalize + validate every payment line. Amounts are tracked in INTEGER
  // SATANG so the split-sum vs total comparison below is exact (no float drift).
  const normalizedPays: {
    method: PaymentType;
    amountSatang: number;
    reference: string | null;
  }[] = [];
  for (const pl of paymentLines) {
    if (!pl || typeof pl.method !== "string" || !isPaymentType(pl.method)) {
      return NextResponse.json(
        { error: "Invalid payment method", code: "BAD_METHOD" },
        { status: 422 }
      );
    }
    const amtSatang = toSatang(pl.amount);
    // A payment line must carry a POSITIVE amount — `amt <= 0` is rejected (a
    // zero-amount line is meaningless and, combined with a zero-total order, was a
    // fraud vector). Each line must also fit the Decimal(10,2) column, whose max
    // is 99,999,999.99 baht = 9,999,999,999 satang.
    if (
      !Number.isFinite(amtSatang) ||
      amtSatang <= 0 ||
      amtSatang > 9_999_999_999
    ) {
      return NextResponse.json(
        { error: "Invalid payment amount", code: "BAD_AMOUNT" },
        { status: 422 }
      );
    }
    const reference =
      typeof pl.reference === "string" && pl.reference.trim().length > 0
        ? pl.reference.trim()
        : null;
    // Reference length cap (FIX 5) — checked AFTER trimming so trailing whitespace
    // never tips a legitimate ref over the limit.
    if (reference !== null && reference.length > MAX_REFERENCE_LEN) {
      return NextResponse.json(
        { error: "Payment reference too long", code: "BAD_PAYMENT" },
        { status: 422 }
      );
    }
    normalizedPays.push({ method: pl.method, amountSatang: amtSatang, reference });
  }

  // amountPaid is SERVER-COMPUTED as the sum of payment lines (satang) — never
  // trusted from the client body.
  const amountPaidSatang = normalizedPays.reduce(
    (acc, p) => acc + p.amountSatang,
    0
  );

  // Primary/dominant method for reporting/back-compat: cash if any cash line,
  // else the first line's method.
  const cashDueSatang = normalizedPays
    .filter((p) => p.method === PaymentType.CASH)
    .reduce((s, p) => s + p.amountSatang, 0);
  const hasCash = cashDueSatang > 0;
  const primaryMethod: PaymentType = hasCash
    ? PaymentType.CASH
    : normalizedPays[0].method;

  // --- Phase 6a: customer linkage + tax-invoice gating (server-authoritative) ---
  // A walk-in (no customerId) is the default and never blocks checkout. When a
  // customerId IS sent it must reference an existing Customer (anti-tamper). When
  // a tax invoice is requested the linked customer MUST have a non-empty taxId
  // (domain-tax-invoice-requires-tax-customer) — the client also gates this, but
  // the server is the source of truth and re-checks it here.
  const normalizedCustomerId =
    typeof customerId === "string" && customerId.trim().length > 0
      ? customerId.trim()
      : null;
  const wantsTax = taxRequested === true;

  try {
    // Customer resolution runs inside the sanitized try so a DB failure on the
    // findUnique maps to the route's INTERNAL 500 (not an unsanitized throw). The
    // BAD_CUSTOMER / TAX_REQUIRES_TAX_CUSTOMER short-circuit returns behave
    // identically here as outside the try.
    let resolvedCustomer:
      | { id: string; taxId: string | null }
      | null = null;
    if (normalizedCustomerId) {
      resolvedCustomer = await prisma.customer.findUnique({
        where: { id: normalizedCustomerId },
        select: { id: true, taxId: true },
      });
      if (!resolvedCustomer) {
        return NextResponse.json(
          { error: "ไม่พบลูกค้าที่เลือก", code: "BAD_CUSTOMER" },
          { status: 422 }
        );
      }
    }

    if (wantsTax) {
      const hasTaxId =
        resolvedCustomer != null &&
        typeof resolvedCustomer.taxId === "string" &&
        resolvedCustomer.taxId.trim().length > 0;
      if (!hasTaxId) {
        return NextResponse.json(
          {
            error: "ต้องเลือกลูกค้าที่มีเลขผู้เสียภาษีก่อนออกใบกำกับภาษี",
            code: "TAX_REQUIRES_TAX_CUSTOMER",
          },
          { status: 422 }
        );
      }
    }

    // Server-authoritative recompute: fetch DB product prices (ACTIVE only — a
    // deactivated product must not be sellable) and recompute ALL money from them
    // + the requested quantities + the bill discount. Any client-sent subtotal/
    // discount/tax/total/amountPaid/change is ignored.
    const productIds = items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, isActive: true },
      select: { id: true, price: true },
    });

    const bill: BillDiscount = { type: discountType, value: discountValue };
    const requestedLines: OrderRequestLine[] = items.map((i) => ({
      productId: i.productId,
      quantity: i.quantity,
      lineDiscountSatang: i.lineDiscountSatang,
    }));

    // computeOrderTotals throws OrderProductMissingError for an unknown/inactive
    // product (→ 404 below) and RangeError for an out-of-range discount (already
    // validated at the boundary above, so this is a belt-and-braces guard).
    const totals = computeOrderTotals(products, requestedLines, bill);

    // Server-computed bill money (integer satang → Decimal-safe baht strings).
    const subtotalBaht = satangToString(totals.subtotalSatang);
    const discountBaht = satangToString(totals.billDiscountSatang);
    const taxBaht = satangToString(totals.vatSatang);
    const totalBaht = satangToString(totals.totalSatang);
    const amountPaidBaht = satangToString(amountPaidSatang);
    // change = max(amountPaid - total, 0), SERVER-computed (never trusted).
    const changeSatang = Math.max(amountPaidSatang - totals.totalSatang, 0);
    const changeBaht = satangToString(changeSatang);

    // Split sum must equal the SERVER total exactly (integer satang — no float
    // drift). This compares against the authoritative total, not a client value.
    if (amountPaidSatang !== totals.totalSatang) {
      return NextResponse.json(
        {
          error: `ยอดชำระ (${satangToString(amountPaidSatang)}) ไม่ตรงกับยอดที่ต้องจ่าย (${totalBaht})`,
          code: "PAYMENT_MISMATCH",
        },
        { status: 422 }
      );
    }

    // Cash sufficiency: the CASH received (amountPaid covers all tenders; the cash
    // lines' own sum is cashDueSatang) must cover the cash portion. With the exact
    // split-sum gate above, amountPaid === total, so amountPaid always covers
    // cashDue — this guard stays as defense-in-depth.
    if (cashDueSatang > 0 && amountPaidSatang < cashDueSatang) {
      return NextResponse.json(
        { error: "รับเงินสดน้อยกว่ายอดที่ต้องจ่าย", code: "INSUFFICIENT_CASH" },
        { status: 422 }
      );
    }

    // Per-line OrderItem rows from the SERVER recompute (unitPrice/lineTotal in
    // Decimal-safe baht strings — never the client's per-line amounts).
    const lineItems = totals.lines.map((l) => ({
      productId: l.productId,
      quantity: l.quantity,
      unitPrice: satangToString(l.priceSatang),
      lineTotal: satangToString(l.lineTotalSatang),
    }));

    const now = new Date();

    // Phase 5 (Decision A2): link the new order to the current OPEN shift if one
    // exists, else leave shiftId null. This MUST NOT block checkout when no shift
    // is open — a sale can happen before a shift is opened, and that order simply
    // carries no shiftId. Totals/pricing logic above is unchanged.
    const openShift = await prisma.shift.findFirst({
      where: { status: "OPEN" },
      orderBy: { openedAt: "desc" },
      select: { id: true },
    });
    const shiftId = openShift?.id ?? null;

    const order = await prisma.$transaction(async (tx) => {
      const orderNumber = await nextPosNo(tx, now);

      const created = await tx.order.create({
        data: {
          orderNumber,
          subtotal: subtotalBaht,
          tax: taxBaht,
          discount: discountBaht,
          total: totalBaht,
          paymentType: primaryMethod,
          amountPaid: amountPaidBaht,
          change: changeBaht,
          // Authoritative cashier from the session (set above), never the body.
          cashierId,
          customerId: normalizedCustomerId,
          taxRequested: wantsTax,
          shiftId,
          items: { create: lineItems },
          payments: {
            create: normalizedPays.map((p) => ({
              method: p.method,
              amount: satangToString(p.amountSatang),
              reference: p.reference,
            })),
          },
        },
        include: ORDER_INCLUDE,
      });

      // Atomic conditional stock decrement: only decrement when stock >= qty. The
      // `WHERE stock >= qty` guard + the count===1 assert prevents overselling
      // under concurrency (two checkouts of the last unit cannot both succeed) and
      // prevents negative stock. A 0-count means insufficient stock → 409, which
      // rolls back the whole transaction (the order create above is undone).
      for (const item of lineItems) {
        const dec = await tx.product.updateMany({
          where: { id: item.productId, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (dec.count !== 1) {
          throw new InsufficientStockError(item.productId);
        }
        // SALE ledger row: qty is stored as a NEGATIVE delta (stock out), the
        // mirror of RECEIVE's positive delta — see StockMovement sign convention.
        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: StockMovementType.SALE,
            qty: -item.quantity,
            reference: orderNumber,
          },
        });
      }

      return created;
    });

    // Money/ledger audit (Sub-phase B). BEST-EFFORT, AFTER commit — never inside
    // the transaction (mirrors ORDER_VOIDED/ORDER_REFUNDED). A failed audit write
    // never fails the sale.
    await logAudit({
      action: AuditAction.ORDER_CREATED,
      actorId: cashierId,
      actorEmail: session.user.email ?? null,
      ip: await ipFromHeaders(),
      targetType: "Order",
      targetId: order.id,
      detail: JSON.stringify({
        orderNumber: order.orderNumber,
        total: totalBaht,
      }),
    });

    return NextResponse.json(serializeOrder(order), { status: 201 });
  } catch (err) {
    if (
      err instanceof ProductNotFoundError ||
      err instanceof OrderProductMissingError
    ) {
      return NextResponse.json(
        { error: `Product not found: ${err.productId}`, code: "PRODUCT_NOT_FOUND" },
        { status: 404 }
      );
    }
    if (err instanceof InsufficientStockError) {
      return NextResponse.json(
        {
          error: "สต็อกไม่เพียงพอ",
          code: "INSUFFICIENT_STOCK",
          productId: err.productId,
        },
        { status: 409 }
      );
    }
    // Concurrent checkouts can collide on the daily orderNumber (count-based
    // sequence under READ COMMITTED). The collision-free DB sequence is deferred
    // (Sub-phase C); for now translate the unique-constraint violation into a clean
    // 409 the client can retry, instead of a silent 500.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "เลขที่บิลซ้ำ กรุณาลองใหม่", code: "ORDER_NUMBER_CONFLICT" },
        { status: 409 }
      );
    }
    // Sanitized 500 — never leak internals to the client.
    console.error("POST /api/orders failed:", err);
    return NextResponse.json(
      { error: "Could not create order", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

class ProductNotFoundError extends Error {
  constructor(public readonly productId: string) {
    super(`Product not found: ${productId}`);
    this.name = "ProductNotFoundError";
  }
}

/**
 * Thrown inside the checkout transaction when the atomic conditional decrement
 * (`updateMany WHERE stock >= qty`) matches 0 rows — i.e. the product no longer
 * has enough stock. Throwing rolls back the whole transaction (the order create
 * is undone) and maps to a clean 409 INSUFFICIENT_STOCK.
 */
class InsufficientStockError extends Error {
  constructor(public readonly productId: string) {
    super(`Insufficient stock: ${productId}`);
    this.name = "InsufficientStockError";
  }
}

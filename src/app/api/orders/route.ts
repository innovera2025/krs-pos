import { NextResponse } from "next/server";
import { Prisma, PaymentType, OrderStatus, SyncStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { bangkokYyyymmdd, bangkokDayWindow } from "@/lib/datetime";

/** Valid OrderStatus values for the optional `?status=` filter (Phase 5 history). */
function isOrderStatus(v: string): v is OrderStatus {
  return (Object.values(OrderStatus) as string[]).includes(v);
}

/** Valid SyncStatus values for the optional `?sync=` filter (Phase 5 history). */
function isSyncStatus(v: string): v is SyncStatus {
  return (Object.values(SyncStatus) as string[]).includes(v);
}

// GET /api/orders — list recent orders (Phase 5 Sales History).
//
// Optional query filters (validated against the enums; unknown values are
// ignored so a stray param never 500s the history page):
//   ?status=COMPLETED|REFUNDED|VOIDED|PENDING|CANCELLED
//   ?sync=PENDING|DAILY|SYNCED|FAILED|SKIPPED
// `payments` is included so the sales list + reprint (ReceiptModal) have tenders.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");
  const syncParam = searchParams.get("sync");

  const where: Prisma.OrderWhereInput = {};
  if (statusParam && isOrderStatus(statusParam)) where.status = statusParam;
  if (syncParam && isSyncStatus(syncParam)) where.syncStatus = syncParam;

  const orders = await prisma.order.findMany({
    where,
    include: {
      items: { include: { product: true } },
      payments: true,
      cashier: { select: { id: true, name: true } },
      customer: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json(orders);
}

type IncomingItem = { productId: string; quantity: number };

type IncomingPaymentLine = {
  method: string;
  amount: number; // baht
  reference?: string | null;
};

type OrderRequestBody = {
  items: IncomingItem[];
  paymentLines: IncomingPaymentLine[];
  // Client-computed, VAT-inclusive money (baht). The cart's integer-satang engine
  // (lib/pricing.ts) is authoritative for Phase 3; the server recompute below is
  // per-line price authority only (anti-tamper on unitPrice), not total recompute.
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  amountPaid: number;
  change: number;
  cashierId?: string | null;
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

/** Round a baht number to 2dp via integer satang to avoid float drift on store. */
function round2(baht: number): number {
  if (!Number.isFinite(baht)) return 0;
  return Math.round(baht * 100) / 100;
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
// TODO(production-readiness): Decimal-safe server recompute, idempotency key,
// atomic conditional stock decrement. Those hardenings are owned by the
// production-readiness program; Phase 3 must not regress them.
export async function POST(req: Request) {
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
    subtotal = 0,
    discount = 0,
    tax = 0,
    total = 0,
    amountPaid = 0,
    change = 0,
    cashierId,
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
  if (
    items.some(
      (i) =>
        !i ||
        typeof i.productId !== "string" ||
        !Number.isFinite(i.quantity) ||
        !Number.isInteger(i.quantity) ||
        i.quantity <= 0
    )
  ) {
    return NextResponse.json(
      { error: "Invalid line item", code: "BAD_ITEM" },
      { status: 400 }
    );
  }

  if (!Array.isArray(paymentLines) || paymentLines.length === 0) {
    return NextResponse.json(
      { error: "No payment lines", code: "NO_PAYMENT" },
      { status: 422 }
    );
  }

  // Normalize + validate every payment line.
  const normalizedPays: { method: PaymentType; amount: number; reference: string | null }[] =
    [];
  for (const pl of paymentLines) {
    if (!pl || typeof pl.method !== "string" || !isPaymentType(pl.method)) {
      return NextResponse.json(
        { error: "Invalid payment method", code: "BAD_METHOD" },
        { status: 422 }
      );
    }
    const amt = round2(Number(pl.amount));
    if (!Number.isFinite(amt) || amt < 0) {
      return NextResponse.json(
        { error: "Invalid payment amount", code: "BAD_AMOUNT" },
        { status: 422 }
      );
    }
    const reference =
      typeof pl.reference === "string" && pl.reference.trim().length > 0
        ? pl.reference.trim()
        : null;
    normalizedPays.push({ method: pl.method, amount: amt, reference });
  }

  const totalBaht = round2(Number(total));

  // Split sum must equal the bill total within 0.01 baht.
  const paySum = round2(
    normalizedPays.reduce((acc, p) => acc + p.amount, 0)
  );
  if (Math.abs(paySum - totalBaht) > 0.01) {
    return NextResponse.json(
      {
        error: `ยอดชำระ (${paySum.toFixed(2)}) ไม่ตรงกับยอดที่ต้องจ่าย (${totalBaht.toFixed(2)})`,
        code: "PAYMENT_MISMATCH",
      },
      { status: 422 }
    );
  }

  // Cash sufficiency: amountPaid (cash received) must cover the CASH PORTION
  // (cashDue = sum of CASH line amounts), not the full bill — the split-sum gate
  // above already proves the full bill is covered. This admits valid mixed
  // cash+non-cash splits where cash received only needs to cover its own line(s).
  const cashDue = round2(
    normalizedPays
      .filter((p) => p.method === PaymentType.CASH)
      .reduce((s, p) => s + p.amount, 0)
  );
  if (cashDue > 0 && round2(Number(amountPaid)) + 0.01 < cashDue) {
    return NextResponse.json(
      { error: "รับเงินสดน้อยกว่ายอดที่ต้องจ่าย", code: "INSUFFICIENT_CASH" },
      { status: 422 }
    );
  }

  // Primary/dominant method for reporting/back-compat: cash if any cash line,
  // else the first line's method.
  const hasCash = cashDue > 0;
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

    // Server-authoritative per-line price: recompute unitPrice/lineTotal from the
    // DB product prices (anti-tamper). Stored bill money (subtotal/discount/tax/
    // total/amountPaid/change) is the VAT-inclusive client computation as sent.
    const productIds = items.map((i) => i.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
    });

    const lineItems = items.map((item) => {
      const product = products.find((p) => p.id === item.productId);
      if (!product) {
        throw new ProductNotFoundError(item.productId);
      }
      const unitPrice = Number(product.price);
      const lineTotal = round2(unitPrice * item.quantity);
      return {
        productId: product.id,
        quantity: item.quantity,
        unitPrice,
        lineTotal,
      };
    });

    const now = new Date();

    // Phase 5 (Decision A2): link the new order to the current OPEN shift if one
    // exists, else leave shiftId null. This MUST NOT block checkout when no shift
    // is open — a sale can happen before a shift is opened, and that order simply
    // carries no shiftId. Totals/pricing logic below is unchanged.
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
          subtotal: round2(Number(subtotal)),
          tax: round2(Number(tax)),
          discount: round2(Number(discount)),
          total: totalBaht,
          paymentType: primaryMethod,
          amountPaid: round2(Number(amountPaid)),
          change: round2(Number(change)),
          cashierId: cashierId || null,
          customerId: normalizedCustomerId,
          taxRequested: wantsTax,
          shiftId,
          items: { create: lineItems },
          payments: {
            create: normalizedPays.map((p) => ({
              method: p.method,
              amount: p.amount,
              reference: p.reference,
            })),
          },
        },
        include: {
          items: { include: { product: true } },
          payments: true,
          cashier: { select: { id: true, name: true } },
          customer: true,
        },
      });

      // TODO(production-readiness): atomic conditional stock decrement
      // (WHERE stock >= qty) to prevent overselling under concurrency.
      for (const item of lineItems) {
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { decrement: item.quantity } },
        });
      }

      return created;
    });

    return NextResponse.json(order, { status: 201 });
  } catch (err) {
    if (err instanceof ProductNotFoundError) {
      return NextResponse.json(
        { error: `Product not found: ${err.productId}`, code: "PRODUCT_NOT_FOUND" },
        { status: 404 }
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

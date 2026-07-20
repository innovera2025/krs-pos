import { NextResponse } from "next/server";
import {
  Prisma,
  PaymentType,
  OrderStatus,
  SyncStatus,
  StockMovementType,
  SyncJobType,
  SyncDirection,
  SyncJobStatus,
  AuditAction,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
// Seller branch identity for the KRS outbox snapshot (krs-sync P2). Loaded BEFORE the
// checkout $transaction (it hits Prisma — never inside a tx) so the SALE SyncJob can
// carry branchCode/branchName. A null result defaults to HQ in the snapshot below.
import { getSellerConfig } from "@/lib/sellerConfig";
// KRS outbox SALE-payload contract (krs-sync P2). TYPE-ONLY + the HQ-branch defaults —
// this module imports NO mssql driver, so the checkout route's module graph stays
// driver-free. The dispatcher (a separate module) consumes the snapshot at dispatch.
import {
  type SalePayload,
  SALE_PAYLOAD_HQ_BRANCH_CODE,
  SALE_PAYLOAD_HQ_BRANCH_NAME,
  SALE_PAYLOAD_HQ_WAREHOUSE,
} from "@/lib/krs/salePayload";
// FIX B — only formatOrderNumber is used here now; the Bangkok day is derived
// from the Postgres transaction clock inside nextOrderNumber (no JS day stamp).
import { formatOrderNumber } from "@/lib/datetime";
import { requireUser } from "@/lib/auth";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
import {
  computeOrderTotals,
  OrderProductMissingError,
  type OrderRequestLine,
} from "@/lib/pricing";
// Promotions program (Phase 6) — server-authoritative promotion application. The
// pure, isomorphic engine ranks/applies the effective promotions and yields the
// combined (manual + promo) per-line discounts + one combined bill discount that
// are fed UNCHANGED into computeOrderTotals, so the engine and pricing subtotals
// match to the satang (asserted below). The engine imports no Prisma/mssql — the
// checkout route's module graph stays driver-free.
import {
  applyPromotions,
  type ActivePromotion,
  type PromoCartLine,
} from "@/lib/promotionEngine";
// Shared row → ActivePromotion serializer (Phase 4). REUSED here so the checkout
// recompute and GET /api/promotions?view=pos can never drift on which fields each
// promotion type exposes to the engine.
import { serializePosPromotion } from "@/lib/promotionSerialize";
// Shared wire serializer + satang helpers (FIX 1): every order response
// (GET/POST here, and every PATCH return in [id]/route.ts) emits identical 2dp
// string money fields. The serializer lives in its own module so both route
// files can share it without coupling their include constants.
import {
  serializeOrder,
  toSatang,
  satangToString,
} from "@/lib/orderSerialize";
// WRAP-ONLY Zod (owner decision D1): the orders POST adds SHAPE/TYPE validation at
// the JSON-parse boundary. ALL money/domain logic below (server recompute,
// PAYMENT_MISMATCH, MAX_PAYMENT_LINES, idempotency, error codes) is unchanged and
// runs AFTER this parse. See src/lib/schemas/order.ts for the wrap contract.
import { OrderPostBodySchema } from "@/lib/schemas/order";
import { parseBody } from "@/lib/schemas/_shared";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

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

/** One day in ms — used only for the range-span guard below (Bangkok has no DST). */
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Max span for the Sales History date+time range (Sales History range filter).
 * Guards an unbounded index scan on a crafted huge range. Mirrors the
 * promotions-report MAX_RANGE_DAYS (366) but a touch wider — a full year plus a
 * margin — per the range-filter spec.
 */
const MAX_RANGE_DAYS = 400;

// GET /api/orders — list recent orders (Phase 5 Sales History).
//
// AUTH (security-review FIX A): requires an authenticated session. Sales history
// (/sales) is available to BOTH roles (cashier + admin), so requireUser (any
// authenticated active user) is the correct gate — NOT requireAdmin. Without this
// gate an anonymous request would leak the full sales ledger incl. Customer PII
// (name/taxId/phone/address), payment refs/amounts, cashier names, and totals.
//
// Optional query filters (validated; unknown/invalid enum values are ignored so a
// stray param never 500s the history page, but a malformed date/range returns a
// coded 400):
//   ?status=COMPLETED|REFUNDED|VOIDED|PENDING|CANCELLED
//   ?sync=PENDING|DAILY|SYNCED|FAILED|SKIPPED
//   ?from=<ISO UTC instant>&to=<ISO UTC instant>  (Sales History range filter)
// `payments` is included so the sales list + reprint (ReceiptModal) have tenders.
//
// RESPONSE SHAPE (Sales History range filter): now returns
//   { orders: OrderDTO[], summary: { billCount: number, totalSales: string } }
// (was a bare OrderDTO[]). `summary` is a server-side aggregate over the WHOLE
// filtered range — never the take:200 page — and PINS status=COMPLETED (the
// money-aggregate rule: VOIDED/REFUNDED never count), so it ignores the ?status/
// ?sync params and the UI status chip. It composes with the date range only; the
// client-side text search does NOT narrow it, so it is the authoritative sales
// total for the whole selected range. `totalSales` is a 2dp baht string via the
// shared satang serializer ("0.00" on a zero-row range).
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    const { searchParams } = new URL(req.url);
    const statusParam = searchParams.get("status");
    const syncParam = searchParams.get("sync");
    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");

    // --- optional date/time range (Sales History range filter) ---
    // `from`/`to` carry ISO UTC instants (the client converts its Asia/Bangkok
    // wall-clock datetime-local inputs to instants via bangkokLocalInputToInstant).
    // Each is independently optional; a present-but-unparseable value returns a
    // coded 400 (BAD_DATE) rather than being silently ignored, matching the
    // route's error style. When BOTH are present the range is validated: from ≤ to
    // (BAD_RANGE) and span ≤ MAX_RANGE_DAYS (RANGE_TOO_WIDE).
    let fromDate: Date | null = null;
    let toDate: Date | null = null;
    if (fromParam) {
      fromDate = new Date(fromParam);
      if (Number.isNaN(fromDate.getTime())) {
        return NextResponse.json(
          { error: "รูปแบบวันที่เริ่มต้นไม่ถูกต้อง", code: "BAD_DATE" },
          { status: 400 }
        );
      }
    }
    if (toParam) {
      toDate = new Date(toParam);
      if (Number.isNaN(toDate.getTime())) {
        return NextResponse.json(
          { error: "รูปแบบวันที่สิ้นสุดไม่ถูกต้อง", code: "BAD_DATE" },
          { status: 400 }
        );
      }
    }
    if (fromDate && toDate) {
      if (fromDate.getTime() > toDate.getTime()) {
        return NextResponse.json(
          { error: "ช่วงเวลาไม่ถูกต้อง (จากต้องไม่เกินถึง)", code: "BAD_RANGE" },
          { status: 400 }
        );
      }
      if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        return NextResponse.json(
          { error: "ช่วงเวลากว้างเกินไป (สูงสุด 400 วัน)", code: "RANGE_TOO_WIDE" },
          { status: 400 }
        );
      }
    }

    // createdAt filter — INCLUSIVE on both present bounds (gte/lte), composable
    // with the status/sync enum filters + the take:200 page.
    const createdAt: Prisma.DateTimeFilter = {};
    if (fromDate) createdAt.gte = fromDate;
    if (toDate) createdAt.lte = toDate;
    const hasRange = fromDate !== null || toDate !== null;

    const where: Prisma.OrderWhereInput = {};
    if (statusParam && isOrderStatus(statusParam)) where.status = statusParam;
    if (syncParam && isSyncStatus(syncParam)) where.syncStatus = syncParam;
    if (hasRange) where.createdAt = createdAt;

    // Range summary WHERE (money-aggregate rule): PINS status=COMPLETED — ignoring
    // the ?status/?sync params + the UI status chip — and composes with the date
    // range only. It is NEVER page-scoped (aggregate has no take), so it is the
    // true total over the whole filtered range.
    const summaryWhere: Prisma.OrderWhereInput = {
      status: OrderStatus.COMPLETED,
    };
    if (hasRange) summaryWhere.createdAt = createdAt;

    // Error handling (production-readiness Phase 1, theme #4): wrap the findMany +
    // aggregate + serialize map so a DB failure returns a typed { error, code }
    // 500 (with a server-side log line) instead of a raw Next.js 500 that blanks
    // /sales.
    try {
      const [orders, agg] = await Promise.all([
        prisma.order.findMany({
          where,
          include: ORDER_INCLUDE,
          orderBy: { createdAt: "desc" },
          take: 200,
        }),
        // ONE aggregate for the range summary: distinct COMPLETED bill count +
        // sum of totals. `_sum.total` is null on a zero-row range → toSatang(null)
        // = 0 → "0.00". Serialized as a 2dp baht string via the shared satang
        // helpers so the money contract matches every other order response.
        prisma.order.aggregate({
          where: summaryWhere,
          _count: true,
          _sum: { total: true },
        }),
      ]);
      return NextResponse.json({
        orders: orders.map(serializeOrder),
        summary: {
          billCount: agg._count,
          totalSales: satangToString(toSatang(agg._sum.total)),
        },
      });
    } catch (err) {
      logger.error({ err }, "GET /api/orders failed");
      return NextResponse.json(
        { error: "Could not load orders", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
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
  // Checkout idempotency (Sub-phase C). A client-generated UUID per checkout
  // ATTEMPT — the SAME key is reused across retries of one submission, and a NEW
  // key is generated for a new sale. The server collapses a double-submit to a
  // single Order via the `Order.idempotencyKey @unique` index: a matching key
  // replays the existing order (200) instead of creating a duplicate sale +
  // double stock decrement. Optional for back-compat; the client always sends it.
  idempotencyKey?: string;
};

// The valid tender methods (mirrors the PaymentType enum). This Set is the
// authoritative accept-list for `isPaymentType` → 422 BAD_METHOD; the Zod schema
// keeps `method` as a plain string on purpose (so it never shadows this coded
// guard). CHEQUE + THAICHUAYTHAI are the live buttons (vendor 17-07-26); EWALLET +
// OTHER stay accepted so a held/replayed pre-change cart still checks out.
const VALID_METHODS = new Set<PaymentType>([
  PaymentType.CASH,
  PaymentType.CARD,
  PaymentType.QR,
  PaymentType.TRANSFER,
  PaymentType.CHEQUE,
  PaymentType.THAICHUAYTHAI,
  PaymentType.EWALLET,
  PaymentType.OTHER,
]);

function isPaymentType(v: string): v is PaymentType {
  return (VALID_METHODS as Set<string>).has(v);
}

/** Max length for a client-sent idempotency key (a UUID is 36 chars). */
const MAX_IDEMPOTENCY_KEY_LEN = 64;

/**
 * Collision-safe daily POS number (Sub-phase C). Replaces the old count-based
 * `nextPosNo`, which raced under READ COMMITTED (two concurrent checkouts could
 * read the same count and mint a duplicate orderNumber → P2002 → 500).
 *
 * The Asia/Bangkok day stamp (not UTC) is the DailyOrderCounter primary key, so
 * an early-morning Thai sale counts toward the correct business day. The counter
 * is bumped with a RAW `INSERT ... ON CONFLICT (day) DO UPDATE SET seq = seq + 1
 * RETURNING seq` — atomic in a single statement (Prisma's non-raw `upsert` is
 * find-then-write and races on the first insert of the day, so the raw upsert is
 * required). Runs INSIDE the checkout transaction so a rolled-back order also
 * rolls back the seq bump (no gap from a failed sale).
 *
 * FIX B — the Bangkok day is derived INSIDE the upsert from the Postgres
 * transaction clock (`now() AT TIME ZONE 'Asia/Bangkok'`), NOT from a JS `now`
 * captured before the transaction. `now()` is constant within a Postgres
 * transaction and is the SAME clock that stamps `Order.createdAt`
 * (`@default(now())`), so the counter key, the orderNumber day-prefix, and
 * `createdAt` can no longer disagree across the ~50 ms Bangkok-midnight window
 * that a JS-derived day could straddle. The pure `formatOrderNumber` helper is
 * still used — fed the RETURNED `day`, not a JS-computed one.
 */
async function nextOrderNumber(
  tx: Prisma.TransactionClient
): Promise<string> {
  // RETURNING day + seq — both derived from the single Postgres transaction
  // clock. `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYYMMDD')` produces the
  // Bangkok day stamp; seq is the new value after the atomic bump (1 on first
  // insert of that day).
  const rows = await tx.$queryRaw<{ day: string; seq: number }[]>`
    INSERT INTO "DailyOrderCounter" ("day", "seq")
    VALUES (to_char((now() AT TIME ZONE 'Asia/Bangkok'), 'YYYYMMDD'), 1)
    ON CONFLICT ("day")
    DO UPDATE SET "seq" = "DailyOrderCounter"."seq" + 1
    RETURNING "day", "seq"
  `;
  const row = rows[0];
  const day = row?.day;
  const seq = row?.seq;
  if (typeof day !== "string" || day.length === 0) {
    // Defensive: the upsert always returns exactly one row with the day key, but
    // never trust an empty/malformed result silently — it would corrupt the
    // orderNumber.
    throw new Error("DailyOrderCounter upsert returned no day");
  }
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq < 1) {
    // Defensive: the upsert always returns exactly one row, but never trust an
    // empty/malformed result silently — it would corrupt the orderNumber. The
    // counter starts at 1, so a seq < 1 (FIX C) is also an internal error: a
    // seq of 0 would yield POS-YYYYMMDD-0000.
    throw new Error("DailyOrderCounter upsert returned no sequence");
  }
  return formatOrderNumber(day, seq);
}

/**
 * Whether a Prisma P2002 (unique constraint) error names the given field/column
 * (Sub-phase C). `err.meta.target` shape varies by connector/version: the
 * Postgres connector usually reports a `string[]` of column names
 * (`["idempotencyKey"]`), but it can also be a single constraint-name string
 * (`"Order_idempotencyKey_key"`) or undefined. A SUBSTRING test against every
 * token covers all three shapes (column name, constraint name embedding the
 * column, array). Used to branch a checkout P2002 by which unique index lost the
 * race (`idempotencyKey` → replay 200 vs `orderNumber` → 409).
 */
function p2002Mentions(
  err: Prisma.PrismaClientKnownRequestError,
  field: string
): boolean {
  const target = err.meta?.target;
  const tokens = Array.isArray(target)
    ? target.map((t) => String(t))
    : typeof target === "string"
      ? [target]
      : [];
  return tokens.some((t) => t.includes(field));
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
  return runWithRequestId(req, async () => {
  // Start time for the success request-log line (D3 — mutation routes only). No
  // PII is logged: method/path/status/duration + requestId (via the mixin) only.
  const startedAt = Date.now();
  const gate = await requireUser();
  if ("response" in gate) return gate.response;
  const { session } = gate;
  // The cashier is the authenticated user — authoritative, never the client body.
  const cashierId = session.user.id;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // WRAP-ONLY shape/type validation (D1). On a structurally wrong body this returns
  // 400 { error, code: "VALIDATION", issues }. Unknown keys (subtotal/discount/tax/
  // total/amountPaid/change/cashierId) are stripped by Zod, so the anti-tamper
  // "server ignores client money" contract is preserved. EVERY existing domain guard
  // below (NO_ITEMS, BAD_ITEM, BAD_DISCOUNT 2dp, TOO_MANY_PAYMENTS, BAD_METHOD,
  // PAYMENT_MISMATCH, idempotency, etc.) is unchanged and runs after this parse.
  const parsed = parseBody(OrderPostBodySchema, raw);
  if ("response" in parsed) return parsed.response;
  const body = parsed.data as Partial<OrderRequestBody>;

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
    idempotencyKey,
  } = body;

  // --- idempotency key boundary (Sub-phase C) ---
  // Optional for back-compat, but when present it must be a non-empty string of
  // at most MAX_IDEMPOTENCY_KEY_LEN chars (a UUID is 36). A bad key is rejected
  // at the boundary (400) rather than silently ignored, so a buggy client can't
  // accidentally defeat idempotency and create duplicate sales. `null`/absent =
  // back-compat path (no idempotency guarantee).
  let normalizedIdemKey: string | null = null;
  if (idempotencyKey !== undefined && idempotencyKey !== null) {
    if (
      typeof idempotencyKey !== "string" ||
      idempotencyKey.trim().length === 0 ||
      idempotencyKey.trim().length > MAX_IDEMPOTENCY_KEY_LEN
    ) {
      return NextResponse.json(
        { error: "Invalid idempotency key", code: "BAD_IDEMPOTENCY_KEY" },
        { status: 400 }
      );
    }
    normalizedIdemKey = idempotencyKey.trim();
  }

  // --- idempotent replay pre-check (Sub-phase C) ---
  // Before doing ANY work (recompute, stock decrement, audit), look up an order
  // with this key. A match means this exact checkout attempt already succeeded
  // (double-click / network retry / offline replay) → return the existing order
  // with 200, creating NO new order, NO extra stock decrement, NO duplicate
  // audit. The transactional create below + the P2002-by-key catch close the
  // race where two same-key requests arrive concurrently and both pass this
  // pre-check (one wins the unique index; the loser replays).
  if (normalizedIdemKey) {
    // Wrapped so a DB failure on this pre-check returns the route's sanitized
    // INTERNAL 500 (matching the main checkout catch) instead of a raw framework
    // 500 with no { error, code } body. Success behavior is unchanged.
    try {
      const existing = await prisma.order.findUnique({
        where: { idempotencyKey: normalizedIdemKey },
        include: ORDER_INCLUDE,
      });
      if (existing) {
        return NextResponse.json(serializeOrder(existing), { status: 200 });
      }
    } catch (err) {
      logger.error({ err }, "POST /api/orders idempotency pre-check failed");
      return NextResponse.json(
        { error: "Could not create order", code: "INTERNAL" },
        { status: 500 }
      );
    }
  }

  // --- input boundary validation ---
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json(
      { error: "No items in order", code: "NO_ITEMS" },
      { status: 400 }
    );
  }
  // Upper bound on distinct line items (DoS hardening, mirrors MAX_PAYMENT_LINES /
  // decision D4). Each line drives ~2 DB statements (stock updateMany + stockMovement
  // create) INSIDE the single checkout $transaction; without a cap a crafted POST with
  // thousands of items would hold a long transaction open. 50 is comfortably above any
  // real cart. Kept MANUAL → 422 TOO_MANY_ITEMS (the schema .max(50) is a structural
  // backstop only, not this client-facing code).
  const MAX_ITEMS = 50;
  if (items.length > MAX_ITEMS) {
    return NextResponse.json(
      { error: "Too many items", code: "TOO_MANY_ITEMS" },
      { status: 422 }
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
    (discountType === "percent" && discountValue > 100) ||
    // Cleanup: an "amount" discount must fit the Decimal(10,2) money column
    // (max 99,999,999.99). Larger values would clamp harmlessly in the recompute
    // but are unreasonable input — reject at the boundary for a clean contract.
    (discountType === "amount" && discountValue > 99_999_999.99)
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
  // Cleanup: a customerId is a CUID (~25 chars); reject an absurdly long value at the
  // boundary (400 BAD_CUSTOMER) before it reaches the findUnique below. 40 is generous.
  if (normalizedCustomerId !== null && normalizedCustomerId.length > 40) {
    return NextResponse.json(
      { error: "ไม่พบลูกค้าที่เลือก", code: "BAD_CUSTOMER" },
      { status: 400 }
    );
  }
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

    // --- Promotions program (Phase 6): fetch the EFFECTIVE promotions ---
    // A promotion is effective NOW iff isActive AND the wall-clock instant is inside
    // its [startsAt, endsAt) window (a null bound = open on that side; endsAt is
    // EXCLUSIVE). The time/active filtering lives HERE at the fetch boundary — the
    // engine is deliberately clock-free — so the POS preview (?view=pos) and this
    // checkout recompute apply the identical rule. This is a pre-tx Prisma read
    // (never inside the checkout $transaction), inside the sanitized try so a DB
    // failure maps to the route's INTERNAL 500. Serialized via the SHARED
    // serializePosPromotion so checkout and the pos view can never drift.
    const now = new Date();
    const activePromoRows = await prisma.promotion.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
        ],
      },
    });
    const activePromos: ActivePromotion[] = activePromoRows.map(serializePosPromotion);

    // Per-item catalog price in integer satang, keyed by productId. Uses the SAME
    // Decimal→satang conversion (`toSatang`) that computeOrderTotals applies to these
    // rows, so the engine's per-line gross equals pricing's gross exactly (the
    // subtotal cross-check below depends on this). A productId absent from the ACTIVE
    // product rows maps to 0 here → gross 0 → no promo; computeOrderTotals then throws
    // OrderProductMissingError (→ 404) for that same line, preserving the existing
    // unknown/inactive-product behavior.
    const priceById = new Map(products.map((p) => [p.id, toSatang(p.price)]));

    // Build the engine's cart lines in the SAME order as items[] — priceSatang from
    // the DB (never the client), manualLineDiscountSatang from the request's per-line
    // discount input (the engine re-clamps it defensively).
    const promoLines: PromoCartLine[] = items.map((i) => ({
      productId: i.productId,
      priceSatang: priceById.get(i.productId) ?? 0,
      quantity: i.quantity,
      manualLineDiscountSatang: i.lineDiscountSatang,
    }));

    // Apply promotions (server-authoritative). Yields per-line combined (manual +
    // promo) discounts and one combined bill discount, both fed UNCHANGED into
    // computeOrderTotals so server and client agree to the satang.
    const application = applyPromotions(promoLines, activePromos, {
      type: discountType,
      value: discountValue,
    });

    const requestedLines: OrderRequestLine[] = items.map((i, idx) => ({
      productId: i.productId,
      quantity: i.quantity,
      // The COMBINED (manual + promo) per-line discount, already clamped to gross by
      // the engine. computeOrderTotals re-clamps to gross (a no-op here) and folds it
      // into lineTotal, so OrderItem.lineTotal = gross − manualLine − promoLine.
      lineDiscountSatang: application.lines[idx].combinedLineDiscountSatang,
    }));

    // computeOrderTotals throws OrderProductMissingError for an unknown/inactive
    // product (→ 404 below) and RangeError for an out-of-range discount (already
    // validated at the boundary above, so this is a belt-and-braces guard). The bill
    // discount is the engine's COMBINED bill discount (promo threshold + manual), so
    // Order.discount keeps its combined meaning and `subtotal − discount === total`.
    const totals = computeOrderTotals(
      products,
      requestedLines,
      application.combinedBill
    );

    // --- Engine/pricing drift guard (belt-and-braces) ---
    // The engine and pricing compute the subtotal with the identical formula
    // (Σ max(gross − combinedLineDiscount, 0)) over the same integer-satang inputs, so
    // they MUST match. Likewise the combined bill discount round-trips exactly, so
    // pricing's billDiscountSatang MUST equal promoBill + manualBill. A mismatch means
    // the two modules diverged (a real bug) — it must NEVER ship a silently wrong sale,
    // so log both values and return 500 INTERNAL instead of persisting a bad total.
    if (
      totals.subtotalSatang !== application.subtotalSatang ||
      totals.billDiscountSatang !==
        application.promoBillDiscountSatang + application.manualBillDiscountSatang
    ) {
      logger.error(
        {
          pricingSubtotal: totals.subtotalSatang,
          engineSubtotal: application.subtotalSatang,
          pricingBillDiscount: totals.billDiscountSatang,
          enginePromoBill: application.promoBillDiscountSatang,
          engineManualBill: application.manualBillDiscountSatang,
        },
        "promotion engine / pricing drift detected"
      );
      return NextResponse.json(
        { error: "Could not create order", code: "INTERNAL" },
        { status: 500 }
      );
    }

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
    //
    // Promotions program (Phase 6): thread the line-promo snapshot columns. `totals.lines`,
    // `application.lines`, and `items` are all built in the SAME order (each from items[]),
    // so `application.lines[i]` is this line's promo result. `promoDiscount` is the promo-only
    // slice already folded into `lineTotal` (lineTotal = gross − manualLine − promoLine).
    const lineItems = totals.lines.map((l, i) => {
      const appLine = application.lines[i];
      return {
        productId: l.productId,
        quantity: l.quantity,
        unitPrice: satangToString(l.priceSatang),
        lineTotal: satangToString(l.lineTotalSatang),
        promotionId: appLine.promo?.promotionId ?? null,
        promotionName: appLine.promo?.promotionName ?? null,
        promoDiscount: satangToString(appLine.promoDiscountSatang),
      };
    });

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

    // KRS outbox (krs-sync P2): resolve the branch/warehouse BEFORE the $transaction —
    // both Prisma reads MUST NOT run inside the tx. It is best-effort for the outbox
    // snapshot.
    //
    // Branch/Warehouse Phase 4: ALL KRS docs scope to the LOGGED-IN cashier's
    // warehouse + branch, resolved ENTIRELY from the SERVER session — never a
    // client-sent value. The cashier's `session.user.warehouseCode` (stamped on the
    // JWT at sign-in, Phase 3) keys the POS `Warehouse` master, whose row carries the
    // KRS warehouseCode + branchCode + real branchName (pulled via the KRS Branch
    // join, Phase 1). An UNASSIGNED user (no warehouseCode, e.g. admin) FALLS BACK to
    // the seller config (then the HQ defaults), preserving the pre-Phase-4 behavior.
    //
    // The Warehouse lookup is wrapped to FALL BACK to config on a transient failure
    // (never fail the sale on it). getSellerConfig() likewise falls back to the HQ
    // defaults on null. A DB error on getSellerConfig surfaces as the route's
    // sanitized INTERNAL 500 (same as any other pre-tx Prisma read) — acceptable,
    // since it only fires when the DB itself is unhealthy.
    const sellerConfig = await getSellerConfig();
    const cashierWh = session.user.warehouseCode
      ? await prisma.warehouse
          .findUnique({ where: { warehouseCode: session.user.warehouseCode } })
          .catch(() => null)
      : null;
    // `||` (not `??`) across the WHOLE chain: warehouses.ts maps a blank KRS
    // BranchCode to "" (the Prisma branchCode field is non-nullable String), and `??`
    // would NOT fall through on "", emitting an empty BranchCode to KRS. These are KRS
    // codes/names that must be non-empty, and no valid value is falsy ("00000"/"WH01"
    // are truthy), so `||` correctly falls through on "", null, AND undefined.
    const outboxWarehouseCode =
      cashierWh?.warehouseCode || SALE_PAYLOAD_HQ_WAREHOUSE;
    const outboxBranchCode =
      cashierWh?.branchCode || sellerConfig?.branchCode || SALE_PAYLOAD_HQ_BRANCH_CODE;
    const outboxBranchName =
      cashierWh?.branchName || sellerConfig?.branchLabel || SALE_PAYLOAD_HQ_BRANCH_NAME;

    const order = await prisma.$transaction(async (tx) => {
      // Collision-safe orderNumber from the atomic daily counter (Sub-phase C),
      // minted INSIDE the tx so a rolled-back order also rolls back the seq bump.
      // FIX B — the day-prefix is derived from the Postgres transaction clock
      // inside nextOrderNumber (not the JS `now`), so it can't disagree with the
      // DB-stamped createdAt across the Bangkok-midnight window.
      const orderNumber = await nextOrderNumber(tx);

      const created = await tx.order.create({
        data: {
          orderNumber,
          // Idempotency key (Sub-phase C). The `@unique` index makes a concurrent
          // same-key request lose with P2002 → caught below → replays the winner.
          idempotencyKey: normalizedIdemKey,
          subtotal: subtotalBaht,
          tax: taxBaht,
          // `discount` = COMBINED bill discount (promo threshold + manual), so the
          // invariant `subtotal − discount === total` is unchanged.
          discount: discountBaht,
          // Promotions program (Phase 6): the bill-level promo slice + applied promo
          // snapshot (NO FK — historical immutability). manual slice = discount − promoBill.
          promoBillDiscount: satangToString(application.promoBillDiscountSatang),
          billPromotionId: application.billPromo?.promotionId ?? null,
          billPromotionName: application.billPromo?.promotionName ?? null,
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

      // === KRS outbox enqueue (krs-sync P2 — the ONLY new write in this tx) ===
      // Atomic with the sale: the SALE SyncJob row commits in the SAME $transaction as
      // the Order/stock/StockMovement, so a confirmed sale ALWAYS has a traceable sync
      // row (and a rolled-back sale has none). The dispatcher (a separate process)
      // reads this row's `payload` snapshot and performs the KRS write OUTSIDE any
      // Prisma tx — no mssql call lives here (cross-engine separation). The feature
      // flag gates the WRITE, not the enqueue, so jobs accumulate and drain once
      // KRS_OUTBOUND_ENABLED=true. None of the money/stock logic above is touched.
      //
      // Non-null idempotencyKey invariant (P0 spec §8.1): the key MUST be non-empty —
      // a null key gives zero dedup protection, so we throw INSIDE the tx (rolling back
      // the whole sale) rather than enqueue an untraceable job. orderNumber is already
      // asserted non-empty by nextOrderNumber, so this is a belt-and-braces guard.
      const idempotencyKey = `${orderNumber}_SALE`;
      if (orderNumber.length === 0) {
        // Defensive: nextOrderNumber already throws on an empty day/seq, so this is
        // unreachable in practice — but an empty idempotencyKey must never be written.
        throw new Error("Cannot enqueue SALE SyncJob with an empty idempotency key");
      }

      // Map productId → its created OrderItem product (sku/name) so the snapshot
      // attaches item code/description by PRODUCT, not by relation position: Prisma does
      // NOT guarantee `created.items` order matches `lineItems`, so a positional
      // `created.items[i]` could mis-attach sku/name to the wrong line in the KRS write
      // (Track B). sku/name are product attributes, so a productId lookup is correct
      // even when a product repeats across lines.
      const snapshotProductById = new Map(
        created.items.map((it) => [it.productId, it.product])
      );

      // Build the snapshot from the SERVER-RECOMPUTED money (the same Decimal-safe baht
      // strings written onto the Order) — never client values, never a float round-trip.
      const salePayload: SalePayload = {
        orderNumber,
        createdAt: created.createdAt.toISOString(),
        total: totalBaht,
        subtotal: subtotalBaht,
        tax: taxBaht,
        discount: discountBaht,
        amountPaid: amountPaidBaht,
        // Primary payment method → SalesInvoiceHdr.Receipt_Type (vendor 16-07-26).
        paymentType: primaryMethod,
        cashierId,
        cashierName: created.cashier?.name ?? "",
        customerId: created.customer?.id ?? null,
        customerCode: created.customer?.taxId ?? null,
        customerName: created.customer?.name ?? null,
        customerAddress: created.customer?.address ?? null,
        branchCode: outboxBranchCode,
        branchName: outboxBranchName,
        warehouseCode: outboxWarehouseCode,
        // Bill-level promotion split (promotions program). `discount` keeps its
        // combined-bill-discount meaning (manual + promo); promoBillDiscount is the
        // promotion-only slice actually applied. Phase 6 fills the REAL values.
        promoBillDiscount: satangToString(application.promoBillDiscountSatang),
        billPromotionName: application.billPromo?.promotionName ?? null,
        // Snapshot built from the SERVER-recomputed per-line result (`totals.lines`,
        // OrderLineResult) so the KRS net-out wire fields (lineDiscount, lineNet) come
        // from the same integer-satang recompute as the persisted OrderItem money — never
        // a client value, never a float round-trip. Product sku/name are attached by
        // productId (not relation position) so a repeated product never mis-attaches.
        items: totals.lines.map((l, i) => {
          const prod = snapshotProductById.get(l.productId);
          const appLine = application.lines[i];
          return {
            itemCode: prod?.sku ?? "",
            description: prod?.name ?? "",
            quantity: l.quantity,
            unitPrice: satangToString(l.priceSatang),
            lineTotal: satangToString(l.lineTotalSatang),
            // Real combined per-line discount (manual + promo) actually applied, folded
            // into lineTotal (= gross - lineDiscount). `l.lineDiscountSatang` is the
            // clamped combined value computeOrderTotals fed the engine — it equals
            // application.lines[i].combinedLineDiscountSatang, so this carries BOTH the
            // manual and promo per-line slices to KRS. Previously hardcoded "0.00".
            lineDiscount: satangToString(l.lineDiscountSatang),
            // Fully-net line amount AFTER the bill-discount allocation — the KRS net-out
            // wire amount (Dtl.Amount). Σ lineNet === Order.total.
            lineNet: satangToString(l.lineNetSatang),
            // Promotions program (Phase 6): the promotion-only per-line slice + applied
            // promo name. Informational split; the combined value is in `lineDiscount`.
            linePromoDiscount: satangToString(appLine.promoDiscountSatang),
            promotionName: appLine.promo?.promotionName ?? null,
          };
        }),
      };

      await tx.syncJob.create({
        data: {
          type: SyncJobType.SALE,
          direction: SyncDirection.INSERT,
          ref: orderNumber,
          // Pass the Order's own Decimal total straight through (no Number() round-trip).
          amount: created.total,
          status: SyncJobStatus.PENDING,
          provider: "KRS",
          idempotencyKey,
          payload: salePayload as unknown as Prisma.InputJsonValue,
          attempts: 0,
          branchId: created.branchId,
        },
      });

      return created;
    });

    // Promotions program (Phase 6): compact snapshot of every promotion applied to
    // this sale — the winning line promo per line plus the bill-level promo, if any —
    // for the audit trail. `satang` is the discount that promo contributed. Empty
    // array = no promotion applied (the common case), keeping the detail compact.
    const appliedPromotions = [
      ...application.lines
        .filter((l) => l.promo !== null)
        .map((l) => ({
          id: l.promo!.promotionId,
          name: l.promo!.promotionName,
          satang: l.promo!.discountSatang,
        })),
      ...(application.billPromo
        ? [
            {
              id: application.billPromo.promotionId,
              name: application.billPromo.promotionName,
              satang: application.billPromo.discountSatang,
            },
          ]
        : []),
    ];

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
        promotions: appliedPromotions,
      }),
    });

    // Success request-log line (D3 — mutation route). No PII / no amounts / no
    // body: status + durationMs only; method/path/requestId arrive via the mixin.
    logger.info(
      { method: "POST", path: "/api/orders", status: 201, durationMs: Date.now() - startedAt },
      "order created"
    );

    // === KRS outbound REALTIME trigger (best-effort, fire-and-forget) ===
    // The SALE SyncJob was durably committed INSIDE the checkout $transaction above,
    // so the sale is already safe no matter what happens next. This non-blocking
    // self-HTTP POST nudges the bearer-protected dispatch endpoint to drain the outbox
    // NOW (~1-2s) instead of waiting up to 30s for the krs-dispatch-cron. Safety:
    //   • NOT awaited and `.catch(() => {})` — it can NEVER throw, delay, or change the
    //     checkout 201 response below.
    //   • The dispatch route is idempotent + run-locked (runDispatch owns the atomic
    //     claim/dedup/retry), so a concurrent cron + this trigger draining at the same
    //     time is safe — no double-write to KRS.
    //   • If KRS_DISPATCH_SECRET is unset, or the fetch fails / 401s, the 30s cron is
    //     the guaranteed backstop — a lost or failed trigger only DELAYS dispatch to the
    //     next cron tick, it never loses or duplicates the KRS write.
    //   • Self-HTTP (127.0.0.1:3000 — the app calling itself in-container), NOT a direct
    //     runDispatch/dispatcher import, so THIS checkout route stays mssql-free (the
    //     driver lives behind the endpoint). Uses the SAME bearer the route validates
    //     (KRS_DISPATCH_SECRET). Only fires on this NEW-sale path, not the idempotent
    //     200 replays (the SyncJob already exists for a replayed order).
    void fetch("http://127.0.0.1:3000/api/krs/dispatch", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.KRS_DISPATCH_SECRET ?? ""}` },
    }).catch(() => {});

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
    // P2002 unique-constraint violations on checkout (Sub-phase C). Inspect the
    // violated index (`err.meta.target`) and branch by which constraint lost the
    // race:
    //
    //   • idempotencyKey → a concurrent SAME-KEY request won the create race after
    //     this one passed the replay pre-check. This is NOT an error: re-read the
    //     winner by key and return it (200 replay), so a double-submit collapses
    //     to a single sale even under true concurrency.
    //
    //   • orderNumber → the daily counter should now prevent this (the atomic
    //     ON CONFLICT upsert mints a unique seq per request). Kept as a defensive
    //     409 the client can retry, never a silent 500.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      // Capture the narrowed (non-null) key so TS knows the findUnique `where`
      // gets a string, not string | null.
      const conflictKey = normalizedIdemKey;
      // FIX A — never let an idempotencyKey collision fall through to 409.
      // `p2002Mentions` returns false when `err.meta.target` is undefined (which
      // Prisma can emit under some engine/connector conditions). If we required a
      // POSITIVE idempotencyKey match to even attempt the replay, a concurrent
      // same-key loser whose collision really WAS on idempotencyKey would wrongly
      // get 409 ORDER_NUMBER_CONFLICT. So: when this request carries a key and the
      // target does NOT clearly indicate orderNumber, attempt the winner-read by
      // key. The target "clearly indicates orderNumber" only when it mentions
      // orderNumber AND not idempotencyKey — anything undefined/ambiguous is
      // treated as a possible idempotencyKey collision and replayed if a winner
      // exists. We only reach the 409 below for a clear orderNumber collision, or
      // when the winner-read genuinely finds nothing.
      const mentionsIdem = p2002Mentions(err, "idempotencyKey");
      const mentionsOrderNo = p2002Mentions(err, "orderNumber");
      const clearlyOrderNumber = mentionsOrderNo && !mentionsIdem;
      if (conflictKey !== null && !clearlyOrderNumber) {
        // The winning order is guaranteed committed (the unique violation proves
        // it). Re-read and replay it. If the winner is NOT found, this was not an
        // idempotencyKey collision (or the row vanished) → fall through to 409.
        const winner = await prisma.order.findUnique({
          where: { idempotencyKey: conflictKey },
          include: ORDER_INCLUDE,
        });
        if (winner) {
          return NextResponse.json(serializeOrder(winner), { status: 200 });
        }
      }
      // orderNumber collision (or an unexpected unique target with no key winner)
      // → defensive 409 the client can retry, never a silent 500.
      return NextResponse.json(
        { error: "เลขที่บิลซ้ำ กรุณาลองใหม่", code: "ORDER_NUMBER_CONFLICT" },
        { status: 409 }
      );
    }
    // Sanitized 500 — never leak internals to the client.
    logger.error({ err }, "POST /api/orders failed");
    return NextResponse.json(
      { error: "Could not create order", code: "INTERNAL" },
      { status: 500 }
    );
  }
  });
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

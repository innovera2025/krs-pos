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
  PointsTxType,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
// Per-item VAT kill switch (per-item-vat program). Read from the validated env below;
// gates whether the server recompute charges VAT per item or uniformly (see the flag
// read in POST). OFF in prod until the KRS mixed-VAT writeback is adapted.
import { env } from "@/lib/env";
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
// Loyalty program (Phase 1B/2) — the pure, isomorphic points engine. `pointsEarned`
// turns the bill's NET total (integer satang) + the store earn rate into whole
// points; `computeRedemption` (Phase 2) resolves a redeem REQUEST into the exact
// points spent + satang discount (the third bill-discount slice). Imports no
// Prisma/mssql (driver-free), the same discipline as the promo engine, so the
// checkout route's module graph stays clean.
import { pointsEarned, computeRedemption } from "@/lib/loyalty";
// Reward redemption (loyalty program, Phase 3B) — the pure resolver that validates every
// redeemed reward's product is in the cart with enough quantity and yields the per-product
// free-unit discount + attribution + the reward slice of the points spend. Dependency-free
// (no Prisma/mssql), the same discipline as the promo/loyalty engines. The free-unit value
// enters the SAME per-line discount input as the manual "ส่วนลดรายการ" BEFORE
// applyPromotions, so the engine subtotal nets the reward and the drift guard holds
// UNCHANGED; the points are spent atomically COMBINED with the baht redemption below.
import {
  computeRewardRedemption,
  findRewardLinePromoConflict,
  type RedeemedReward,
  type CartLineInfo,
  type RewardAttribution,
} from "@/lib/rewardRedeem";
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

    // --- optional date range (Sales History range filter) ---
    // `from`/`to` carry ISO UTC instants. The client converts its two Asia/Bangkok
    // `<input type="date">` calendar days to instants via bangkokDayStringToWindow:
    // `from` → START of that Bangkok day, `to` → START of the NEXT Bangkok day (the
    // EXCLUSIVE upper bound — see the createdAt filter below, which uses `lt` on the
    // to-bound). Each is independently optional; a present-but-unparseable value
    // returns a coded 400 (BAD_DATE) rather than being silently ignored, matching
    // the route's error style. When BOTH are present the range is validated:
    // from ≤ to (BAD_RANGE) and span ≤ MAX_RANGE_DAYS (RANGE_TOO_WIDE).
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

    // createdAt filter — HALF-OPEN [from, to): `from` is the INCLUSIVE lower bound
    // (gte) and `to` is the EXCLUSIVE upper bound (lt). This matches the Sales
    // History date filter (client sends `to` = START of the day AFTER the selected
    // "ถึง" day) and the promotions-report convention (gte start, lt nextDay), so a
    // single Bangkok day selected on both ends covers every bill of that day.
    // Composable with the status/sync enum filters + the take:200 page.
    const createdAt: Prisma.DateTimeFilter = {};
    if (fromDate) createdAt.gte = fromDate;
    if (toDate) createdAt.lt = toDate;
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
  // Loyalty redemption (loyalty program, Phase 2). Optional non-negative integer:
  // the whole points the cashier wants to spend as a baht discount. NO money is sent
  // — the server recomputes the satang value from the store point value and folds it
  // in as the third bill-discount slice. Applies ONLY when loyalty is on AND the
  // linked customer is an enrolled member; otherwise it is ignored (no redemption).
  redeemPoints?: number;
  // Reward redemption (loyalty program, Phase 3B). Optional array of reward ids (0..N)
  // the member is redeeming — each gives 1 unit of that reward's product FREE (a per-line
  // discount = the unit price). NO money/points are trusted from the client: the server
  // loads each reward, resolves the free-unit value from the DB price, and spends
  // `Σ reward.pointsCost` COMBINED with the baht redemption above (one atomic decrement).
  // Applies ONLY when loyalty is on AND the linked customer is an enrolled member; a
  // non-empty array without a member is rejected (422 REWARD_REQUIRES_MEMBER).
  redeemRewardIds?: string[];
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
    redeemPoints,
    redeemRewardIds,
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

  // --- duplicate product-line guard (FIX B — adversarial review) ---
  // `items[]` must carry AT MOST ONE line per productId. The legit POS client always
  // merges a repeated scan into a single line (qty n), so a duplicate productId only
  // arrives via a crafted request — and the reward pipeline can't tolerate it: the
  // per-product reward free-unit value is injected into only the FIRST matching line,
  // while `cartByProduct` aggregates qty across ALL duplicate lines, so a split-line
  // request would land the reward on the wrong-sized line (wrong total + an
  // OrderItem.rewardDiscount that can exceed that line's own gross). Reject the whole
  // request at the boundary — BEFORE any reward/pricing logic — so one-line-per-product
  // holds and the reward discount always lands on the right, correctly-sized line.
  {
    const seenProductIds = new Set<string>();
    for (const i of items) {
      if (seenProductIds.has(i.productId)) {
        return NextResponse.json(
          { error: "รายการสินค้าซ้ำ", code: "DUPLICATE_PRODUCT_LINE" },
          { status: 400 }
        );
      }
      seenProductIds.add(i.productId);
    }
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

  // --- points-redemption input boundary (loyalty program, Phase 2) ---
  // Optional; when present it MUST be a non-negative integer (whole points) that fits
  // the Int4 column. A member customer must be attached for it to APPLY (checked after
  // the recompute), but a malformed value is rejected at the boundary here rather than
  // silently ignored, so a buggy client fails loudly. Absent/null/0 = no redemption
  // (byte-identical to a pre-loyalty bill). The server NEVER trusts the redeemed value
  // — it recomputes the satang from the store point value below.
  let requestedRedeemPoints = 0;
  if (redeemPoints !== undefined && redeemPoints !== null) {
    if (
      !Number.isFinite(redeemPoints) ||
      !Number.isInteger(redeemPoints) ||
      redeemPoints < 0 ||
      redeemPoints > INT4_MAX
    ) {
      return NextResponse.json(
        { error: "Invalid redeem points", code: "BAD_REDEEM" },
        { status: 400 }
      );
    }
    requestedRedeemPoints = redeemPoints;
  }

  // --- reward-redemption input boundary (loyalty program, Phase 3B) ---
  // Optional; when present it MUST be an array of non-empty strings, capped at
  // MAX_REWARD_REDEMPTIONS (a real redeem is a handful), with NO duplicate ids (each reward
  // is redeemed at most once per sale). A malformed value / duplicate is rejected at the
  // boundary here rather than silently ignored, so a buggy client fails loudly. Absent /
  // empty = no reward redemption (byte-identical to a pre-3B bill). The server NEVER trusts
  // the reward's value — it loads the reward + resolves the free-unit price from the DB below.
  const MAX_REWARD_REDEMPTIONS = 20;
  let normalizedRewardIds: string[] = [];
  if (redeemRewardIds !== undefined && redeemRewardIds !== null) {
    if (!Array.isArray(redeemRewardIds)) {
      return NextResponse.json(
        { error: "Invalid reward selection", code: "BAD_REWARD" },
        { status: 400 }
      );
    }
    if (redeemRewardIds.length > MAX_REWARD_REDEMPTIONS) {
      return NextResponse.json(
        { error: "แลกของรางวัลได้ไม่เกิน 20 รายการต่อบิล", code: "TOO_MANY_REWARDS" },
        { status: 422 }
      );
    }
    const seen = new Set<string>();
    for (const rid of redeemRewardIds) {
      if (typeof rid !== "string" || rid.trim().length === 0 || rid.trim().length > 40) {
        return NextResponse.json(
          { error: "Invalid reward selection", code: "BAD_REWARD" },
          { status: 400 }
        );
      }
      const trimmed = rid.trim();
      if (seen.has(trimmed)) {
        // Each reward is redeemable at most once per bill — a duplicate is a client bug
        // (redeeming the same reward twice would double-spend points for one config).
        return NextResponse.json(
          { error: "เลือกของรางวัลซ้ำกัน", code: "REWARD_DUPLICATE" },
          { status: 422 }
        );
      }
      seen.add(trimmed);
      normalizedRewardIds.push(trimmed);
    }
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
      | { id: string; taxId: string | null; isMember: boolean; pointsBalance: number }
      | null = null;
    if (normalizedCustomerId) {
      resolvedCustomer = await prisma.customer.findUnique({
        where: { id: normalizedCustomerId },
        // `isMember` + `pointsBalance` (loyalty program, Phase 1B/2) are selected here
        // so the earn AND redeem decisions below reuse this SAME anti-tamper customer
        // read — no extra query. `pointsBalance` is the last-read balance for the
        // FRIENDLY pre-tx overdraw check only; the atomic in-tx guard is the real gate.
        select: { id: true, taxId: true, isMember: true, pointsBalance: true },
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
      // `vatable` (per-item-vat program) rides along so computeOrderTotals can charge VAT
      // per item when the flag is on. It is IGNORED by pricing when perItemVat is false, so
      // selecting it changes no money on the flag-off path.
      select: { id: true, price: true, vatable: true },
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

    // --- Loyalty EARN config (loyalty program, Phase 1B) ---
    // A single pre-tx read of the store loyalty singleton (this route has no prior
    // ShopSettings read of its own — getSellerConfig reads a DIFFERENT column set).
    // Selects the earn-side config AND the redemption config (Phase 2:
    // redeemPointValueSatang = satang per point, minRedeemPoints = redeem floor). Runs
    // inside the sanitized try, so a DB failure maps to the route's INTERNAL 500 like
    // every other pre-tx read. A missing row (null) or loyaltyEnabled=false disables
    // earning AND redemption entirely, keeping a non-member / loyalty-off bill
    // byte-identical to before this feature.
    const loyaltySettings = await prisma.shopSettings.findUnique({
      where: { id: "singleton" },
      select: {
        loyaltyEnabled: true,
        earnBahtPerPoint: true,
        redeemPointValueSatang: true,
        minRedeemPoints: true,
      },
    });

    // Per-item catalog price in integer satang, keyed by productId. Uses the SAME
    // Decimal→satang conversion (`toSatang`) that computeOrderTotals applies to these
    // rows, so the engine's per-line gross equals pricing's gross exactly (the
    // subtotal cross-check below depends on this). A productId absent from the ACTIVE
    // product rows maps to 0 here → gross 0 → no promo; computeOrderTotals then throws
    // OrderProductMissingError (→ 404) for that same line, preserving the existing
    // unknown/inactive-product behavior.
    const priceById = new Map(products.map((p) => [p.id, toSatang(p.price)]));

    // --- Reward redemption resolution (loyalty program, Phase 3B) ---
    // A reward = "spend N points, get 1 unit of product P free". Resolve the redeemed
    // rewards BEFORE building the engine's cart lines so each reward's free-unit value can
    // be injected as an EXTRA per-line discount (the CLEAN pipeline injection: it enters the
    // same input as the manual line discount, so applyPromotions computes the subtotal WITH
    // the reward and the drift guard below holds unchanged). All server-authoritative — the
    // client-sent ids are re-loaded, the free-unit price comes from the DB, and the points
    // are spent atomically COMBINED with the baht redemption. `rewardDiscountByProduct` /
    // `rewardAttributionByProduct` / `rewardPointsTotal` stay empty for a bill with no
    // reward redemption (byte-identical to a pre-3B bill).
    let rewardDiscountByProduct = new Map<string, number>();
    let rewardAttributionByProduct = new Map<string, RewardAttribution>();
    let rewardPointsTotal = 0;
    if (normalizedRewardIds.length > 0) {
      // A reward redemption REQUIRES loyalty ON + an enrolled member on the bill. Reject the
      // whole redeem with a clear code (rather than silently ignoring it) so the cashier
      // knows why — the client also gates this, but the server is authoritative.
      if (
        loyaltySettings?.loyaltyEnabled !== true ||
        resolvedCustomer?.isMember !== true
      ) {
        return NextResponse.json(
          { error: "ต้องเลือกสมาชิกก่อนแลกของรางวัล", code: "REWARD_REQUIRES_MEMBER" },
          { status: 422 }
        );
      }
      // Load every redeemed reward (pre-tx Prisma read, inside the sanitized try). A missing
      // id (unknown / deleted) OR an inactive reward → 422 REWARD_UNAVAILABLE: you cannot
      // redeem a reward that no longer exists or was turned off.
      const rewardRows = await prisma.reward.findMany({
        where: { id: { in: normalizedRewardIds } },
        select: { id: true, name: true, pointsCost: true, productId: true, isActive: true },
      });
      const rewardById = new Map(rewardRows.map((r) => [r.id, r]));
      for (const rid of normalizedRewardIds) {
        const row = rewardById.get(rid);
        if (!row || row.isActive !== true) {
          return NextResponse.json(
            { error: "ของรางวัลนี้ไม่พร้อมให้แลกแล้ว", code: "REWARD_UNAVAILABLE" },
            { status: 422 }
          );
        }
      }
      // The cart's per-product rollup (summed quantity + DB unit price in satang). ONLY
      // active cart products are in priceById, so a reward whose product is absent/inactive
      // is not in this map → the resolver names it as REWARD_PRODUCT_NOT_IN_CART below.
      const cartByProduct = new Map<string, CartLineInfo>();
      for (const i of items) {
        const priceSatang = priceById.get(i.productId);
        if (priceSatang === undefined) continue; // inactive/unknown — computeOrderTotals rejects it
        const existing = cartByProduct.get(i.productId);
        if (existing) existing.quantity += i.quantity;
        else cartByProduct.set(i.productId, { quantity: i.quantity, priceSatang });
      }
      // Build the resolver input IN THE CLIENT-SENT ORDER (so a "not in cart" failure names
      // the first offending reward the cashier selected).
      const redeemedRewards: RedeemedReward[] = normalizedRewardIds.map((rid) => {
        const row = rewardById.get(rid)!; // present (checked above)
        return {
          id: row.id,
          name: row.name,
          productId: row.productId,
          pointsCost: row.pointsCost,
        };
      });
      const rewardResult = computeRewardRedemption(redeemedRewards, cartByProduct);
      if (!rewardResult.ok) {
        // The reward's product is not in the cart (or the cart qty can't cover one free unit
        // per reward on it) → name the reward so the cashier adds the product or drops it.
        return NextResponse.json(
          {
            error: `ต้องมีสินค้าของรางวัล "${rewardResult.rewardName}" อยู่ในตะกร้าเพื่อแลก`,
            code: "REWARD_PRODUCT_NOT_IN_CART",
          },
          { status: 422 }
        );
      }
      // --- reward vs. line-promo conflict guard (FIX A — adversarial review) ---
      // A reward's free unit rides the per-line discount input and competes with any
      // active LINE-level promo on the same product for the same gross ceiling (the
      // engine clamps promo + reward ≤ gross), so the member would spend full points yet
      // get less than a whole free unit. For v1 DISALLOW stacking: if any redeemed
      // reward's product carries an active line-level promotion this sale (PRODUCT_DISCOUNT
      // / FIXED_PRICE / BUY_X_GET_Y — all product-scoped; a BILL_THRESHOLD promo is
      // bill-level and does NOT conflict), reject the whole redeem naming the reward. Built
      // from the already-fetched `activePromos`, so no extra DB read. Runs BEFORE the
      // free-unit value is injected below.
      const productIdsWithLinePromo = new Set<string>();
      for (const p of activePromos) {
        if (
          p.type === "PRODUCT_DISCOUNT" ||
          p.type === "FIXED_PRICE" ||
          p.type === "BUY_X_GET_Y"
        ) {
          if (Array.isArray(p.productIds)) {
            for (const pid of p.productIds) productIdsWithLinePromo.add(pid);
          }
        }
      }
      const conflict = findRewardLinePromoConflict(
        redeemedRewards,
        productIdsWithLinePromo
      );
      if (conflict) {
        return NextResponse.json(
          {
            error: `ของรางวัล "${conflict.name}" ใช้กับสินค้าที่มีโปรโมชันอยู่แล้วไม่ได้`,
            code: "REWARD_PROMO_CONFLICT",
          },
          { status: 422 }
        );
      }
      rewardDiscountByProduct = rewardResult.plan.discountByProduct;
      rewardAttributionByProduct = rewardResult.plan.attributionByProduct;
      rewardPointsTotal = rewardResult.plan.totalRewardPoints;
    }

    // Build the engine's cart lines in the SAME order as items[] — priceSatang from
    // the DB (never the client), manualLineDiscountSatang from the request's per-line
    // discount input (the engine re-clamps it defensively).
    //
    // REWARD INJECTION (loyalty program, Phase 3B): a redeemed reward's free-unit value is
    // ADDED to that product line's manual line discount, so the reward enters the pricing
    // pipeline the CLEAN way — the SAME per-line input the cashier's "ส่วนลดรายการ" uses.
    // Injected into the FIRST line of each product (the `Set` guard) so a pathological
    // duplicate-line request can't double-apply it; the POS client always emits one line per
    // product, so the reward lands whole. The engine clamps combined line discount ≤ line
    // gross, so a line NEVER goes negative even when a manual discount is also present.
    //
    // FIX A (defense-in-depth, adversarial review): for a product that IS a reward target the
    // server IGNORES any client-sent per-line manual discount — `manualLineDiscountSatang` is
    // forced to 0 before the free-unit value is added — so a crafted request can't stack a
    // manual discount ON TOP of the reward on the same line (the engine would otherwise clamp
    // the SUM to gross, letting a manual discount silently eat into the reward's value). The
    // POS UI already hides the manual control on a reward line; this makes the server
    // authoritative. A non-reward line keeps its manual discount unchanged.
    const rewardInjectedProducts = new Set<string>();
    const promoLines: PromoCartLine[] = items.map((i) => {
      const rewardForProduct = rewardDiscountByProduct.get(i.productId) ?? 0;
      const isRewardTarget = rewardForProduct > 0;
      let rewardInject = 0;
      if (isRewardTarget && !rewardInjectedProducts.has(i.productId)) {
        rewardInject = rewardForProduct;
        rewardInjectedProducts.add(i.productId);
      }
      // Reward-targeted line → drop the client manual discount (authoritative); otherwise
      // keep it. The reward free-unit value is then the only injected discount on that line.
      const manualLineDiscountSatang = isRewardTarget ? 0 : i.lineDiscountSatang ?? 0;
      return {
        productId: i.productId,
        priceSatang: priceById.get(i.productId) ?? 0,
        quantity: i.quantity,
        manualLineDiscountSatang: manualLineDiscountSatang + rewardInject,
      };
    });

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

    // --- Loyalty REDEEM: points → the THIRD bill-discount slice (loyalty program, Phase 2) ---
    // Money Contract: points redemption is a bill-level discount applied AFTER the
    // promo-threshold + manual slices (both already resolved by applyPromotions), each
    // clamped to what remains. `remainingBillSatang` = what a FURTHER bill discount can
    // still cover = subtotal − promoBill − manual (always ≥ 0: both are clamped so their
    // sum never exceeds the subtotal). Redemption applies ONLY when loyalty is ENABLED
    // AND the linked customer is an enrolled member AND a >0 redeem was requested;
    // otherwise redemptionSatang / effectiveRedeemPoints stay 0, byte-identical to a
    // no-redeem bill. Server is authoritative — the client-sent points are recomputed.
    let redemptionSatang = 0;
    let effectiveRedeemPoints = 0;
    if (
      loyaltySettings?.loyaltyEnabled === true &&
      resolvedCustomer?.isMember === true &&
      requestedRedeemPoints > 0
    ) {
      const remainingBillSatang =
        application.subtotalSatang -
        application.promoBillDiscountSatang -
        application.manualBillDiscountSatang;
      // Pure, satang-exact: caps points to min(request, balance, floor(remaining /
      // pointValue)) so every redeemed point maps EXACTLY to pointValue satang (no
      // fractional point spent for a partial-satang remainder), and returns the two
      // pre-tx guard flags below.
      const plan = computeRedemption(
        requestedRedeemPoints,
        resolvedCustomer.pointsBalance,
        remainingBillSatang,
        loyaltySettings.redeemPointValueSatang,
        loyaltySettings.minRedeemPoints
      );
      // FRIENDLY pre-tx overdraw check (the in-tx atomic `updateMany WHERE balance >= n`
      // is the REAL, race-proof gate; this only avoids doing work for an obvious overdraw).
      if (plan.exceedsBalance) {
        return NextResponse.json(
          { error: "แต้มสะสมไม่เพียงพอ", code: "POINTS_INSUFFICIENT" },
          { status: 422 }
        );
      }
      // Min-redeem floor. Distinguish two "below the floor" cases (FIX 3) so the cashier
      // gets an ACTIONABLE message:
      //  - `billTooSmallForMin`: the REMAINING bill can't reach the floor no matter what —
      //    the redeem control should never have been offered (the client hides it too). A
      //    "redeem more" message would be impossible to satisfy, so return a clearer
      //    "bill too small" code. Checked FIRST because a too-small bill also trips belowMin.
      //  - `belowMin`: the bill COULD support the floor but the request was under it → tell
      //    the client to redeem more (or clear) rather than silently zeroing the redemption
      //    (a phantom "you redeemed" state would diverge from the total → PAYMENT_MISMATCH).
      if (plan.billTooSmallForMin) {
        return NextResponse.json(
          {
            error: `ยอดบิลนี้ไม่พอสำหรับการใช้แต้ม (ขั้นต่ำ ${loyaltySettings.minRedeemPoints} แต้ม)`,
            code: "POINTS_REDEEM_UNAVAILABLE",
          },
          { status: 422 }
        );
      }
      if (plan.belowMin) {
        return NextResponse.json(
          {
            error: `ต้องแลกอย่างน้อย ${loyaltySettings.minRedeemPoints} แต้ม`,
            code: "POINTS_BELOW_MIN",
          },
          { status: 422 }
        );
      }
      redemptionSatang = plan.redemptionSatang;
      effectiveRedeemPoints = plan.effectiveRedeemPoints;
    }

    // --- Combined points spend (loyalty program, Phase 3B) ---
    // The TOTAL points this sale spends = the baht-redemption points (Phase 2) + the reward
    // points (Phase 3B). Both were resolved server-side (effectiveRedeemPoints against the
    // bill; rewardPointsTotal from the loaded rewards). They are spent as ONE atomic
    // decrement in the tx below so the member's balance can NEVER be over-committed across
    // baht + reward (a second separate decrement could each individually pass its own guard
    // yet jointly overdraw). `pointsSpendCustomerId` is the member to charge — set only when
    // there is something to spend; rewardPointsTotal is > 0 only for a member (guarded in the
    // reward block) and effectiveRedeemPoints only for a member (guarded above), so
    // `resolvedCustomer` is always present when `totalPointsSpend > 0`. The FRIENDLY pre-tx
    // check on the COMBINED total returns a clean 422 before doing work; the in-tx atomic
    // `updateMany WHERE pointsBalance >= totalPointsSpend` is the real, race-proof gate.
    const totalPointsSpend = effectiveRedeemPoints + rewardPointsTotal;
    let pointsSpendCustomerId: string | null = null;
    if (totalPointsSpend > 0 && resolvedCustomer) {
      if (totalPointsSpend > resolvedCustomer.pointsBalance) {
        return NextResponse.json(
          { error: "แต้มสะสมไม่เพียงพอ", code: "POINTS_INSUFFICIENT" },
          { status: 422 }
        );
      }
      pointsSpendCustomerId = resolvedCustomer.id;
    }

    // The single combined bill discount handed to pricing = the THREE bill-discount
    // slices: promo threshold + manual + points redemption. This REPLACES the engine's
    // `application.combinedBill` (which carried only promo + manual). `redemptionSatang`
    // is ≤ remaining by construction, so promoBill + manual + redemption ≤ subtotal, and
    // `computeTotals` clamps to the subtotal anyway. Round-trip: combinedBillSatang is an
    // integer, so `roundSatang((combinedBillSatang / 100) * 100) === combinedBillSatang`
    // exactly across the Decimal(10,2) range (same proof as promotionEngine.combinedBill).
    const combinedBillSatang =
      application.promoBillDiscountSatang +
      application.manualBillDiscountSatang +
      redemptionSatang;

    // --- Per-item VAT flag (per-item-vat program) ---
    // Kill switch, read from the validated env (mirrors the KRS_DISCOUNT_WRITE_ENABLED
    // discipline: the OWNER flips it; an agent never does). When NOT exactly "true",
    // pricing treats EVERY line as VAT-applicable, so `totals.vatSatang` (→ Order.tax) and
    // the bill total are BYTE-IDENTICAL to the pre-per-item behavior. When "true", a line
    // whose product is `vatable === false` extracts 0 VAT — Order.tax drops, but the bill
    // TOTAL is UNCHANGED (inclusive VAT only shifts the tax/ex-VAT split; the customer pays
    // the same). ⚠️ VENDOR-GATED: the KRS outbound writeback (salePayload.tax below) still
    // maps a single uniform tax, so this MUST stay OFF in prod until that writeback is
    // adapted in a later pass — otherwise a mixed-VAT bill's reduced Order.tax would reach
    // KRS through an unadapted mapping. Nothing else here (drift guard, PAYMENT_MISMATCH,
    // atomic stock/points) is affected.
    const perItemVat = env.PER_ITEM_VAT_ENABLED === "true";

    // computeOrderTotals throws OrderProductMissingError for an unknown/inactive
    // product (→ 404 below) and RangeError for an out-of-range discount (already
    // validated at the boundary above, so this is a belt-and-braces guard). The bill
    // discount is the COMBINED 3-slice bill discount (promo threshold + manual +
    // redemption), so Order.discount keeps its combined meaning and
    // `subtotal − discount === total` still holds automatically. `perItemVat` only
    // changes per-line VAT extraction (the tax split) — never subtotal/discount/total.
    const totals = computeOrderTotals(
      products,
      requestedLines,
      { type: "amount", value: combinedBillSatang / 100 },
      perItemVat
    );

    // --- Engine/pricing drift guard (belt-and-braces) ---
    // The engine and pricing compute the subtotal with the identical formula
    // (Σ max(gross − combinedLineDiscount, 0)) over the same integer-satang inputs, so
    // they MUST match. Likewise the combined 3-slice bill discount round-trips exactly,
    // so pricing's billDiscountSatang MUST equal promoBill + manualBill + redemption. A
    // mismatch means the modules diverged (a real bug) — it must NEVER ship a silently
    // wrong sale, so log the values and return 500 INTERNAL instead of persisting a bad
    // total. (`subtotal − discount === total` follows automatically once this holds.)
    if (
      totals.subtotalSatang !== application.subtotalSatang ||
      totals.billDiscountSatang !==
        application.promoBillDiscountSatang +
          application.manualBillDiscountSatang +
          redemptionSatang
    ) {
      logger.error(
        {
          pricingSubtotal: totals.subtotalSatang,
          engineSubtotal: application.subtotalSatang,
          pricingBillDiscount: totals.billDiscountSatang,
          enginePromoBill: application.promoBillDiscountSatang,
          engineManualBill: application.manualBillDiscountSatang,
          redemptionSatang,
        },
        "promotion engine / pricing drift detected"
      );
      return NextResponse.json(
        { error: "Could not create order", code: "INTERNAL" },
        { status: 500 }
      );
    }

    // --- Reward-only zero-total guard (loyalty program, Phase 3B) ---
    // A reward makes 1 unit free (a per-line discount = its price). A cart whose ONLY line
    // is the free reward item nets to total 0, which would dead-end at the payment guard
    // (every tender must be > 0 satang AND amountPaid must === total, so a 0-total sale can
    // never be paid — a confusing "amount" error). When a reward is redeemed, fail EARLY with
    // a clear, actionable code so the cashier adds a payable item. Only fires for a reward
    // redemption (rewardPointsTotal > 0); a genuine 100%-promo total-0 bill keeps its existing
    // generic guards untouched. The existing payment guards remain as belt-and-braces.
    if (rewardPointsTotal > 0 && totals.totalSatang <= 0) {
      return NextResponse.json(
        {
          error: "ต้องมีสินค้าที่ต้องชำระอย่างน้อย 1 รายการเพื่อแลกของรางวัล",
          code: "REWARD_NEEDS_PURCHASE",
        },
        { status: 422 }
      );
    }

    // --- Loyalty EARN amount (loyalty program, Phase 1B) ---
    // Post-total, side-write ONLY: this NEVER changes subtotal/discount/tax/total —
    // it credits membership points on the NET total the customer actually paid
    // (totals.totalSatang) at the store earn rate. Computed HERE (before the tx) so
    // `pointsEarned` can be written directly into tx.order.create; the customer
    // balance increment + the EARN ledger row (which need the order id) happen INSIDE
    // the tx after the order row exists. Earning applies ONLY when loyalty is ENABLED
    // AND the linked customer is an enrolled member AND the floored points are > 0 —
    // otherwise pointsToEarn stays 0 (the Order.pointsEarned column default), with NO
    // ledger row and NO customer touch, so a walk-in / non-member / loyalty-off bill
    // is byte-identical to before. This sits AFTER the idempotent replay pre-check
    // (which returns early, before any tx), so a replayed checkout never re-earns.
    let pointsToEarn = 0;
    let earnCustomerId: string | null = null;
    if (
      loyaltySettings?.loyaltyEnabled === true &&
      resolvedCustomer?.isMember === true
    ) {
      const earned = pointsEarned(
        totals.totalSatang,
        loyaltySettings.earnBahtPerPoint
      );
      if (earned > 0) {
        pointsToEarn = earned;
        earnCustomerId = resolvedCustomer.id;
      }
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
    //
    // Reward attribution (loyalty program, Phase 3B): a redeemed reward's free-unit value is
    // already folded into `lineTotal` (it rode the manual-line-discount input into the
    // engine), so the money is complete. These snapshot columns (rewardId/rewardName/
    // rewardDiscount) record WHICH reward + HOW MUCH free-unit value applied on this product
    // line — for the receipt line + reporting. `rewardDiscount` is the nominal free-unit
    // value (satang) resolved from the DB price; null/0 when no reward on this line. A line
    // is keyed by productId, so if two rewards target one product they share this row (the
    // attribution carries the joined name + summed value — see rewardRedeem.ts). The
    // attribution is written to the FIRST line of each product ONLY (the `Set` guard) —
    // MIRRORING the free-unit injection above — so a pathological duplicate-line request
    // records the value once (never double-counted in a report); the POS client emits one
    // line per product, so it lands on that single line.
    const rewardAttributedProducts = new Set<string>();
    const lineItems = totals.lines.map((l, i) => {
      const appLine = application.lines[i];
      let rewardAttr: RewardAttribution | null = null;
      const attr = rewardAttributionByProduct.get(l.productId);
      if (attr && !rewardAttributedProducts.has(l.productId)) {
        rewardAttr = attr;
        rewardAttributedProducts.add(l.productId);
      }
      return {
        productId: l.productId,
        quantity: l.quantity,
        unitPrice: satangToString(l.priceSatang),
        lineTotal: satangToString(l.lineTotalSatang),
        // Per-item VAT (per-item-vat program): snapshot the EFFECTIVE VAT treatment this
        // line received (l.vatable) — false ONLY when perItemVat was on AND the product was
        // exempt (0 VAT extracted). With the flag off this is always true, so every
        // OrderItem reads vatable=true — byte-identical record of "VAT charged on every
        // line", and the receipt shows no VAT breakdown (no visible change).
        vatable: l.vatable,
        promotionId: appLine.promo?.promotionId ?? null,
        promotionName: appLine.promo?.promotionName ?? null,
        promoDiscount: satangToString(appLine.promoDiscountSatang),
        rewardId: rewardAttr?.rewardId ?? null,
        rewardName: rewardAttr?.rewardName ?? null,
        rewardDiscount: satangToString(rewardAttr?.rewardDiscountSatang ?? 0),
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
          // Loyalty EARN (loyalty program, Phase 1B): points accrued on this sale,
          // computed above from the NET total. 0 for a walk-in / non-member / loyalty-
          // off bill (the column default) — the customer increment + EARN ledger row
          // below run ONLY when > 0, so a non-earning bill writes exactly this default.
          pointsEarned: pointsToEarn,
          // Loyalty REDEEM (loyalty program, Phase 2 + 3B): the TOTAL points SPENT this sale
          // = the baht-redemption points + the reward points (`totalPointsSpend`), so the
          // void reversal (which reads Order.pointsRedeemed) re-credits BOTH correctly with
          // no extra bookkeeping. `pointsRedemptionDiscount` is the BAHT-redemption slice of
          // `discount` ONLY (`redemptionSatang`) — the reward's value is a LINE discount
          // already inside `lineTotal`/`discount`, so folding it into this bill slice too
          // would double-count it. Both are 0 for a no-redeem bill (the column defaults); the
          // atomic spend + REDEEM ledger row below run ONLY when totalPointsSpend > 0.
          pointsRedeemed: totalPointsSpend,
          pointsRedemptionDiscount: satangToString(redemptionSatang),
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

      // === Loyalty points REDEEM (loyalty program, Phase 2 + 3B) ===
      // Runs BEFORE the EARN block (Money Contract ordering): SPEND first, then EARN on
      // the net total the member paid. `totals.totalSatang` already nets out BOTH the baht
      // redemption AND the reward free-unit(s) (each folded into the combined line/bill
      // discounts), so EARN below credits exactly what they paid — no change to the earn
      // computation.
      //
      // ONE COMBINED atomic decrement of `totalPointsSpend` (= baht-redemption points +
      // reward points). Doing it as a SINGLE `updateMany WHERE pointsBalance >= totalPointsSpend`
      // (not two separate decrements) is the invariant that stops the balance being
      // over-committed across baht + reward: two independent decrements could each pass their
      // own guard yet jointly overdraw. Same `count === 1` pattern as the stock decrement — two
      // concurrent redeems of the last points cannot both succeed, and `pointsBalance` can
      // NEVER go negative. A 0-count means the balance dropped below the spend between the
      // pre-tx read and here (a concurrent redeem / manual adjust), so we throw → the WHOLE
      // sale rolls back (order + stock + this redeem), never recording a spend without its
      // discount/free-unit or vice-versa. `orderId` is a plain String snapshot (no FK, matching
      // EARN). Skipped entirely when nothing was redeemed (pointsSpendCustomerId null) —
      // byte-identical to a no-redeem bill (no customer touch, no ledger row).
      if (totalPointsSpend > 0 && pointsSpendCustomerId) {
        const spent = await tx.customer.updateMany({
          where: {
            id: pointsSpendCustomerId,
            isMember: true,
            pointsBalance: { gte: totalPointsSpend },
          },
          data: { pointsBalance: { decrement: totalPointsSpend } },
        });
        if (spent.count !== 1) {
          throw new InsufficientPointsError(pointsSpendCustomerId);
        }
        // `updateMany` returns no row, so read the post-decrement balance for the
        // ledger's self-verifying `balanceAfter`. Inside the tx this reads the value THIS
        // tx just wrote (the decrement above), which the EARN block then increments — so
        // the two ledger rows carry the correct SEQUENTIAL running balance (spend first,
        // then earn on top).
        const afterRedeem = await tx.customer.findUnique({
          where: { id: pointsSpendCustomerId },
          select: { pointsBalance: true },
        });
        await tx.pointsTransaction.create({
          data: {
            customerId: pointsSpendCustomerId,
            orderId: created.id,
            type: PointsTxType.REDEEM,
            // Signed: NEGATIVE = points spent (the mirror of EARN's positive delta). ONE row
            // for the COMBINED spend; the note splits the baht vs reward portions for the trail.
            points: -totalPointsSpend,
            balanceAfter: afterRedeem?.pointsBalance ?? 0,
            note: `redeem: ${effectiveRedeemPoints} baht-pts + ${rewardPointsTotal} reward-pts`,
            actorId: cashierId,
          },
        });
      }

      // === Loyalty points EARN (loyalty program, Phase 1B) ===
      // Runs ONLY for an enrolled member on a bill that earned > 0 points (decided
      // pre-tx above; earnCustomerId is null otherwise). Atomic with the sale: the
      // pointsBalance increment + the EARN ledger row commit in the SAME $transaction
      // as the Order/stock, so a member's cached balance and their ledger can never
      // disagree, and a rolled-back sale (e.g. the INSufficient-stock throw above)
      // also rolls back the points — no phantom accrual. `increment` is atomic under
      // concurrency; `balanceAfter` snapshots the post-increment balance for the
      // self-verifying ledger. `orderId` is a plain String snapshot (no FK, matching
      // the schema). A walk-in / non-member / loyalty-off bill skips this block
      // entirely — no customer touch, no ledger row (byte-identical to today).
      if (pointsToEarn > 0 && earnCustomerId) {
        const updatedCust = await tx.customer.update({
          where: { id: earnCustomerId },
          data: { pointsBalance: { increment: pointsToEarn } },
          select: { pointsBalance: true },
        });
        await tx.pointsTransaction.create({
          data: {
            customerId: earnCustomerId,
            orderId: created.id,
            type: PointsTxType.EARN,
            points: pointsToEarn,
            balanceAfter: updatedCust.pointsBalance,
            actorId: cashierId,
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
    // Loyalty redeem overdraw lost the atomic race (loyalty program, Phase 2): the
    // in-tx conditional decrement matched 0 rows, so the whole sale rolled back. Map
    // to the SAME coded 422 as the friendly pre-tx check so the client handles both
    // identically (re-check the balance + retry). Never a silent 500.
    if (err instanceof InsufficientPointsError) {
      return NextResponse.json(
        { error: "แต้มสะสมไม่เพียงพอ", code: "POINTS_INSUFFICIENT" },
        { status: 422 }
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

/**
 * Thrown inside the checkout transaction when the atomic conditional points
 * decrement (`updateMany WHERE isMember AND pointsBalance >= n`) matches 0 rows —
 * i.e. the member's balance dropped below the redeemed amount between the pre-tx
 * read and the spend (a concurrent redeem / manual adjust), or the customer was
 * un-enrolled. Throwing rolls back the whole transaction (order + stock + earn +
 * this redeem) and maps to a clean 422 POINTS_INSUFFICIENT — the money mirror of
 * the stock oversell guard, so a member's balance can never go negative.
 */
class InsufficientPointsError extends Error {
  constructor(public readonly customerId: string) {
    super(`Insufficient points: ${customerId}`);
    this.name = "InsufficientPointsError";
  }
}

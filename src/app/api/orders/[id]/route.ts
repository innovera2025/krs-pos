import { NextResponse } from "next/server";
import {
  Prisma,
  OrderStatus,
  SyncStatus,
  SyncJobType,
  SyncDirection,
  SyncJobStatus,
  StockMovementType,
  AuditAction,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/authRole";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
// Phase 4 — Thai full §86/4 tax invoice. Seller identity (D2, issue-time
// enforcement) + the pure number formatter. The sequential number is minted
// LOCALLY at request-tax time (D1) and written into Order.accountingDocNo.
import { getSellerConfig } from "@/lib/sellerConfig";
import { formatTaxInvoiceNumber } from "@/lib/datetime";
// Shared wire serializer (FIX 1): PATCH responses must emit the SAME 2dp string
// money fields as GET/POST. Returning a raw Prisma record let Decimal.toJSON()
// drop trailing zeros ("65.00" -> "65"), corrupting the Sales-History row after a
// refund/void. Apply serializeOrder() at EVERY PATCH return site.
import { serializeOrder } from "@/lib/orderSerialize";
// WRAP-style Zod (D1): validate the action SHAPE. To preserve the exact client
// contract, an invalid action still returns the existing 400 BAD_ACTION (not the
// generic VALIDATION code) — see the parse below. All RBAC + state-machine logic is
// unchanged.
import { OrderPatchBodySchema } from "@/lib/schemas/order";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// domain-no-destructive-delete: orders are NEVER deleted — only status
// transitions. There is intentionally NO DELETE handler on this route.
//
// AUTH (auth Phase 2): PER-ACTION RBAC. Any authenticated active session may
// reach this route (requireUser). "request-tax" stays at requireUser (a cashier
// may request a tax invoice). "refund" and "void" additionally require an admin
// (ADMIN/MANAGER) — a cashier attempting either gets a 403 FORBIDDEN.
// TODO(production-readiness): audit (who/when) + idempotency — a double-fire
// refund/void is not yet idempotent.

const ORDER_DETAIL_INCLUDE = {
  items: { include: { product: true } },
  payments: true,
  cashier: { select: { id: true, name: true } },
  customer: true,
} as const;

type PatchOrderBody = { action?: unknown };

/**
 * Mint the next sequential tax-invoice number (Phase 4 — Thai full §86/4
 * invoice, owner decision D1: LOCAL number source). Mirrors `nextOrderNumber`
 * in the checkout route: a RAW `INSERT ... ON CONFLICT (year) DO UPDATE SET
 * seq = seq + 1 RETURNING year, seq` upsert against TaxInvoiceCounter — atomic
 * in a single statement (Prisma's non-raw `upsert` is find-then-write and races
 * on the first insert of the year). The calendar YEAR is derived INSIDE the
 * upsert from the Postgres transaction clock at Asia/Bangkok
 * (`to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY')`), NOT a JS clock, so the
 * year prefix agrees with the DB and can't straddle the Bangkok New-Year window.
 *
 * Runs INSIDE the request-tax transaction so a rolled-back request does NOT
 * consume a number (§86/4(4) serial requirement: strict ascending, no reuse).
 * Defensive on a malformed/empty result so a corrupt number can never be issued.
 *
 * Also RETURNs the Postgres transaction-clock instant (`issuedAt`) from the SAME
 * statement (FIX 1 — §86/4(7) issue date). Reusing `now()` here means the printed
 * issue date and the year-prefix of the number share ONE DB clock, so they can't
 * straddle the Bangkok New-Year window or drift from a JS clock.
 */
async function nextTaxInvoiceNumber(
  tx: Prisma.TransactionClient
): Promise<{ docNo: string; issuedAt: Date }> {
  const rows = await tx.$queryRaw<
    { year: string; seq: number; issued_at: Date }[]
  >`
    INSERT INTO "TaxInvoiceCounter" ("year", "seq")
    VALUES (to_char((now() AT TIME ZONE 'Asia/Bangkok'), 'YYYY'), 1)
    ON CONFLICT ("year")
    DO UPDATE SET "seq" = "TaxInvoiceCounter"."seq" + 1
    RETURNING "year", "seq", now() AS "issued_at"
  `;
  const row = rows[0];
  const year = row?.year;
  const seq = row?.seq;
  const issuedAt = row?.issued_at;
  if (typeof year !== "string" || year.length === 0) {
    // Defensive: the upsert always returns exactly one row with the year key.
    // Never trust an empty/malformed result — it would corrupt the doc number.
    throw new Error("TaxInvoiceCounter upsert returned no year");
  }
  if (typeof seq !== "number" || !Number.isFinite(seq) || seq < 1) {
    // Defensive: the counter starts at 1; a seq < 1 would yield TAX-YYYY-000000.
    throw new Error("TaxInvoiceCounter upsert returned no sequence");
  }
  if (!(issuedAt instanceof Date) || Number.isNaN(issuedAt.getTime())) {
    // Defensive: `now()` always returns a valid timestamptz; never stamp a bad
    // issue date onto a legal document.
    throw new Error("TaxInvoiceCounter upsert returned no issued-at instant");
  }
  return { docNo: formatTaxInvoiceNumber(year, seq), issuedAt };
}

// PATCH /api/orders/[id] — refund or void a sale (append-only status transition).
//
//   { action: "refund" } — requires status COMPLETED (else 409 INVALID_STATE);
//     sets status REFUNDED. The credit-note document number is issued by the
//     accounting layer in Phase 6, so accountingDocNo is left untouched here; the
//     UI toast reports the credit note as queued.
//
//   { action: "void" }   — requires status COMPLETED (else 409 INVALID_STATE) AND
//     syncStatus !== SYNCED (else 409 VOID_SYNCED_LOCKED, domain-synced-bills-
//     locked). Sets status VOIDED, total 0, tax 0, syncStatus SKIPPED.
//
//   { action: "request-tax" } (Phase 6a; LOCAL numbering added Phase 4) —
//     requires status COMPLETED (else 409 INVALID_STATE; a REFUNDED/VOIDED bill
//     must not issue a tax invoice) AND the order to have a customerId whose
//     Customer has a non-empty taxId (else 422 TAX_REQUIRES_TAX_CUSTOMER,
//     domain-tax-invoice-requires-tax-customer). Idempotent: a bill that already
//     has taxRequested === true returns 409 ALREADY_REQUESTED (no second mint, no
//     second SyncJob). Before minting, the seller identity must be configured
//     (SELLER_TAX_ID/NAME/ADDRESS) else 422 SELLER_NOT_CONFIGURED. Phase 4 (D1):
//     the sequential §86/4 tax-invoice number is minted LOCALLY at this point —
//     in one $transaction it atomically bumps TaxInvoiceCounter, writes the
//     formatted number to Order.accountingDocNo, sets taxRequested = true, and
//     creates a PENDING TAX_INVOICE SyncJob (direction INSERT, ref = orderNumber,
//     amount = total). The KRS SyncJob is kept for reporting but the printable
//     number no longer depends on a future sync.
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  return runWithRequestId(req, async () => {
  // Start time for the success request-log line (D3 — mutation route).
  const startedAt = Date.now();
  // Any active session may reach this route; refund/void are additionally
  // restricted to admins below (after the action is parsed).
  const gate = await requireUser();
  if ("response" in gate) return gate.response;
  const { session } = gate;

  const { id } = params;
  if (typeof id !== "string" || id.length === 0) {
    return NextResponse.json(
      { error: "Missing order id", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  let body: PatchOrderBody;
  try {
    body = (await req.json()) as PatchOrderBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // WRAP-style Zod validates the action enum SHAPE. On failure we keep the EXISTING
  // 400 BAD_ACTION response (same code/status/message the client already handles) —
  // the Zod parse just centralizes the allowed-action set in one schema.
  const parsed = OrderPatchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "action must be 'refund', 'void', or 'request-tax'",
        code: "BAD_ACTION",
      },
      { status: 400 }
    );
  }
  const action = parsed.data.action;

  // AUTH (auth Phase 2): refund/void are admin-only money/ledger reversals. A
  // cashier may reach "request-tax" but not refund or void — block with 403.
  if (
    (action === "refund" || action === "void") &&
    !isAdminRole(session.user.role)
  ) {
    return NextResponse.json(
      { error: "ต้องเป็นผู้ดูแลระบบ", code: "FORBIDDEN" },
      { status: 403 }
    );
  }

  // Phase 6a — request-tax has its own validation + transaction path; it gates on
  // status COMPLETED (a REFUNDED/VOIDED bill must not enqueue a tax invoice, same
  // COMPLETED requirement as refund/void) and on the tax-customer rule.
  if (action === "request-tax") {
    try {
      const existing = await prisma.order.findUnique({
        where: { id },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          total: true,
          // Idempotency (Phase 4): a bill already flagged must not re-mint a
          // number or enqueue a second SyncJob.
          taxRequested: true,
          customer: { select: { id: true, taxId: true } },
        },
      });
      if (!existing) {
        return NextResponse.json(
          { error: "Order not found", code: "NOT_FOUND" },
          { status: 404 }
        );
      }

      // Idempotency guard (Phase 4a). A double request-tax (double-click / retry)
      // must NOT enqueue a second SyncJob or re-mint a second tax-invoice number.
      // Checked BEFORE the COMPLETED/customer gates and BEFORE minting so a repeat
      // request is a clean 409, never a duplicate document.
      if (existing.taxRequested) {
        return NextResponse.json(
          {
            error: "บิลนี้ขอใบกำกับภาษีไปแล้ว",
            code: "ALREADY_REQUESTED",
          },
          { status: 409 }
        );
      }

      // Only a COMPLETED bill can request a tax invoice — a refunded/voided bill
      // retains its customerId but must not issue a tax invoice.
      if (existing.status !== OrderStatus.COMPLETED) {
        return NextResponse.json(
          {
            error: "ออกใบกำกับภาษีได้เฉพาะบิลที่ชำระแล้ว",
            code: "INVALID_STATE",
          },
          { status: 409 }
        );
      }

      const hasTaxCustomer =
        existing.customer != null &&
        typeof existing.customer.taxId === "string" &&
        existing.customer.taxId.trim().length > 0;
      if (!hasTaxCustomer) {
        return NextResponse.json(
          {
            error: "ต้องระบุลูกค้าที่มีเลขผู้เสียภาษีก่อนออกใบกำกับภาษี",
            code: "TAX_REQUIRES_TAX_CUSTOMER",
          },
          { status: 422 }
        );
      }

      // Seller identity gate (Phase 4b; seller-company-settings: issue-time
      // enforcement, DB-primary with ENV fallback). A full §86/4 invoice MUST carry
      // the seller's name, address, and 13-digit TIN. If those resolve empty (DB
      // then ENV), refuse to mint a number — BEFORE consuming a sequence — with a
      // clear 422 so the operator configures the seller (now editable from
      // /settings) instead of issuing a non-compliant (or gap-creating) invoice.
      const seller = await getSellerConfig();
      if (!seller) {
        return NextResponse.json(
          {
            error:
              "ยังไม่ได้ตั้งค่าข้อมูลผู้ขาย (เลขประจำตัวผู้เสียภาษี/ชื่อ/ที่อยู่) สำหรับออกใบกำกับภาษี",
            code: "SELLER_NOT_CONFIGURED",
          },
          { status: 422 }
        );
      }

      // One transaction (Phase 4 — LOCAL numbering, D1 + FIX 2 double-mint race).
      // The pre-tx ALREADY_REQUESTED check above only read a snapshot, so two
      // concurrent request-tax calls could both pass it and both mint (duplicate
      // tax-invoice number + 2 SyncJobs + overwrite). The REAL guard is the
      // CONDITIONAL transition INSIDE the tx (mirrors the refund/void double-fire
      // guard): an `updateMany WHERE status=COMPLETED AND taxRequested=false` that
      // must match exactly ONE row. The mint runs ONLY on the winning path, AFTER
      // the conditional flip succeeds — so the loser matches 0 rows and rolls back
      // having consumed NO sequence and created NO second SyncJob. The mint itself
      // also runs inside the tx, so a rolled-back request never consumes a number.
      const updated = await prisma.$transaction(async (tx) => {
        // CONDITIONAL transition (FIX 2). Flip taxRequested false → true only if
        // the bill is still COMPLETED and not yet requested. count !== 1 means a
        // concurrent request already won (or the bill left COMPLETED) — throw to
        // roll back (no sequence consumed, no SyncJob created).
        const transition = await tx.order.updateMany({
          where: {
            id,
            status: OrderStatus.COMPLETED,
            taxRequested: false,
          },
          data: { taxRequested: true },
        });
        if (transition.count !== 1) {
          throw new TaxAlreadyRequestedError();
        }

        // Winner only: mint the sequential number + the §86/4(7) issue date from
        // ONE Postgres-now / Asia/Bangkok basis, then stamp them onto the order.
        const { docNo, issuedAt } = await nextTaxInvoiceNumber(tx);
        const order = await tx.order.update({
          where: { id },
          data: { accountingDocNo: docNo, taxIssuedAt: issuedAt },
          include: ORDER_DETAIL_INCLUDE,
        });
        await tx.syncJob.create({
          data: {
            type: SyncJobType.TAX_INVOICE,
            direction: SyncDirection.INSERT,
            ref: order.orderNumber,
            amount: order.total,
            status: SyncJobStatus.PENDING,
          },
        });
        return order;
      });
      // Success request-log line (D3 — mutation route). No PII / no amounts.
      logger.info(
        { method: "PATCH", path: "/api/orders/[id]", status: 200, durationMs: Date.now() - startedAt },
        "order tax requested"
      );
      return NextResponse.json(serializeOrder(updated));
    } catch (err) {
      // Lost the conditional-transition race (FIX 2): a concurrent request-tax
      // already flipped the bill. Return the SAME 409 ALREADY_REQUESTED a
      // sequential second request gets — the tx rolled back, so NO sequence was
      // consumed and NO second SyncJob exists.
      if (err instanceof TaxAlreadyRequestedError) {
        return NextResponse.json(
          {
            error: "บิลนี้ขอใบกำกับภาษีไปแล้ว",
            code: "ALREADY_REQUESTED",
          },
          { status: 409 }
        );
      }
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        return NextResponse.json(
          { error: "Order not found", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      logger.error({ err }, "PATCH /api/orders/[id] request-tax failed");
      return NextResponse.json(
        { error: "Could not request tax invoice", code: "INTERNAL" },
        { status: 500 }
      );
    }
  }

  try {
    const existing = await prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        syncStatus: true,
        total: true,
        // Items drive the stock restore — both refund and void return the sold
        // units to inventory.
        items: { select: { productId: true, quantity: true } },
      },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "Order not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Pre-checks are server-side (the route is open; the client cannot be trusted
    // to gate refund/void by status — risk #1 in the Phase 5 research). The
    // authoritative gate is the CONDITIONAL update inside the transaction below
    // (status === COMPLETED); this early check just returns a friendly message
    // without opening a transaction for an already-terminal bill.
    if (existing.status !== OrderStatus.COMPLETED) {
      return NextResponse.json(
        {
          error:
            action === "refund"
              ? "คืนเงินได้เฉพาะบิลที่ชำระแล้ว"
              : "ยกเลิก (Void) ได้เฉพาะบิลที่ชำระแล้ว",
          code: "INVALID_STATE",
        },
        { status: 409 }
      );
    }

    let updateData: Prisma.OrderUpdateInput;
    if (action === "refund") {
      // accountingDocNo (credit note) is intentionally NOT set here — issued by
      // the Phase 6 accounting layer.
      updateData = { status: OrderStatus.REFUNDED };
    } else {
      // Synced bills are locked from edits (domain-synced-bills-locked): a bill
      // already in KRS must be reversed via a credit note, not voided.
      if (existing.syncStatus === SyncStatus.SYNCED) {
        return NextResponse.json(
          {
            error: "บิลนี้ส่งเข้าบัญชีแล้ว ยกเลิกไม่ได้ — ต้องใช้ใบลดหนี้",
            code: "VOID_SYNCED_LOCKED",
          },
          { status: 409 }
        );
      }
      updateData = {
        status: OrderStatus.VOIDED,
        total: 0,
        tax: 0,
        syncStatus: SyncStatus.SKIPPED,
      };
    }

    // Action-specific conditional WHERE (FIX 3 — void TOCTOU). Refund keeps the
    // plain `status === COMPLETED` guard (it has no SYNCED lock). VOID additionally
    // re-checks `syncStatus !== SYNCED` INSIDE the transaction: the pre-transaction
    // findUnique above only read a snapshot, so a sync job flipping the bill to
    // SYNCED in the race window would otherwise let an already-synced void commit.
    // Folding the lock into the conditional updateMany closes that window atomically.
    const transitionWhere: Prisma.OrderWhereInput =
      action === "void"
        ? {
            id,
            status: OrderStatus.COMPLETED,
            syncStatus: { not: SyncStatus.SYNCED },
          }
        : { id, status: OrderStatus.COMPLETED };

    // ONE transaction: conditional status transition + stock restore. The
    // conditional `updateMany` (count===1 assert) closes the double-fire race (I4):
    // two concurrent refund/void requests can no longer both transition the same
    // bill — the loser matches 0 rows and is rejected, rolling back its (would-be)
    // stock restore. Both refund AND void return the sold units to inventory +
    // write an ADJUST ledger row.
    const updated = await prisma.$transaction(async (tx) => {
      const transition = await tx.order.updateMany({
        where: transitionWhere,
        data: updateData,
      });
      if (transition.count !== 1) {
        // For VOID, a 0-count can mean EITHER the bill is no longer COMPLETED
        // (double-fire) OR it raced to SYNCED in the window. Re-read once to return
        // the precise code: VOID_SYNCED_LOCKED if it is now SYNCED, else
        // INVALID_STATE. Refund only has the INVALID_STATE failure mode.
        if (action === "void") {
          const current = await tx.order.findUnique({
            where: { id },
            select: { syncStatus: true },
          });
          if (current?.syncStatus === SyncStatus.SYNCED) {
            throw new VoidSyncedLockedError();
          }
        }
        throw new OrderStateConflictError();
      }

      for (const item of existing.items) {
        await tx.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
        // Stock restore ledger row: ADJUST with a POSITIVE qty (stock back in),
        // referencing the action so the trail distinguishes refund vs void.
        await tx.stockMovement.create({
          data: {
            productId: item.productId,
            type: StockMovementType.ADJUST,
            qty: item.quantity,
            reference: `${action}:${existing.id}`,
          },
        });
        // TODO(krs-sync-P2): enqueue a STOCK_REVERSAL SyncJob here (idempotencyKey =
        // `${orderNumber}_STOCK_REVERSAL`) once the owner confirms reversal ownership
        // (plan §10 item 12 / §12). If KRS self-reverses on its void document, POS
        // sends NO reversal and this stays a comment. If POS must send a compensating
        // positive InventoryFlow row, the enqueue goes OUTSIDE this $transaction
        // (best-effort — the Postgres stock is already restored; the KRS reversal is
        // async, unlike the checkout outbox which IS in-tx because sale+outbox
        // atomicity is the invariant). Left as a documented gap — not implemented in
        // Track A (no guessed reversal).
      }

      // Re-read with relations for the response (the updateMany returns a count).
      return tx.order.findUniqueOrThrow({
        where: { id },
        include: ORDER_DETAIL_INCLUDE,
      });
    });

    // Money/ledger audit (auth Phase 3). BEST-EFFORT, AFTER the update commits —
    // never inside a transaction, never blocks the response. A void zeroes the
    // order total, so the void audit MUST record the PRE-void amount (captured in
    // `existing.total` above) — otherwise every ORDER_VOIDED row reads total:"0"
    // and the money-reversal trail can't show how much a void actually reversed.
    // Refund does not zero the total, so it correctly logs `updated.total`.
    await logAudit({
      action:
        action === "refund"
          ? AuditAction.ORDER_REFUNDED
          : AuditAction.ORDER_VOIDED,
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      ip: await ipFromHeaders(),
      targetType: "Order",
      targetId: updated.id,
      detail: JSON.stringify({
        orderNumber: updated.orderNumber,
        total:
          action === "refund"
            ? updated.total.toString()
            : existing.total.toString(),
      }),
    });

    // Success request-log line (D3 — mutation route). No PII / no amounts; the
    // action (refund/void) is a small non-PII enum useful for ops triage.
    logger.info(
      { method: "PATCH", path: "/api/orders/[id]", status: 200, action, durationMs: Date.now() - startedAt },
      "order status changed"
    );
    return NextResponse.json(serializeOrder(updated));
  } catch (err) {
    // VOID lost the race to a sync job that flipped the bill to SYNCED inside the
    // transaction window (FIX 3). Report the precise domain-synced-bills-locked 409
    // a sequential request would get — a synced bill must be reversed via a credit
    // note, not voided.
    if (err instanceof VoidSyncedLockedError) {
      return NextResponse.json(
        {
          error: "บิลนี้ส่งเข้าบัญชีแล้ว ยกเลิกไม่ได้ — ต้องใช้ใบลดหนี้",
          code: "VOID_SYNCED_LOCKED",
        },
        { status: 409 }
      );
    }
    // Conditional status transition matched 0 rows — the bill was concurrently
    // refunded/voided (double-fire race, I4). Report the same INVALID_STATE 409 a
    // sequential second request would get.
    if (err instanceof OrderStateConflictError) {
      return NextResponse.json(
        {
          error:
            action === "refund"
              ? "คืนเงินได้เฉพาะบิลที่ชำระแล้ว"
              : "ยกเลิก (Void) ได้เฉพาะบิลที่ชำระแล้ว",
          code: "INVALID_STATE",
        },
        { status: 409 }
      );
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Order not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }
    logger.error({ err }, "PATCH /api/orders/[id] failed");
    return NextResponse.json(
      { error: "Could not update order", code: "INTERNAL" },
      { status: 500 }
    );
  }
  });
}

/**
 * Thrown inside the refund/void transaction when the conditional status
 * transition (`updateMany WHERE status === COMPLETED`) matches 0 rows — i.e. the
 * bill was already transitioned by a concurrent request (double-fire race, I4).
 * Maps to a 409 INVALID_STATE, rolling back the would-be stock restore.
 */
class OrderStateConflictError extends Error {
  constructor() {
    super("Order is no longer COMPLETED");
    this.name = "OrderStateConflictError";
  }
}

/**
 * Thrown inside the VOID transaction when the conditional updateMany matches 0
 * rows AND a re-read shows the bill is now SYNCED (FIX 3 — void TOCTOU): a sync
 * job flipped syncStatus to SYNCED in the race window after the pre-transaction
 * findUnique. Maps to a 409 VOID_SYNCED_LOCKED (domain-synced-bills-locked),
 * rolling back the would-be stock restore.
 */
class VoidSyncedLockedError extends Error {
  constructor() {
    super("Order was synced before the void committed");
    this.name = "VoidSyncedLockedError";
  }
}

/**
 * Thrown inside the request-tax transaction when the conditional taxRequested
 * transition (`updateMany WHERE status === COMPLETED AND taxRequested === false`)
 * matches 0 rows — i.e. a concurrent request-tax already flipped the bill
 * (double-mint race, FIX 2). Maps to a 409 ALREADY_REQUESTED, rolling back the
 * would-be sequence consumption + second SyncJob so no duplicate tax-invoice
 * number is ever issued.
 */
class TaxAlreadyRequestedError extends Error {
  constructor() {
    super("Tax invoice was already requested for this order");
    this.name = "TaxAlreadyRequestedError";
  }
}

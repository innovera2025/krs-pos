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
// krs-void-writeback: voiding a SYNCED bill enqueues a VOID SyncJob whose payload is
// built from the original SALE job's stored snapshot (warehouseCode + items) + its
// response doc numbers. parseSalePayload re-validates that stored snapshot; VoidPayload
// is the outbox contract. Both are pure (no mssql/Prisma), safe to import here.
import { parseSalePayload, type SalePayload } from "@/lib/krs/salePayload";
import { type VoidPayload } from "@/lib/krs/voidPayload";
// The void PATH is decided from the original SALE SyncJob's status (not Order.syncStatus)
// so a still-claimable SALE job can be neutralized in-tx (no orphan KRS write) and a bill
// synced BEFORE the syncStatus flip shipped still routes correctly. LOCK_STALE_MS is the
// dispatch-lock window shared with the dispatcher (imported from a pure const module to
// avoid pulling the mssql-heavy dispatcher into this route's graph).
import { decideVoidSalePath } from "@/lib/krs/voidSaleDecision";
import { LOCK_STALE_MS } from "@/lib/krs/dispatchConstants";

// domain-no-destructive-delete: orders are NEVER deleted — only status
// transitions. There is intentionally NO DELETE handler on this route.
//
// AUTH (auth Phase 2): PER-ACTION RBAC. Any authenticated active session may
// reach this route (requireUser). "request-tax" stays at requireUser (a cashier
// may request a tax invoice). "void" additionally requires an admin (ADMIN/MANAGER)
// — a cashier attempting it gets a 403 FORBIDDEN. ("refund" was removed:
// krs-void-writeback, 19-07-26 owner decision.)
// TODO(production-readiness): a double-fire void is guarded by the conditional
// updateMany (count===1); see the void transaction below.

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

// PATCH /api/orders/[id] — void a sale or request a tax invoice (append-only status
// transitions). ("refund" was removed: krs-void-writeback, 19-07-26 owner decision —
// historical REFUNDED rows keep their badge, but no new refund can be created.)
//
//   { action: "void" }   — requires status COMPLETED (else 409 INVALID_STATE); admin
//     only. Sets status VOIDED, total 0, tax 0 and restores stock. A SYNCED bill is NO
//     LONGER locked (krs-void-writeback supersedes domain-synced-bills-locked). The path
//     is decided from the ORIGINAL SALE SyncJob's STATUS (not Order.syncStatus), all in
//     the void $transaction:
//       - SALE SYNCED           → keep syncStatus SYNCED + enqueue a VOID SyncJob (closes
//                                 the 4 KRS documents). Missing/unparseable SALE payload →
//                                 500 VOID_MISSING_SALE_JOB (whole void rolls back).
//       - no SALE job / SKIPPED → syncStatus SKIPPED, no VOID job (nothing in KRS).
//       - PENDING/RETRYING/FAILED → NEUTRALIZE the SALE job to SKIPPED in-tx so the
//                                 dispatcher can't write an orphan doc later, then the
//                                 SKIPPED path. If a fresh dispatch lock blocks that
//                                 (write mid-flight) → 409 VOID_SALE_IN_FLIGHT (retry).
//       - NEEDS_RECONCILE       → 409 VOID_SALE_IN_FLIGHT (operator must reconcile first).
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
        error: "action must be 'void' or 'request-tax'",
        code: "BAD_ACTION",
      },
      { status: 400 }
    );
  }
  const action = parsed.data.action;

  // AUTH (auth Phase 2): void is an admin-only money/ledger reversal. A cashier may
  // reach "request-tax" but not void — block with 403. (Refund was removed:
  // krs-void-writeback, 19-07-26 owner decision.)
  if (action === "void" && !isAdminRole(session.user.role)) {
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
        // orderNumber + branchId (krs-void-writeback): a synced-bill void builds the
        // VOID SyncJob's ref/idempotencyKey/branchId from these.
        orderNumber: true,
        branchId: true,
        status: true,
        syncStatus: true,
        total: true,
        // Items drive the stock restore — a void returns the sold units to inventory.
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
          error: "ยกเลิก (Void) ได้เฉพาะบิลที่ชำระแล้ว",
          code: "INVALID_STATE",
        },
        { status: 409 }
      );
    }

    // Synced bills are no longer locked from void (krs-void-writeback, 19-07-26 owner
    // decision — supersedes domain-synced-bills-locked). Conditional transition WHERE
    // (FIX 3 double-fire guard): the plain COMPLETED predicate (both synced + unsynced
    // bills are voidable now).
    const transitionWhere: Prisma.OrderWhereInput = { id, status: OrderStatus.COMPLETED };
    // Dispatch-lock staleness threshold, bound as a param (mirrors dispatcher.claimJobs).
    const staleBefore = new Date(Date.now() - LOCK_STALE_MS);

    // ONE transaction. The void PATH is decided from the ORIGINAL SALE SyncJob's STATUS,
    // NOT Order.syncStatus (which is only flipped to SYNCED for post-deploy sales — a bill
    // synced BEFORE that flip shipped still reads PENDING, so the old check wrongly skipped
    // its VOID job). Reading the SALE job's real status also lets us NEUTRALIZE a
    // still-claimable job in the SAME tx so the dispatcher can't write it to KRS ~30s later
    // (orphan ERP doc). See src/lib/krs/voidSaleDecision.ts.
    const updated = await prisma.$transaction(async (tx) => {
      // (1) Read the latest SALE SyncJob (ANY status) for this order + decide the path.
      const saleJob = await tx.syncJob.findFirst({
        where: { type: SyncJobType.SALE, ref: existing.orderNumber },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, lockedAt: true, payload: true, response: true },
      });
      const salePath = decideVoidSalePath(saleJob?.status ?? null);

      // NEEDS_RECONCILE: the SALE has a burned anchor with an unresolved ERP state — never
      // guess whether it wrote. Block the void; an operator must reconcile it first.
      if (salePath === "needs-reconcile") {
        throw new VoidSaleInFlightError(
          "บิลนี้ติดสถานะรอตรวจสอบการส่งบัญชี — แจ้งผู้ดูแลระบบ"
        );
      }

      // (2) NEUTRALIZE a still-claimable SALE job (PENDING/RETRYING/FAILED). The
      // conditional updateMany contends with the dispatcher's claim on the SAME row:
      //   • if we commit SKIPPED first, the claim (which takes only PENDING/RETRYING) can
      //     no longer take it → the sale never reaches KRS.
      //   • if the claim won, it holds a FRESH lockedAt=NOW under FOR UPDATE, which our
      //     `lockedAt null|stale` predicate excludes → count 0 → the write is mid-flight
      //     right now → 409 (a retry after it lands takes the enqueue-void path).
      // No window lets both proceed. Once SKIPPED the job is never claimable again.
      // (A rare double-fire on an unsynced bill also lands here: the second request finds
      // the job already SKIPPED → count 0 → the same 409; on retry the order is VOIDED →
      // INVALID_STATE. Both are safe "couldn't void" 409s.)
      let effectivePath = salePath;
      if (salePath === "neutralize" && saleJob) {
        const skipped = await tx.syncJob.updateMany({
          where: {
            id: saleJob.id,
            status: {
              in: [SyncJobStatus.PENDING, SyncJobStatus.RETRYING, SyncJobStatus.FAILED],
            },
            OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
          },
          data: {
            status: SyncJobStatus.SKIPPED,
            lockedAt: null,
            lastError: "voided at POS before KRS dispatch",
          },
        });
        if (skipped.count === 0) {
          throw new VoidSaleInFlightError(
            "บิลกำลังถูกส่งเข้าระบบบัญชีอยู่ กรุณาลองใหม่ในอีกสักครู่"
          );
        }
        effectivePath = "skip-local"; // neutralized → nothing in KRS to cancel
      }

      // (3) Choose the order update from the resolved path. enqueue-void re-asserts
      // syncStatus=SYNCED (no-op for new bills; corrects a stale PENDING on a pre-deploy
      // synced bill so the order reads truthfully); every other path flips it to SKIPPED.
      const updateData: Prisma.OrderUpdateInput =
        effectivePath === "enqueue-void"
          ? { status: OrderStatus.VOIDED, total: 0, tax: 0, syncStatus: SyncStatus.SYNCED }
          : { status: OrderStatus.VOIDED, total: 0, tax: 0, syncStatus: SyncStatus.SKIPPED };

      // (4) Conditional status transition (double-fire guard). count!==1 → a concurrent
      // void already won → roll back (incl. any SALE-job neutralization above).
      const transition = await tx.order.updateMany({
        where: transitionWhere,
        data: updateData,
      });
      if (transition.count !== 1) {
        // 0-count means the bill is no longer COMPLETED — a concurrent void already won.
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

      // enqueue-void: the SALE reached KRS (status SYNCED) → enqueue the VOID SyncJob IN
      // this same transaction (outbox pattern — the local void + its KRS-cancel intent
      // commit atomically, mirroring how checkout enqueues the SALE job in-tx). The
      // payload is built from the ORIGINAL SALE job's stored snapshot (warehouseCode +
      // items) + its response doc numbers (saleRef), NOT from live Product rows — the
      // sku/warehouse the sale actually cut is authoritative and immutable. `saleJob` was
      // already read at step (1); enqueue-void guarantees it is non-null + SYNCED.
      if (effectivePath === "enqueue-void") {
        if (!saleJob) {
          throw new VoidMissingSaleJobError();
        }
        let saleSnapshot: SalePayload;
        try {
          saleSnapshot = parseSalePayload(saleJob.payload);
        } catch {
          throw new VoidMissingSaleJobError();
        }
        // saleRef is a BEST-EFFORT recovery from the SALE job's stored response JSON
        // (a crash-recovered SALE may have only {transactionNo,recovered:true}). It is
        // the FALLBACK — cancelSale.ts's PosBillNo lookup is primary — so a missing /
        // unparseable response just leaves saleRef empty, never fails the void.
        let saleRef: VoidPayload["saleRef"] = {};
        if (typeof saleJob.response === "string") {
          try {
            const r = JSON.parse(saleJob.response) as Record<string, unknown>;
            saleRef = {
              transactionNo: typeof r.transactionNo === "string" ? r.transactionNo : undefined,
              saleVoucherNo: typeof r.saleVoucherNo === "string" ? r.saleVoucherNo : undefined,
              flowTxnNo: typeof r.flowTxnNo === "string" ? r.flowTxnNo : undefined,
              flowVoucherNo: typeof r.flowVoucherNo === "string" ? r.flowVoucherNo : undefined,
            };
          } catch {
            /* leave saleRef empty — the PosBillNo lookup in cancelSale.ts is primary anyway */
          }
        }
        const voidPayload: VoidPayload = {
          orderNumber: existing.orderNumber,
          warehouseCode: saleSnapshot.warehouseCode,
          requestedBy: session.user.name ?? session.user.email ?? "",
          requestedAt: new Date().toISOString(),
          items: saleSnapshot.items.map((it) => ({ itemCode: it.itemCode, qty: it.quantity })),
          saleRef,
        };
        await tx.syncJob.create({
          data: {
            type: SyncJobType.VOID,
            direction: SyncDirection.INSERT,
            ref: existing.orderNumber,
            // Pre-void total — the value being cancelled (existing.total was captured
            // BEFORE the updateMany zeroed the order's total above).
            amount: existing.total,
            status: SyncJobStatus.PENDING,
            provider: "KRS",
            idempotencyKey: `${existing.orderNumber}_VOID`,
            payload: voidPayload as unknown as Prisma.InputJsonValue,
            attempts: 0,
            branchId: existing.branchId,
          },
        });
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
    await logAudit({
      action: AuditAction.ORDER_VOIDED,
      actorId: session.user.id,
      actorEmail: session.user.email ?? null,
      ip: await ipFromHeaders(),
      targetType: "Order",
      targetId: updated.id,
      detail: JSON.stringify({
        orderNumber: updated.orderNumber,
        total: existing.total.toString(), // pre-void amount (void always zeroes total)
      }),
    });

    // Success request-log line (D3 — mutation route). No PII / no amounts; the
    // action (void) is a small non-PII enum useful for ops triage.
    logger.info(
      { method: "PATCH", path: "/api/orders/[id]", status: 200, action, durationMs: Date.now() - startedAt },
      "order status changed"
    );
    return NextResponse.json(serializeOrder(updated));
  } catch (err) {
    // krs-void-writeback: the SALE job is mid-dispatch (a fresh lock blocked our in-tx
    // neutralize) or NEEDS_RECONCILE — either way the void cannot safely proceed yet.
    // 409 VOID_SALE_IN_FLIGHT; the case-specific Thai copy rides on the error. The whole
    // void rolled back (bill stays COMPLETED, stock untouched, SALE job untouched).
    if (err instanceof VoidSaleInFlightError) {
      return NextResponse.json(
        { error: err.userMessage, code: "VOID_SALE_IN_FLIGHT" },
        { status: 409 }
      );
    }
    // krs-void-writeback: the bill was SYNCED but no matching SYNCED SALE SyncJob could
    // be found/parsed to build the cancel payload (a genuine data-integrity anomaly —
    // a pre-outbox order, or a corrupted/missing SyncJob row). Fail loudly with a 500
    // and roll back the WHOLE void (bill stays COMPLETED, stock untouched) rather than
    // guess at KRS document numbers or silently skip the KRS-side cancel.
    if (err instanceof VoidMissingSaleJobError) {
      logger.error({ err, orderId: id }, "PATCH /api/orders/[id] void: no matching SALE SyncJob");
      return NextResponse.json(
        {
          error: "ไม่พบข้อมูลการซิงค์เดิมของบิลนี้ · Original KRS sync record not found",
          code: "VOID_MISSING_SALE_JOB",
        },
        { status: 500 }
      );
    }
    // Conditional status transition matched 0 rows — the bill was concurrently voided
    // (double-fire race, I4). Report the same INVALID_STATE 409 a sequential second
    // request would get.
    if (err instanceof OrderStateConflictError) {
      return NextResponse.json(
        {
          error: "ยกเลิก (Void) ได้เฉพาะบิลที่ชำระแล้ว",
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
 * Thrown inside the void transaction when the conditional status transition
 * (`updateMany WHERE status === COMPLETED`) matches 0 rows — i.e. the bill was
 * already transitioned by a concurrent request (double-fire race, I4). Maps to a
 * 409 INVALID_STATE, rolling back the would-be stock restore.
 */
class OrderStateConflictError extends Error {
  constructor() {
    super("Order is no longer COMPLETED");
    this.name = "OrderStateConflictError";
  }
}

/**
 * Thrown inside the VOID transaction when the bill's syncStatus is SYNCED but no
 * matching SALE SyncJob (status SYNCED) can be found/parsed to build the cancel
 * payload from (krs-void-writeback). A genuine data-integrity anomaly (a
 * pre-outbox-migration order, or a corrupted/missing SyncJob row) — fail loudly
 * (500 VOID_MISSING_SALE_JOB) and roll back the whole void rather than guess at KRS
 * document numbers or silently skip the KRS-side cancel.
 */
class VoidMissingSaleJobError extends Error {
  constructor() {
    super("No matching SYNCED SALE SyncJob found for this order");
    this.name = "VoidMissingSaleJobError";
  }
}

/**
 * Thrown inside the VOID transaction when the original SALE SyncJob cannot be safely
 * settled before voiding (krs-void-writeback): either it is NEEDS_RECONCILE (a burned
 * anchor with an ambiguous ERP state — an operator must resolve it first) or it is being
 * dispatched RIGHT NOW (a fresh dispatch lock blocked our neutralize updateMany, so the
 * KRS write is mid-flight). Both map to a 409 VOID_SALE_IN_FLIGHT; `userMessage` carries
 * the case-specific Thai copy. A retry after the write lands takes the correct path.
 */
class VoidSaleInFlightError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super("SALE SyncJob is in-flight or needs reconciliation; void cannot proceed");
    this.name = "VoidSaleInFlightError";
    this.userMessage = userMessage;
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

import { NextResponse } from "next/server";
import {
  Prisma,
  OrderStatus,
  SyncStatus,
  SyncJobType,
  SyncDirection,
  SyncJobStatus,
  AuditAction,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { isAdminRole } from "@/lib/authRole";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";

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
//   { action: "request-tax" } (Phase 6a) — requires status COMPLETED (else 409
//     INVALID_STATE; a REFUNDED/VOIDED bill must not enqueue a tax invoice) AND
//     the order to have a customerId whose Customer has a non-empty taxId (else
//     422 TAX_REQUIRES_TAX_CUSTOMER, domain-tax-invoice-requires-tax-customer).
//     In one $transaction it sets order.taxRequested = true and creates a PENDING
//     TAX_INVOICE SyncJob (direction INSERT, ref = orderNumber, amount = total).
//     accountingDocNo is NOT issued now — it returns async on a future KRS sync.
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
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

  const action = body.action;
  if (action !== "refund" && action !== "void" && action !== "request-tax") {
    return NextResponse.json(
      {
        error: "action must be 'refund', 'void', or 'request-tax'",
        code: "BAD_ACTION",
      },
      { status: 400 }
    );
  }

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
          customer: { select: { id: true, taxId: true } },
        },
      });
      if (!existing) {
        return NextResponse.json(
          { error: "Order not found", code: "NOT_FOUND" },
          { status: 404 }
        );
      }

      // Only a COMPLETED bill can request a tax invoice — a refunded/voided bill
      // retains its customerId but must not enqueue a TAX_INVOICE SyncJob.
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

      // One transaction: flag the order + enqueue a PENDING TAX_INVOICE SyncJob.
      // accountingDocNo is intentionally left untouched — it is issued async on a
      // future KRS sync (production-readiness / 6b).
      const updated = await prisma.$transaction(async (tx) => {
        const order = await tx.order.update({
          where: { id },
          data: { taxRequested: true },
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
      return NextResponse.json(updated);
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        return NextResponse.json(
          { error: "Order not found", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      console.error("PATCH /api/orders/[id] request-tax failed:", err);
      return NextResponse.json(
        { error: "Could not request tax invoice", code: "INTERNAL" },
        { status: 500 }
      );
    }
  }

  try {
    const existing = await prisma.order.findUnique({
      where: { id },
      select: { id: true, status: true, syncStatus: true, total: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "Order not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Pre-checks are server-side (the route is open; the client cannot be trusted
    // to gate refund/void by status — risk #1 in the Phase 5 research).
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

    const updated = await prisma.order.update({
      where: { id },
      data: updateData,
      include: ORDER_DETAIL_INCLUDE,
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

    return NextResponse.json(updated);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Order not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }
    console.error("PATCH /api/orders/[id] failed:", err);
    return NextResponse.json(
      { error: "Could not update order", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

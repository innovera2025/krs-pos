import { NextResponse } from "next/server";
import { Prisma, OrderStatus, SyncStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// domain-no-destructive-delete: orders are NEVER deleted — only status
// transitions. There is intentionally NO DELETE handler on this route.
// TODO(production-readiness): auth + audit (who/when) + idempotency. The route is
// currently open (no session) and a double-fire refund/void is not idempotent.

const ORDER_DETAIL_INCLUDE = {
  items: { include: { product: true } },
  payments: true,
  cashier: { select: { id: true, name: true } },
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
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
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
  if (action !== "refund" && action !== "void") {
    return NextResponse.json(
      { error: "action must be 'refund' or 'void'", code: "BAD_ACTION" },
      { status: 400 }
    );
  }

  try {
    const existing = await prisma.order.findUnique({
      where: { id },
      select: { id: true, status: true, syncStatus: true },
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

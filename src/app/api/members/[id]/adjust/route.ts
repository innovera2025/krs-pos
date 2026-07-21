import { NextResponse } from "next/server";
import { Prisma, PointsTxType, AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { MemberAdjustBodySchema } from "@/lib/schemas/member";
import { parseBody } from "@/lib/schemas/_shared";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * POST /api/members/[id]/adjust — a MANUAL admin points correction (loyalty program,
 * Phase 1B). SENSITIVE (money-adjacent), so `requireAdmin` (ADMIN/MANAGER) — a plain
 * CASHIER is 403. Body: `{ points: signed non-zero int, note?: string }` validated by
 * MemberAdjustBodySchema at the parse boundary.
 *
 * ATOMIC OVERDRAW GUARD (the same shape as the stock decrement `updateMany WHERE stock
 * >= qty`): the delta is applied with a conditional `updateMany`. For a NEGATIVE delta
 * the WHERE additionally requires `pointsBalance >= -points`, so a debit that would
 * drive the balance below 0 matches 0 rows and never applies — points can never go
 * negative. `isMember: true` is always in the WHERE so a non-member / unknown id also
 * matches 0 rows. `count !== 1` therefore means EITHER an overdraw OR a missing member;
 * the two are disambiguated (an in-tx member existence probe) and mapped to 422
 * POINTS_INSUFFICIENT vs 404 NOT_FOUND. Everything runs in ONE `$transaction`: the
 * balance mutation, the read-back, and the ledger `PointsTransaction` insert commit
 * together (or all roll back), so `Customer.pointsBalance` and the ledger can never
 * diverge.
 *
 * The `logAudit(POINTS_ADJUSTED)` is best-effort and POST-COMMIT (never inside the
 * transaction) per the auditLog contract.
 */

/** Typed transaction abort so the outer catch can map it to the right HTTP status. */
type AdjustFailCode = "POINTS_INSUFFICIENT" | "NOT_FOUND";
class AdjustError extends Error {
  constructor(public readonly failCode: AdjustFailCode) {
    super(failCode);
    this.name = "AdjustError";
  }
}

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    const { id } = params;
    if (typeof id !== "string" || id.length === 0) {
      return NextResponse.json(
        { error: "Missing member id", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    const parsed = parseBody(MemberAdjustBodySchema, raw);
    if ("response" in parsed) return parsed.response;
    const { points, note } = parsed.data;

    try {
      const result = await prisma.$transaction(async (tx) => {
        // Atomic conditional apply. NEGATIVE delta → require sufficient balance so the
        // result can never dip below 0 (overdraw guard, stock-decrement pattern).
        const applied = await tx.customer.updateMany({
          where: {
            id,
            isMember: true,
            ...(points < 0 ? { pointsBalance: { gte: -points } } : {}),
          },
          data: { pointsBalance: { increment: points } },
        });

        if (applied.count !== 1) {
          // 0 rows matched. For a debit it could be an overdraw OR a missing member —
          // probe membership to disambiguate. For a credit (no balance predicate) the
          // only cause is a missing / non-member id.
          if (points < 0) {
            const member = await tx.customer.findFirst({
              where: { id, isMember: true },
              select: { id: true },
            });
            throw new AdjustError(member ? "POINTS_INSUFFICIENT" : "NOT_FOUND");
          }
          throw new AdjustError("NOT_FOUND");
        }

        // Read the post-increment balance back (exists — the update just matched it).
        const updated = await tx.customer.findUniqueOrThrow({
          where: { id },
          select: { pointsBalance: true },
        });

        const ledgerRow = await tx.pointsTransaction.create({
          data: {
            customerId: id,
            type: PointsTxType.ADJUST,
            points,
            balanceAfter: updated.pointsBalance,
            note,
            actorId: gate.session.user.id,
          },
          select: {
            id: true,
            type: true,
            points: true,
            balanceAfter: true,
            note: true,
            createdAt: true,
            orderId: true,
          },
        });

        return { balanceAfter: updated.pointsBalance, ledgerRow };
      });

      // Best-effort audit AFTER commit (never inside the tx). Records the actor + the
      // signed delta and note — a manual points correction is a security-relevant event.
      await logAudit({
        action: AuditAction.POINTS_ADJUSTED,
        actorId: gate.session.user.id,
        actorEmail: gate.session.user.email ?? null,
        ip: await ipFromHeaders(),
        targetType: "Customer",
        targetId: id,
        detail: JSON.stringify({ points, note }),
      });

      return NextResponse.json({
        id,
        pointsBalance: result.balanceAfter,
        transaction: result.ledgerRow,
      });
    } catch (err) {
      if (err instanceof AdjustError) {
        if (err.failCode === "POINTS_INSUFFICIENT") {
          return NextResponse.json(
            { error: "แต้มคงเหลือไม่พอสำหรับการปรับลด", code: "POINTS_INSUFFICIENT" },
            { status: 422 }
          );
        }
        return NextResponse.json(
          { error: "ไม่พบสมาชิก", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      // Row vanished between match and read-back (defensive; no hard DELETE exists).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        return NextResponse.json(
          { error: "ไม่พบสมาชิก", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      logger.error({ err }, "POST /api/members/[id]/adjust failed");
      return NextResponse.json(
        { error: "ไม่สามารถปรับแต้มได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

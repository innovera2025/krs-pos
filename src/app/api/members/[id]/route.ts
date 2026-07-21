import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * GET /api/members/[id] — one member's detail + recent points ledger (loyalty
 * program, Phase 1B — the /members ledger drawer). Returns the member header (the
 * same fields the list carries) plus the latest ~50 PointsTransaction rows,
 * newest-first, served by the @@index([customerId, createdAt]) composite.
 *
 * AUTH: `requireUser` — any signed-in role may read a member's ledger (viewing is
 * all-roles; only the manual adjust is ADMIN-gated). 404 NOT_FOUND when the id is
 * unknown OR the customer is not a member (a plain tax customer has no ledger here).
 *
 * NO Decimal fields: `points` / `balanceAfter` are plain Ints and `pointsBalance` an
 * Int, so the payload needs no money serializer.
 */

/** Newest-first ledger page size for the drawer. */
const LEDGER_TAKE = 50;

const MEMBER_SELECT = {
  id: true,
  name: true,
  phone: true,
  pointsBalance: true,
  memberSince: true,
  isMember: true,
} satisfies Prisma.CustomerSelect;

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    const { id } = params;
    if (typeof id !== "string" || id.length === 0) {
      return NextResponse.json(
        { error: "Missing member id", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    try {
      const member = await prisma.customer.findFirst({
        where: { id, isMember: true },
        select: MEMBER_SELECT,
      });
      if (!member) {
        return NextResponse.json(
          { error: "ไม่พบสมาชิก", code: "NOT_FOUND" },
          { status: 404 }
        );
      }

      const ledger = await prisma.pointsTransaction.findMany({
        where: { customerId: id },
        orderBy: { createdAt: "desc" },
        take: LEDGER_TAKE,
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

      return NextResponse.json({ member, ledger });
    } catch (err) {
      logger.error({ err }, "GET /api/members/[id] failed");
      return NextResponse.json(
        { error: "ไม่สามารถโหลดข้อมูลสมาชิกได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

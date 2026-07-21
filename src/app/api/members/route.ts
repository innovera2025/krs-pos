import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * GET /api/members — loyalty members list for the /members management screen
 * (loyalty program, Phase 1B). MEMBER-SCOPED: only `Customer WHERE isMember = true`
 * rows (a plain tax customer is not a member). Optional `?q=` does a case-insensitive
 * substring match on name OR phone (the member key) — the same shape as the customer
 * picker search, narrowed to members.
 *
 * AUTH: `requireUser` — every signed-in role (CASHIER/MANAGER/ADMIN) may VIEW members
 * (enrollment already happens at POS for any role); the MANUAL points adjust is the
 * only ADMIN-gated action (POST /api/members/[id]/adjust). The response carries member
 * PII (name/phone) so it must not be anonymous.
 *
 * ORDER: by `pointsBalance` DESC (highest-balance members first — the operator's most
 * common lookup), then `name` ASC as a deterministic tie-break. `take: 200` caps the
 * page (client-side search narrows further). NO Decimal fields — `pointsBalance` is a
 * plain Int and `memberSince` a Date, so the payload needs no money serializer.
 */

// This route reads request searchParams, so it is inherently dynamic. Declaring it
// explicitly silences the benign DYNAMIC_SERVER_USAGE build log.
export const dynamic = "force-dynamic";

const MEMBER_LIST_SELECT = {
  id: true,
  name: true,
  phone: true,
  pointsBalance: true,
  memberSince: true,
  isMember: true,
} satisfies Prisma.CustomerSelect;

export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    try {
      const { searchParams } = new URL(req.url);
      // Length cap: silently truncate an over-long search term to 200 chars so an
      // arbitrarily long ILIKE pattern is never sent to Postgres (customers-route
      // convention).
      const q = (searchParams.get("q") ?? "").trim().slice(0, 200);

      const where: Prisma.CustomerWhereInput = {
        isMember: true,
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: "insensitive" } },
                { phone: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      };

      const members = await prisma.customer.findMany({
        where,
        select: MEMBER_LIST_SELECT,
        orderBy: [{ pointsBalance: "desc" }, { name: "asc" }],
        take: 200,
      });
      return NextResponse.json(members);
    } catch (err) {
      logger.error({ err }, "GET /api/members failed");
      return NextResponse.json(
        { error: "ไม่สามารถโหลดรายชื่อสมาชิกได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

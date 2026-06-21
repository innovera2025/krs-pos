import { NextResponse } from "next/server";
import { AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { AuditActorIdSchema } from "@/lib/schemas/auditLog";

// AUTH (auth Phase 3): the audit trail is admin-only (ADMIN/MANAGER). The
// per-handler `requireAdmin` check is the real authorization boundary.

/** Max rows returned per request (newest first). */
const PAGE_SIZE = 100;

function isAuditAction(v: string): v is AuditAction {
  return (Object.values(AuditAction) as string[]).includes(v);
}

// GET /api/audit-logs — list the most recent audit rows (newest first).
// Optional filters: ?action=<AuditAction> and/or ?actorId=<id>. Admin-only.
export async function GET(req: Request) {
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;

  const { searchParams } = new URL(req.url);

  // Validate the action filter at the boundary — an unknown enum value is a 400
  // rather than a silently-ignored filter.
  const actionParam = searchParams.get("action");
  let actionFilter: AuditAction | undefined;
  if (actionParam !== null) {
    if (!isAuditAction(actionParam)) {
      return NextResponse.json(
        { error: "Unknown audit action", code: "BAD_ACTION" },
        { status: 400 }
      );
    }
    actionFilter = actionParam;
  }

  // Validate the actorId filter at the boundary — a CUID is ≤ 40 chars; reject a
  // longer value (→ 400 BAD_ACTOR_ID) rather than passing an unbounded string into
  // the equality filter (theme #3). An absent/empty param means "no filter".
  const actorIdParam = searchParams.get("actorId");
  let actorIdFilter: string | undefined;
  if (actorIdParam !== null && actorIdParam.length > 0) {
    if (!AuditActorIdSchema.safeParse(actorIdParam).success) {
      return NextResponse.json(
        { error: "actorId ไม่ถูกต้อง", code: "BAD_ACTOR_ID" },
        { status: 400 }
      );
    }
    actorIdFilter = actorIdParam;
  }

  try {
    const logs = await prisma.auditLog.findMany({
      where: {
        ...(actionFilter ? { action: actionFilter } : {}),
        ...(actorIdFilter ? { actorId: actorIdFilter } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
    });
    return NextResponse.json(logs);
  } catch (err) {
    console.error("GET /api/audit-logs failed:", err);
    return NextResponse.json(
      { error: "Could not list audit logs", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

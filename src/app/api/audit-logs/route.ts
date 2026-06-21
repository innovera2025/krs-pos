import { NextResponse } from "next/server";
import { AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

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

  const actorIdParam = searchParams.get("actorId");
  const actorIdFilter =
    actorIdParam && actorIdParam.length > 0 ? actorIdParam : undefined;

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

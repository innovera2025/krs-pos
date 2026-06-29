import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// DELETE /api/held-bills/[id] — discard (or consume-on-resume) a parked bill (พักบิล).
//
// AUTH: requireUser — mirrors the collection route.
//
// SOFT-DELETE (least-privilege): the app DB role `krs_app` holds only SELECT/INSERT/UPDATE
// — NOT DELETE (deliberate; db/init/01-app-role.sh) — so a real `prisma.heldBill.delete()`
// fails with Postgres 42501. Instead this stamps `resolvedAt` via a single atomic
// `updateMany` that ALSO enforces ownership (createdById) and the not-yet-consumed guard
// (resolvedAt: null) in one statement:
//   count === 1 → this caller claimed the bill (resume) / discarded it.
//   count === 0 → already consumed by a prior resume OR not this cashier's bill → 404
//                 (never reveal another cashier's held bill; the per-cashier scope is
//                 enforced here, not just at list time).
//
// This is the atomic claim the POS calls FIRST on resume (claim, then rebuild the cart)
// so two terminals can't resume the same parked bill twice — the second DELETE 404s.
// The HTTP method stays DELETE; the client still branches on ok/404 (no client change).
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } }
) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;
    const { session } = gate;

    const { id } = params;
    if (typeof id !== "string" || id.length === 0) {
      return NextResponse.json(
        { error: "Missing held-bill id", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    try {
      // Atomic soft-delete claim: ownership (createdById) + not-yet-consumed (resolvedAt:
      // null) are enforced in the SAME UPDATE. A row that does not exist, belongs to another
      // cashier, or was already resolved matches nothing → count === 0 → 404 (don't reveal
      // others' bills). Only the owner's still-active bill is claimed (count === 1).
      const result = await prisma.heldBill.updateMany({
        where: { id, createdById: session.user.id, resolvedAt: null },
        data: { resolvedAt: new Date() },
      });
      if (result.count === 0) {
        return NextResponse.json(
          { error: "Held bill not found", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "DELETE /api/held-bills/[id] failed");
      return NextResponse.json(
        { error: "Could not delete held bill", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

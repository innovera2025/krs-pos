import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// DELETE /api/held-bills/[id] — discard (or consume-on-resume) a parked bill (พักบิล).
//
// AUTH: requireUser — mirrors the collection route. The bill is fetched first and a
// row that does not exist OR belongs to a DIFFERENT cashier both map to 404 NOT_FOUND
// (never reveal another cashier's held bill — the per-cashier scope is enforced here,
// not just at list time). Only the owner's bill is deleted.
//
// This is the atomic claim the POS calls FIRST on resume (delete, then rebuild the cart)
// so two terminals can't resume the same parked bill twice — the second DELETE 404s.
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
      const bill = await prisma.heldBill.findUnique({
        where: { id },
        select: { id: true, createdById: true },
      });
      // Not found OR owned by another cashier → 404 (don't reveal others' bills).
      if (!bill || bill.createdById !== session.user.id) {
        return NextResponse.json(
          { error: "Held bill not found", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      await prisma.heldBill.delete({ where: { id } });
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

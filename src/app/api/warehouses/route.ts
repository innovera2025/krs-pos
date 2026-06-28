import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// GET /api/warehouses — list the POS warehouse master (Branch/Warehouse Phase 1).
//
// AUTH (auth Phase 2): requires an authenticated session (requireUser, NOT
// requireAdmin). The Phase-2 user picker (create/edit a user's warehouse) needs
// this list, and admin-gating the create/edit forms happens at those routes — this
// read is the same low-sensitivity master-data shape as GET /api/products.
//
// Returns the warehouses ordered by warehouseCode asc so the picker renders a
// stable WH01..WH04 order. The shape is the full row (warehouseCode, warehouseName,
// branchCode, createdAt, updatedAt) — all plain JSON-safe scalars.
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    try {
      const warehouses = await prisma.warehouse.findMany({
        orderBy: { warehouseCode: "asc" },
      });
      return NextResponse.json(warehouses);
    } catch (err) {
      logger.error({ err }, "GET /api/warehouses failed");
      return NextResponse.json(
        { error: "Could not load warehouses", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

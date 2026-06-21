import { NextResponse } from "next/server";
import { Prisma, StockMovementType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
// WRAP-style Zod (D1): validate the body SHAPE. This route is already hardened — the
// existing manual guards (BAD_QTY integer/positive/Int4, BAD_REFERENCE ≤ 200, P2025)
// are kept and run AFTER the parse. Zod just rejects a structurally wrong body early.
import { StockMovementPostBodySchema } from "@/lib/schemas/stockMovement";
import { parseBody } from "@/lib/schemas/_shared";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// AUTH (auth Phase 2): admin-only — receiving stock (GRN) is an inventory action
// reserved for an authenticated admin (ADMIN/MANAGER).

type ReceiveStockBody = {
  productId?: unknown;
  qty?: unknown;
  reference?: unknown;
};

// POST /api/stock-movements — receive stock (GRN). Increments Product.stock by
// qty AND records a RECEIVE StockMovement, atomically in one $transaction.
export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
  // Start time for the success request-log line (D3 — mutation route).
  const startedAt = Date.now();
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // WRAP shape validation (structurally wrong body → 400 VALIDATION). The manual
  // domain guards below still own the precise codes (BAD_PRODUCT / BAD_QTY /
  // BAD_REFERENCE) and the Int4/integer/positive checks the client already handles.
  const parsed = parseBody(StockMovementPostBodySchema, raw);
  if ("response" in parsed) return parsed.response;
  const body: ReceiveStockBody = parsed.data;

  // --- input boundary validation ---
  const productId = typeof body.productId === "string" ? body.productId : "";
  if (productId.length === 0) {
    return NextResponse.json(
      { error: "Missing productId", code: "BAD_PRODUCT" },
      { status: 400 }
    );
  }

  // The 2,147,483,647 cap matches the Postgres Int4 column so an oversized qty
  // returns 400 instead of overflowing to a 500.
  const qty = Number(body.qty);
  if (!Number.isInteger(qty) || qty <= 0 || qty > 2_147_483_647) {
    return NextResponse.json(
      { error: "จำนวนรับเข้าต้องเป็นจำนวนเต็มบวก", code: "BAD_QTY" },
      { status: 400 }
    );
  }

  const reference =
    typeof body.reference === "string" && body.reference.trim().length > 0
      ? body.reference.trim()
      : null;
  if (reference !== null && reference.length > 200) {
    return NextResponse.json(
      { error: "เลขอ้างอิงยาวเกินไป", code: "BAD_REFERENCE" },
      { status: 400 }
    );
  }

  try {
    // Atomic: bump stock + log the movement together.
    // TODO(production-readiness): concurrency-safe increment + audit trail are
    // owned by the production-readiness program.
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.update({
        where: { id: productId },
        data: { stock: { increment: qty } },
        include: { category: true },
      });
      const movement = await tx.stockMovement.create({
        data: {
          productId,
          type: StockMovementType.RECEIVE,
          qty,
          reference,
          branchId: product.branchId,
        },
      });
      return { product, movement };
    });

    // Success request-log line (D3 — mutation route). No PII; status + duration.
    logger.info(
      { method: "POST", path: "/api/stock-movements", status: 201, durationMs: Date.now() - startedAt },
      "stock received"
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // Unknown product (the update targets a missing row).
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Product not found", code: "PRODUCT_NOT_FOUND" },
        { status: 404 }
      );
    }
    logger.error({ err }, "POST /api/stock-movements failed");
    return NextResponse.json(
      { error: "Could not receive stock", code: "INTERNAL" },
      { status: 500 }
    );
  }
  });
}

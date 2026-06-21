import { NextResponse } from "next/server";
import { Prisma, StockMovementType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

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
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;

  let body: ReceiveStockBody;
  try {
    body = (await req.json()) as ReceiveStockBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

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
    console.error("POST /api/stock-movements failed:", err);
    return NextResponse.json(
      { error: "Could not receive stock", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

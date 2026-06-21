import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, requireAdmin } from "@/lib/auth";

// GET /api/products  — list active products
//
// AUTH (auth Phase 2): requires an authenticated session (requireUser, NOT
// requireAdmin). Cashiers need the product grid to ring up sales at /pos, so
// over-gating this to admin would break the seller flow.
export async function GET() {
  const gate = await requireUser();
  if ("response" in gate) return gate.response;

  const products = await prisma.product.findMany({
    where: { isActive: true },
    include: { category: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json(products);
}

// POST /api/products — create a product
//
// AUTH (auth Phase 2): admin-only (products management is an admin nav area).
export async function POST(req: Request) {
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;

  const body = await req.json();
  const { name, sku, price, stock, barcode, categoryId } = body;

  if (!name || !sku || price == null) {
    return NextResponse.json(
      { error: "name, sku, and price are required" },
      { status: 400 }
    );
  }

  const product = await prisma.product.create({
    data: {
      name,
      sku,
      price,
      stock: stock ?? 0,
      barcode: barcode || null,
      categoryId: categoryId || null,
    },
  });

  return NextResponse.json(product, { status: 201 });
}

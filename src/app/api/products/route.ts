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

  let body: {
    name?: unknown;
    sku?: unknown;
    price?: unknown;
    stock?: unknown;
    barcode?: unknown;
    categoryId?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }
  const { name, sku, price, stock, barcode, categoryId } = body;

  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    typeof sku !== "string" ||
    sku.trim().length === 0 ||
    price == null
  ) {
    return NextResponse.json(
      { error: "name, sku, and price are required", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // Price must be a non-negative, finite amount (a negative price would let a
  // sale add money to the customer). It fits Decimal(10,2): max 99,999,999.99.
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum < 0 || priceNum > 99_999_999.99) {
    return NextResponse.json(
      { error: "price must be a non-negative amount", code: "BAD_PRICE" },
      { status: 400 }
    );
  }

  // Stock (when provided) must be a non-negative integer within the Int4 cap —
  // a fractional or negative opening stock is invalid inventory.
  let stockValue = 0;
  if (stock !== undefined && stock !== null) {
    const stockNum = Number(stock);
    if (
      !Number.isFinite(stockNum) ||
      !Number.isInteger(stockNum) ||
      stockNum < 0 ||
      stockNum > 2_147_483_647
    ) {
      return NextResponse.json(
        { error: "stock must be a non-negative integer", code: "BAD_STOCK" },
        { status: 400 }
      );
    }
    stockValue = stockNum;
  }

  const product = await prisma.product.create({
    data: {
      name: name.trim(),
      sku: sku.trim(),
      price: priceNum,
      stock: stockValue,
      barcode:
        typeof barcode === "string" && barcode.trim().length > 0
          ? barcode.trim()
          : null,
      categoryId:
        typeof categoryId === "string" && categoryId.trim().length > 0
          ? categoryId.trim()
          : null,
    },
  });

  return NextResponse.json(product, { status: 201 });
}

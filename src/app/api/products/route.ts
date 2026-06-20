import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/products  — list active products
export async function GET() {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    include: { category: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json(products);
}

// POST /api/products — create a product
export async function POST(req: Request) {
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

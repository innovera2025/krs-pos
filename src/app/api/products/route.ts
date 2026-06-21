import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser, requireAdmin } from "@/lib/auth";
import { ProductPostBodySchema } from "@/lib/schemas/product";
import { parseBody } from "@/lib/schemas/_shared";

// GET /api/products  — list active products
//
// AUTH (auth Phase 2): requires an authenticated session (requireUser, NOT
// requireAdmin). Cashiers need the product grid to ring up sales at /pos, so
// over-gating this to admin would break the seller flow.
export async function GET() {
  const gate = await requireUser();
  if ("response" in gate) return gate.response;

  try {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      include: { category: true },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(products);
  } catch (err) {
    console.error("GET /api/products failed:", err);
    return NextResponse.json(
      { error: "Could not load products", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

// POST /api/products — create a product
//
// AUTH (auth Phase 2): admin-only (products management is an admin nav area).
//
// Validation (production-readiness Phase 1, theme #3): the body is validated by
// ProductPostBodySchema at the parse boundary — strict-number `price` (no Number()
// coercion: "50"/[50] no longer pass), length caps (name ≤ 200, sku ≤ 100, barcode
// ≤ 64) consistent with the PATCH route, and trimmed/nulled barcode + categoryId.
// The categoryId existence pre-check (→ 400 CATEGORY_NOT_FOUND) mirrors PATCH, and
// a duplicate sku/barcode (P2002) maps to a typed 409 instead of a raw 500.
export async function POST(req: Request) {
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

  const parsed = parseBody(ProductPostBodySchema, raw);
  if ("response" in parsed) return parsed.response;
  const { name, sku, price, stock, barcode, categoryId } = parsed.data;

  // Verify the category exists up-front (mirrors PATCH). Otherwise a connect to a
  // missing id throws P2025, which the create catch would misreport as INTERNAL.
  // Wrapped so a DB failure on this pre-check returns the route's sanitized INTERNAL
  // 500 (matching the create catch) instead of a raw framework 500.
  if (categoryId !== null) {
    try {
      const cat = await prisma.category.findUnique({ where: { id: categoryId } });
      if (!cat) {
        return NextResponse.json(
          { error: "ไม่พบหมวดหมู่", code: "CATEGORY_NOT_FOUND" },
          { status: 400 }
        );
      }
    } catch (err) {
      console.error("POST /api/products category pre-check failed:", err);
      return NextResponse.json(
        { error: "Could not create product", code: "INTERNAL" },
        { status: 500 }
      );
    }
  }

  try {
    const product = await prisma.product.create({
      data: {
        name,
        sku,
        price,
        stock: stock ?? 0,
        barcode,
        categoryId,
      },
    });
    return NextResponse.json(product, { status: 201 });
  } catch (err) {
    // Unique-constraint (duplicate sku or barcode) → typed 409. Inspect the
    // violated index so the message names the right field.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const target = err.meta?.target;
      const tokens = Array.isArray(target)
        ? target.map((t) => String(t))
        : typeof target === "string"
          ? [target]
          : [];
      if (tokens.some((t) => t.includes("barcode"))) {
        return NextResponse.json(
          { error: "บาร์โค้ดนี้ถูกใช้งานแล้ว", code: "BARCODE_TAKEN" },
          { status: 409 }
        );
      }
      // Default to SKU (the other unique column on Product).
      return NextResponse.json(
        { error: "SKU นี้ถูกใช้งานแล้ว", code: "SKU_TAKEN" },
        { status: 409 }
      );
    }
    console.error("POST /api/products failed:", err);
    return NextResponse.json(
      { error: "Could not create product", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

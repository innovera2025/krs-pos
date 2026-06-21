import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

// AUTH (auth Phase 2): admin-only — only an authenticated admin (ADMIN/MANAGER)
// may edit a product.

type PatchProductBody = {
  name?: unknown;
  price?: unknown;
  stock?: unknown;
  categoryId?: unknown;
  barcode?: unknown;
  isActive?: unknown;
};

// PATCH /api/products/[id] — edit a product (partial update).
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;

  const { id } = params;
  if (typeof id !== "string" || id.length === 0) {
    return NextResponse.json(
      { error: "Missing product id", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  let body: PatchProductBody;
  try {
    body = (await req.json()) as PatchProductBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // Build the update payload field-by-field with per-field type validation; only
  // provided fields are touched (partial update).
  const data: Prisma.ProductUpdateInput = {};

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return NextResponse.json(
        { error: "ชื่อสินค้าไม่ถูกต้อง", code: "BAD_NAME" },
        { status: 400 }
      );
    }
    const trimmedName = body.name.trim();
    if (trimmedName.length > 200) {
      return NextResponse.json(
        { error: "ชื่อสินค้ายาวเกินไป", code: "BAD_NAME" },
        { status: 400 }
      );
    }
    data.name = trimmedName;
  }

  if (body.price !== undefined) {
    // Require a real JSON number: Number("")/Number(null) === 0 would silently
    // zero the price. The 99,999,999.99 cap matches the Decimal(10,2) column so
    // an oversized price returns 400 instead of a 500 overflow.
    if (
      typeof body.price !== "number" ||
      !Number.isFinite(body.price) ||
      body.price < 0 ||
      body.price > 99_999_999.99
    ) {
      return NextResponse.json(
        { error: "ราคาไม่ถูกต้อง", code: "BAD_PRICE" },
        { status: 400 }
      );
    }
    data.price = body.price;
  }

  if (body.stock !== undefined) {
    // Require a real JSON integer (Number("")/Number(null) === 0 would silently
    // zero stock). The 2,147,483,647 cap matches the Postgres Int4 column.
    if (
      typeof body.stock !== "number" ||
      !Number.isInteger(body.stock) ||
      body.stock < 0 ||
      body.stock > 2_147_483_647
    ) {
      return NextResponse.json(
        { error: "จำนวนสต็อกไม่ถูกต้อง", code: "BAD_STOCK" },
        { status: 400 }
      );
    }
    data.stock = body.stock;
  }

  if (body.categoryId !== undefined) {
    if (body.categoryId === null) {
      data.category = { disconnect: true };
    } else if (typeof body.categoryId === "string" && body.categoryId.length > 0) {
      // Verify the category exists up-front. Otherwise a connect to a missing id
      // throws P2025, which the catch below misreports as "Product not found".
      const cat = await prisma.category.findUnique({
        where: { id: body.categoryId },
      });
      if (!cat) {
        return NextResponse.json(
          { error: "ไม่พบหมวดหมู่", code: "CATEGORY_NOT_FOUND" },
          { status: 400 }
        );
      }
      data.category = { connect: { id: body.categoryId } };
    } else {
      return NextResponse.json(
        { error: "หมวดหมู่ไม่ถูกต้อง", code: "BAD_CATEGORY" },
        { status: 400 }
      );
    }
  }

  if (body.barcode !== undefined) {
    if (body.barcode === null) {
      data.barcode = null;
    } else if (typeof body.barcode === "string") {
      const trimmed = body.barcode.trim();
      if (trimmed.length > 64) {
        return NextResponse.json(
          { error: "บาร์โค้ดยาวเกินไป", code: "BAD_BARCODE" },
          { status: 400 }
        );
      }
      data.barcode = trimmed.length > 0 ? trimmed : null;
    } else {
      return NextResponse.json(
        { error: "บาร์โค้ดไม่ถูกต้อง", code: "BAD_BARCODE" },
        { status: 400 }
      );
    }
  }

  if (body.isActive !== undefined) {
    if (typeof body.isActive !== "boolean") {
      return NextResponse.json(
        { error: "isActive must be a boolean", code: "BAD_ACTIVE" },
        { status: 400 }
      );
    }
    data.isActive = body.isActive;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "No fields to update", code: "NO_FIELDS" },
      { status: 400 }
    );
  }

  try {
    const product = await prisma.product.update({
      where: { id },
      data,
      include: { category: true },
    });
    return NextResponse.json(product);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      // Not found.
      if (err.code === "P2025") {
        return NextResponse.json(
          { error: "Product not found", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      // Unique-constraint (duplicate barcode).
      if (err.code === "P2002") {
        return NextResponse.json(
          { error: "บาร์โค้ดนี้ถูกใช้งานแล้ว", code: "BARCODE_TAKEN" },
          { status: 409 }
        );
      }
    }
    console.error("PATCH /api/products/[id] failed:", err);
    return NextResponse.json(
      { error: "Could not update product", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

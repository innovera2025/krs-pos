import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/orders — list recent orders
export async function GET() {
  const orders = await prisma.order.findMany({
    include: { items: { include: { product: true } }, cashier: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return NextResponse.json(orders);
}

type IncomingItem = { productId: string; quantity: number };

// POST /api/orders — create an order (checkout)
export async function POST(req: Request) {
  const body = await req.json();
  const {
    items,
    paymentType = "CASH",
    amountPaid = 0,
    discount = 0,
    taxRate = 0,
    cashierId,
  }: {
    items: IncomingItem[];
    paymentType?: string;
    amountPaid?: number;
    discount?: number;
    taxRate?: number;
    cashierId?: string;
  } = body;

  if (!items || items.length === 0) {
    return NextResponse.json({ error: "No items in order" }, { status: 400 });
  }

  // Fetch products and validate stock
  const productIds = items.map((i) => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
  });

  let subtotal = 0;
  const lineItems = items.map((item) => {
    const product = products.find((p) => p.id === item.productId);
    if (!product) throw new Error(`Product not found: ${item.productId}`);
    const unitPrice = Number(product.price);
    const lineTotal = unitPrice * item.quantity;
    subtotal += lineTotal;
    return {
      productId: product.id,
      quantity: item.quantity,
      unitPrice,
      lineTotal,
    };
  });

  const tax = (subtotal - discount) * (taxRate / 100);
  const total = subtotal - discount + tax;
  const change = Math.max(0, amountPaid - total);

  const orderNumber = `ORD-${Date.now()}`;

  // Transaction: create order + decrement stock
  const order = await prisma.$transaction(async (tx) => {
    const created = await tx.order.create({
      data: {
        orderNumber,
        subtotal,
        tax,
        discount,
        total,
        paymentType: paymentType as never,
        amountPaid,
        change,
        cashierId: cashierId || null,
        items: { create: lineItems },
      },
      include: { items: { include: { product: true } } },
    });

    for (const item of lineItems) {
      await tx.product.update({
        where: { id: item.productId },
        data: { stock: { decrement: item.quantity } },
      });
    }

    return created;
  });

  return NextResponse.json(order, { status: 201 });
}

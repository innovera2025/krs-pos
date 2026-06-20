import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Categories — 4 categories matching the Taste catalog
  // (drink / food / dessert / goods). The UI maps these names to slugs+icons.
  const drink = await prisma.category.upsert({
    where: { name: "เครื่องดื่ม" },
    update: {},
    create: { name: "เครื่องดื่ม" },
  });
  const food = await prisma.category.upsert({
    where: { name: "อาหาร" },
    update: {},
    create: { name: "อาหาร" },
  });
  const dessert = await prisma.category.upsert({
    where: { name: "ขนมหวาน" },
    update: {},
    create: { name: "ขนมหวาน" },
  });
  const goods = await prisma.category.upsert({
    where: { name: "ของใช้" },
    update: {},
    create: { name: "ของใช้" },
  });

  // Products — 17-item catalog mirroring design/KRS POS Taste Redesign.html.
  const products = [
    // เครื่องดื่ม · drink
    { name: "อเมริกาโน่ (ร้อน)", sku: "BV-001", price: 55, stock: 120, categoryId: drink.id },
    { name: "ลาเต้ (ร้อน)", sku: "BV-002", price: 65, stock: 88, categoryId: drink.id },
    { name: "คาปูชิโน่", sku: "BV-003", price: 65, stock: 64, categoryId: drink.id },
    { name: "เอสเพรสโซ่", sku: "BV-004", price: 45, stock: 50, categoryId: drink.id },
    { name: "ชาไทยเย็น", sku: "BV-005", price: 45, stock: 42, categoryId: drink.id },
    { name: "มัทฉะลาเต้", sku: "BV-006", price: 70, stock: 36, categoryId: drink.id },
    { name: "น้ำส้มคั้นสด", sku: "BV-007", price: 50, stock: 28, categoryId: drink.id },
    // อาหาร · food
    { name: "ครัวซองต์แฮมชีส", sku: "FD-001", price: 75, stock: 14, categoryId: food.id },
    { name: "แซนด์วิชไก่", sku: "FD-002", price: 85, stock: 6, categoryId: food.id },
    { name: "ข้าวหมูกระเทียม", sku: "FD-003", price: 60, stock: 40, categoryId: food.id },
    { name: "ผัดไทยกุ้งสด", sku: "FD-004", price: 70, stock: 33, categoryId: food.id },
    // ขนมหวาน · dessert
    { name: "บราวนี่", sku: "DS-001", price: 65, stock: 32, categoryId: dessert.id },
    { name: "ชีสเค้ก", sku: "DS-002", price: 85, stock: 18, categoryId: dessert.id },
    { name: "ครัวซองต์เนย", sku: "DS-003", price: 55, stock: 25, categoryId: dessert.id },
    // ของใช้ · goods
    { name: "เมล็ดกาแฟคั่ว 250g", sku: "GD-001", price: 350, stock: 9, categoryId: goods.id },
    { name: "แก้วเซรามิก", sku: "GD-002", price: 180, stock: 21, categoryId: goods.id },
    { name: "ถุงผ้า KRS", sku: "GD-003", price: 250, stock: 3, categoryId: goods.id },
  ];

  for (const p of products) {
    await prisma.product.upsert({
      where: { sku: p.sku },
      update: {},
      create: p,
    });
  }

  // Users — keep the existing admin and add two sellers (CASHIER) so the Users &
  // Roles screen (Phase 4) has rows to exercise the active/inactive toggle and
  // the filter chips. Passwords are non-functional placeholders for the demo.
  // TODO(production-readiness): hash + first-login set; never store a plaintext
  // or placeholder credential in a real deployment.
  const seedUsers = [
    {
      email: "admin@krs-pos.local",
      name: "Admin",
      role: "ADMIN" as const,
      password: "admin123",
      isActive: true,
    },
    {
      email: "seller.aroon@krs-pos.local",
      name: "อรุณ ขายดี",
      role: "CASHIER" as const,
      password: "!set-on-first-login-seed-aroon",
      isActive: true,
    },
    {
      email: "seller.malee@krs-pos.local",
      name: "มาลี พักงาน",
      role: "CASHIER" as const,
      password: "!set-on-first-login-seed-malee",
      isActive: false,
    },
  ];

  for (const u of seedUsers) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: u,
    });
  }

  // Resolve the admin user to own the seeded shift + bills (Phase 5).
  const admin = await prisma.user.findUnique({
    where: { email: "admin@krs-pos.local" },
    select: { id: true },
  });

  // ---- Phase 5: one OPEN shift so the /shift screen has a live shift to close.
  // Opening float ฿2,000 matches the Simple POS cash-counting reference. Upsert on
  // shiftNumber keeps the seed idempotent (re-run = no-op).
  const shift = await prisma.shift.upsert({
    where: { shiftNumber: "SH-20260616-01" },
    update: {},
    create: {
      shiftNumber: "SH-20260616-01",
      status: "OPEN",
      openingFloat: 2000,
      openedAt: new Date("2026-06-16T01:30:00.000Z"), // 08:30 Asia/Bangkok
      cashierId: admin?.id ?? null,
      branchId: "BR-01",
    },
  });

  // A representative product for each seeded bill's single line item (payments are
  // required for reprint; a single OrderItem keeps the receipt detail realistic).
  const repProduct = await prisma.product.findUnique({
    where: { sku: "BV-002" },
    select: { id: true, price: true },
  });

  // ---- Phase 5: 6 seed bills (POS-20260616-0036..0041) exercising every status,
  // sync state, and accounting-doc combination from the research dataset. VAT is
  // VAT-inclusive (tax = total * 7 / 107). Upsert on orderNumber → idempotent;
  // the nested payments/items are created once (update:{} is a no-op on re-run).
  type SeedBill = {
    orderNumber: string;
    status: "COMPLETED" | "REFUNDED" | "VOIDED";
    syncStatus: "PENDING" | "DAILY" | "SYNCED" | "FAILED" | "SKIPPED";
    total: number; // VAT-inclusive baht (negative for refund, 0 for void)
    // Original POSITIVE tender for the PaymentLine. Refund/void are status
    // transitions that DON'T rewrite PaymentLines, so the row keeps the original
    // positive payment (matching live runtime). Defaults to `total` when omitted
    // (COMPLETED bills, where total is already positive).
    paymentAmount?: number;
    accountingDocNo: string | null;
    taxRequested: boolean;
    paymentType: "CASH" | "CARD" | "QR" | "TRANSFER";
    createdAt: string; // ISO (UTC); times below are Asia/Bangkok afternoon
  };

  const seedBills: SeedBill[] = [
    {
      orderNumber: "POS-20260616-0041",
      status: "COMPLETED",
      syncStatus: "SYNCED",
      total: 962.30,
      accountingDocNo: "TAX-2026-000418",
      taxRequested: true,
      paymentType: "TRANSFER",
      createdAt: "2026-06-16T06:58:00.000Z", // 13:58
    },
    {
      orderNumber: "POS-20260616-0040",
      status: "COMPLETED",
      syncStatus: "DAILY",
      total: 130.0,
      accountingDocNo: null,
      taxRequested: false,
      paymentType: "CASH",
      createdAt: "2026-06-16T06:42:00.000Z", // 13:42
    },
    {
      orderNumber: "POS-20260616-0039",
      status: "COMPLETED",
      syncStatus: "FAILED",
      total: 240.0,
      accountingDocNo: null,
      taxRequested: true,
      paymentType: "QR",
      createdAt: "2026-06-16T06:20:00.000Z", // 13:20
    },
    {
      // Refunded bill: total stored negative (−65.00) with a credit-note doc, but
      // the PaymentLine keeps the original POSITIVE tender (+65.00) — refund is a
      // status transition that doesn't rewrite payment rows.
      orderNumber: "POS-20260616-0038",
      status: "REFUNDED",
      syncStatus: "SYNCED",
      total: -65.0,
      paymentAmount: 65.0,
      accountingDocNo: "CN-2026-000087",
      taxRequested: false,
      paymentType: "CASH",
      createdAt: "2026-06-16T05:50:00.000Z", // 12:50
    },
    {
      // Voided bill: zeroed total, skipped from sync, but the PaymentLine keeps the
      // original POSITIVE tender (+185.00) — void is a status transition that
      // doesn't rewrite payment rows.
      orderNumber: "POS-20260616-0037",
      status: "VOIDED",
      syncStatus: "SKIPPED",
      total: 0.0,
      paymentAmount: 185.0,
      accountingDocNo: null,
      taxRequested: false,
      paymentType: "CASH",
      createdAt: "2026-06-16T05:31:00.000Z", // 12:31
    },
    {
      orderNumber: "POS-20260616-0036",
      status: "COMPLETED",
      syncStatus: "DAILY",
      total: 185.0,
      accountingDocNo: null,
      taxRequested: false,
      paymentType: "CARD",
      createdAt: "2026-06-16T04:58:00.000Z", // 11:58
    },
  ];

  for (const b of seedBills) {
    const total = b.total;
    // VAT-inclusive 7% extraction; rounded to 2dp (matches integer-satang display).
    const tax = Math.round((total * 7) / 107 * 100) / 100;
    const unitPrice = repProduct ? Number(repProduct.price) : 65;
    // Voided bills carry a zero line; others a single representative line at total.
    const lineTotal = b.status === "VOIDED" ? 0 : total;

    await prisma.order.upsert({
      where: { orderNumber: b.orderNumber },
      update: {},
      create: {
        orderNumber: b.orderNumber,
        status: b.status,
        subtotal: total,
        tax,
        discount: 0,
        total,
        paymentType: b.paymentType,
        amountPaid: b.paymentType === "CASH" && total > 0 ? total : 0,
        change: 0,
        branchId: "BR-01",
        cashierId: admin?.id ?? null,
        shiftId: shift.id,
        syncStatus: b.syncStatus,
        accountingDocNo: b.accountingDocNo,
        taxRequested: b.taxRequested,
        createdAt: new Date(b.createdAt),
        ...(repProduct
          ? {
              items: {
                create: [
                  {
                    productId: repProduct.id,
                    quantity: 1,
                    unitPrice,
                    lineTotal,
                  },
                ],
              },
            }
          : {}),
        payments: {
          create: [
            {
              method: b.paymentType,
              // POSITIVE original tender: refund/void don't rewrite PaymentLines,
              // so the row keeps the original positive amount that aggregates sum.
              // COMPLETED bills fall back to `total` (already positive).
              amount: b.paymentAmount ?? total,
            },
          ],
        },
      },
    });
  }

  console.log("Seed completed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

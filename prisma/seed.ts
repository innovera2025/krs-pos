import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// bcrypt work factor for seeded credentials (OWASP-valid cost; matches the
// authorize() verification path). Pure-JS bcryptjs → no native deps (Alpine-safe).
const BCRYPT_COST = 12;

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

  // Users — the admin + two sellers (CASHIER) so the Users & Roles screen
  // (Phase 4) has rows to exercise the active/inactive toggle and filter chips.
  //
  // Production-readiness Phase 1: passwords are now bcrypt HASHES (cost 12),
  // verified by the Auth.js Credentials authorize() with bcrypt.compare. Known
  // dev credentials (for local smoke + e2e):
  //   admin@krs-pos.local        / admin123   (ADMIN, active)
  //   seller.aroon@krs-pos.local / seller123  (CASHIER, active)
  //   seller.malee@krs-pos.local / seller123  (CASHIER, INACTIVE — cannot log in)
  // The hash (not the plaintext) is stored; the plaintext above is dev-only.
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
      password: "seller123",
      isActive: true,
    },
    {
      email: "seller.malee@krs-pos.local",
      name: "มาลี พักงาน",
      role: "CASHIER" as const,
      password: "seller123",
      isActive: false,
    },
  ];

  for (const u of seedUsers) {
    // Hash at seed time (never store plaintext). The hash is set on BOTH create
    // and update so re-seeding an existing DB migrates any old plaintext row to a
    // real bcrypt hash (the seed stays idempotent in effect — same credentials).
    const passwordHash = bcrypt.hashSync(u.password, BCRYPT_COST);
    await prisma.user.upsert({
      where: { email: u.email },
      update: {
        name: u.name,
        role: u.role,
        password: passwordHash,
        isActive: u.isActive,
      },
      create: {
        email: u.email,
        name: u.name,
        role: u.role,
        password: passwordHash,
        isActive: u.isActive,
      },
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
      // Refunded bill: refund is a STATUS transition only — the app's refund
      // handler (orders/[id]/route.ts) keeps the original POSITIVE total and sets
      // status REFUNDED (it does NOT rewrite total/tax or the PaymentLine). The
      // credit-note doc records the reversal; reports exclude non-COMPLETED bills
      // so the positive total never double-counts. Positive total also satisfies
      // Order_total_nonneg_chk (Financial/Inventory correctness, Sub-phase B).
      orderNumber: "POS-20260616-0038",
      status: "REFUNDED",
      syncStatus: "SYNCED",
      total: 65.0,
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

  // ---- Phase 6a: 3 seed customers for the customer picker + tax-invoice flow.
  // Two have a tax id (eligible for a tax invoice), one is a member with no tax
  // id (named, but tax-invoice ineligible — exercises the disabled path).
  // Idempotent: tax customers upsert on the unique taxId; the no-taxId member is
  // find-or-create on name (taxId is null, so it can't key the upsert).
  const siamTrade = await prisma.customer.upsert({
    where: { taxId: "0105551234567" },
    update: {},
    create: {
      name: "บริษัท สยามเทรด จำกัด",
      taxId: "0105551234567",
      address: "1200 ถนนพระราม 4 แขวงคลองเตย เขตคลองเตย กรุงเทพฯ 10110",
      branchId: "BR-01",
    },
  });
  await prisma.customer.upsert({
    where: { taxId: "0993000111222" },
    update: {},
    create: {
      name: "ร้านกาแฟ ดอยคำ",
      taxId: "0993000111222",
      address: "88 หมู่ 5 ตำบลแม่งอน อำเภอฝาง จังหวัดเชียงใหม่ 50320",
      branchId: "BR-01",
    },
  });
  // คุณสมชาย ใจดี — member with NO tax id. find-or-create on name keeps it
  // idempotent (a null taxId cannot be used as the upsert key).
  let somchai = await prisma.customer.findFirst({
    where: { name: "คุณสมชาย ใจดี", taxId: null },
    select: { id: true },
  });
  if (!somchai) {
    somchai = await prisma.customer.create({
      data: {
        name: "คุณสมชาย ใจดี",
        taxId: null,
        phone: "081-234-5678",
        branchId: "BR-01",
      },
      select: { id: true },
    });
  }

  // Link 2 existing seeded bills to customers so the SaleDetailDrawer + the
  // request-tax path are testable:
  //  - POS-20260616-0041 → สยามเทรด (has taxId) → canTax = true
  //  - POS-20260616-0038 → คุณสมชาย (member, no taxId) → named but tax-ineligible
  await prisma.order.update({
    where: { orderNumber: "POS-20260616-0041" },
    data: { customerId: siamTrade.id },
  });
  await prisma.order.update({
    where: { orderNumber: "POS-20260616-0038" },
    data: { customerId: somchai.id },
  });

  // ---- Phase 6b: 8 seed SyncJobs (J-1042..J-1035) for the /data KRS Data Link
  // screen — the exact dataset from the Simple POS source-of-truth. The badge on
  // the NavRail "data" item sources its count from status=FAILED (here: 2 → J-1042
  // vat_code mismatch and J-1035 DS-001 mismatch). Explicit non-CUID string ids are
  // valid for a `@id String` field; upsert on `where:{id}` keeps the seed
  // idempotent (re-run = no-op on existing rows). `updatedAt` is set explicitly so
  // the table time matches the source-of-truth (Asia/Bangkok afternoon of the
  // 2026-06-16 seed day); @updatedAt only auto-writes on UPDATE, not on create.
  type SeedJob = {
    id: string;
    type:
      | "SALE"
      | "REFUND"
      | "STOCK"
      | "PULL"
      | "TAX_INVOICE"
      | "STOCK_ADJ"
      | "RECEIVE";
    direction: "INSERT" | "PULL";
    ref: string;
    amount: number;
    status: "PENDING" | "SYNCED" | "FAILED" | "RETRYING" | "SKIPPED";
    error: string | null;
    response: string;
    // ISO (UTC); the time-of-day below is the Asia/Bangkok afternoon shown in the
    // table (UTC = Bangkok − 7h). PENDING has no time in the source — we keep a
    // createdAt so the row sorts, but the UI shows "—" for a PENDING updated time.
    updatedAt: string;
  };

  const seedJobs: SeedJob[] = [
    {
      id: "J-1042",
      type: "SALE",
      direction: "INSERT",
      ref: "POS-20260616-0039",
      amount: 240.0,
      status: "FAILED",
      error:
        'FIELD_MAP_MISMATCH: ฟิลด์ "vat_code" ใน POS ยังไม่ได้จับคู่กับคอลัมน์ KRS.sales.tax_code',
      response:
        'HTTP 422 · {"code":"field_not_mapped","field":"vat_code","target":"KRS.sales.tax_code"}',
      updatedAt: "2026-06-16T06:21:00.000Z", // 13:21
    },
    {
      id: "J-1041",
      type: "SALE",
      direction: "INSERT",
      ref: "POS-20260616-0041",
      amount: 962.3,
      status: "SYNCED",
      error: null,
      response: 'HTTP 200 · INSERT KRS.sales · {"krs_id":"BK-48280","rows":1}',
      updatedAt: "2026-06-16T06:59:00.000Z", // 13:59
    },
    {
      id: "J-1040",
      type: "REFUND",
      direction: "INSERT",
      ref: "POS-20260616-0038",
      amount: -65.0,
      status: "SYNCED",
      error: null,
      response: 'HTTP 200 · INSERT KRS.sales · {"krs_id":"BK-48201","rows":1}',
      updatedAt: "2026-06-16T05:51:00.000Z", // 12:51
    },
    {
      id: "J-1039",
      type: "SALE",
      direction: "INSERT",
      ref: "POS-20260616-0035",
      amount: 540.0,
      status: "RETRYING",
      error:
        "NETWORK_TIMEOUT: เชื่อมต่อ KRS (203.0.113.45:3306) ไม่สำเร็จ กำลังลองใหม่ (2/5)",
      response: "HTTP 504 · gateway timeout",
      updatedAt: "2026-06-16T06:25:00.000Z", // 13:25
    },
    {
      id: "J-1038",
      type: "SALE",
      direction: "INSERT",
      ref: "POS-20260616-0034",
      amount: 88.0,
      status: "PENDING",
      error: null,
      response: "อยู่ในคิวรอ insert เข้า KRS.sales",
      updatedAt: "2026-06-16T06:18:00.000Z", // queued; table shows "—" for PENDING
    },
    {
      id: "J-1037",
      type: "PULL",
      direction: "PULL",
      ref: "KRS.products",
      amount: 0,
      status: "SYNCED",
      error: null,
      response:
        "HTTP 200 · ดึง 17 แถวจาก KRS.products → map → อัปเดต POS catalog",
      updatedAt: "2026-06-16T06:05:00.000Z", // 13:05
    },
    {
      id: "J-1036",
      type: "STOCK",
      direction: "INSERT",
      ref: "POS-20260616-0041",
      amount: 411.0,
      status: "SYNCED",
      error: null,
      response: 'HTTP 200 · INSERT KRS.stock_movements · {"rows":3}',
      updatedAt: "2026-06-16T06:59:00.000Z", // 13:59
    },
    {
      id: "J-1035",
      type: "STOCK",
      direction: "INSERT",
      ref: "GRN-20260616-007",
      amount: 8750.0,
      status: "FAILED",
      error:
        'FIELD_MAP_MISMATCH: สินค้า "บราวนี่ (DS-001)" ไม่มีคู่ฟิลด์ sku → KRS.products.item_code',
      response: 'HTTP 422 · {"code":"field_not_mapped","sku":"DS-001"}',
      updatedAt: "2026-06-16T03:42:00.000Z", // 10:42
    },
  ];

  for (const j of seedJobs) {
    await prisma.syncJob.upsert({
      where: { id: j.id },
      update: {},
      create: {
        id: j.id,
        type: j.type,
        direction: j.direction,
        ref: j.ref,
        amount: j.amount,
        status: j.status,
        provider: "KRS",
        error: j.error,
        response: j.response,
        branchId: "BR-01",
        // Anchor createdAt to the same historical timestamp as updatedAt so the row
        // is internally consistent (createdAt <= updatedAt); otherwise createdAt
        // defaults to the seed-run day (2026-06-20) and sorts after updatedAt.
        createdAt: new Date(j.updatedAt),
        updatedAt: new Date(j.updatedAt),
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

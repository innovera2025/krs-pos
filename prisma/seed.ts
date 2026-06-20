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

  // Default admin user (password is plaintext for demo — replace with hashing in production)
  await prisma.user.upsert({
    where: { email: "admin@krs-pos.local" },
    update: {},
    create: {
      email: "admin@krs-pos.local",
      name: "Admin",
      role: "ADMIN",
      password: "admin123",
    },
  });

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

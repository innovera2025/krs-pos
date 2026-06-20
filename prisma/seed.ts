import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Categories
  const beverages = await prisma.category.upsert({
    where: { name: "เครื่องดื่ม" },
    update: {},
    create: { name: "เครื่องดื่ม" },
  });
  const snacks = await prisma.category.upsert({
    where: { name: "ขนม" },
    update: {},
    create: { name: "ขนม" },
  });
  const general = await prisma.category.upsert({
    where: { name: "ทั่วไป" },
    update: {},
    create: { name: "ทั่วไป" },
  });

  // Products
  const products = [
    { name: "น้ำเปล่า 600ml", sku: "BEV-001", price: 10, stock: 100, categoryId: beverages.id },
    { name: "กาแฟกระป๋อง", sku: "BEV-002", price: 25, stock: 50, categoryId: beverages.id },
    { name: "น้ำอัดลม", sku: "BEV-003", price: 20, stock: 80, categoryId: beverages.id },
    { name: "มันฝรั่งทอด", sku: "SNK-001", price: 30, stock: 40, categoryId: snacks.id },
    { name: "ช็อกโกแลตบาร์", sku: "SNK-002", price: 35, stock: 30, categoryId: snacks.id },
    { name: "ถุงพลาสติก", sku: "GEN-001", price: 2, stock: 500, categoryId: general.id },
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

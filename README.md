# KRS POS

ระบบขายหน้าร้าน (Point of Sale) แบบ full-stack สร้างด้วย Next.js 14 (App Router), TypeScript, Tailwind CSS และ Prisma + PostgreSQL

## ฟีเจอร์เริ่มต้น

- หน้าขายสินค้า: ค้นหา เลือกสินค้าลงตะกร้า ปรับจำนวน และชำระเงิน
- API สำหรับสินค้า (`/api/products`) และคำสั่งซื้อ (`/api/orders`)
- ตัดสต็อกอัตโนมัติเมื่อขายสำเร็จ (ผ่าน transaction)
- โครงสร้างฐานข้อมูล: User, Category, Product, Order, OrderItem
- ข้อมูลตัวอย่าง (seed) พร้อมสินค้าและผู้ใช้ admin

## เทคโนโลยี

| ส่วน | เครื่องมือ |
|------|-----------|
| Framework | Next.js 14 (App Router) |
| ภาษา | TypeScript |
| UI | Tailwind CSS |
| ORM | Prisma |
| ฐานข้อมูล | PostgreSQL |

## เริ่มต้นใช้งาน

### 1. ติดตั้ง dependencies

```bash
npm install
```

### 2. ตั้งค่าฐานข้อมูล

คัดลอก `.env.example` เป็น `.env` แล้วใส่ connection string ของ PostgreSQL

```bash
cp .env.example .env
```

### 3. สร้างตารางและ seed ข้อมูล

```bash
npm run prisma:generate
npm run db:push        # หรือ npm run prisma:migrate
npm run prisma:seed
```

### 4. รันโปรเจกต์

```bash
npm run dev
```

เปิดเบราว์เซอร์ที่ http://localhost:3000

## โครงสร้างโปรเจกต์

```
src/
  app/
    api/
      products/route.ts   # GET, POST สินค้า
      orders/route.ts     # GET, POST คำสั่งซื้อ (checkout)
    layout.tsx
    page.tsx              # หน้า POS หลัก
    globals.css
  lib/
    prisma.ts             # Prisma client singleton
  types/
    index.ts              # TypeScript types
prisma/
  schema.prisma           # โครงสร้างฐานข้อมูล
  seed.ts                 # ข้อมูลตัวอย่าง
```

## บัญชีตัวอย่าง

ผู้ใช้ admin ตัวอย่างถูกสร้างโดย `prisma/seed.ts` ตอนรัน `npm run prisma:seed`
รหัสผ่านไม่ถูกเผยแพร่ในเอกสารนี้ — ให้ตั้ง/หมุนรหัสผ่านเองในเครื่อง local
(เช่น แก้ค่าใน `prisma/seed.ts` หรือผ่าน env ก่อนรัน seed)

> หมายเหตุ: รหัสผ่านใน seed ปัจจุบันยังเป็น plaintext เพื่อการทดสอบ ควรเพิ่มการ hash (เช่น bcrypt) ก่อนใช้งานจริง และห้าม commit รหัสผ่านจริงลง git

## สิ่งที่ควรทำต่อ (Roadmap)

- ระบบ login / authentication
- หน้าจัดการสินค้าและสต็อก (admin)
- รายงานยอดขาย
- พิมพ์ใบเสร็จ
- รองรับการชำระเงินหลายช่องทาง (เงินสด / บัตร / QR)

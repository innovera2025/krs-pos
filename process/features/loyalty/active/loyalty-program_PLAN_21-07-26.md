# Membership + Loyalty Points — สมาชิก + สะสมแต้ม (แลกส่วนลด/ของแถม)

## Context
เจ้าของร้านต้องการระบบสมาชิก + สะสมแต้ม: ลูกค้าสมัครสมาชิก, ซื้อของได้แต้มสะสม, แล้วเอาแต้มแลกเป็น
**ส่วนลดเงินบาท (เงินคืน)** หรือ **ของแถม/สินค้าฟรี** ได้ ปัจจุบัน **ไม่มีระบบแต้ม/สมาชิกเลย** — มีแค่
`Customer` (ชื่อ/เลขภาษี/เบอร์/ที่อยู่ ใช้เพื่อใบกำกับภาษี) ผูกกับบิลแบบ optional + มี picker UI พร้อม
ผลที่ต้องการ: สมาชิกได้แต้มอัตโนมัติทุกบิล, แลกแต้มที่หน้าขายได้, ยอดหลังแลกส่งเข้า KRS ถูกต้อง, มีจอ
จัดการสมาชิก + รายงานแต้ม

### การตัดสินใจที่ล็อกแล้ว (owner ตอบ 21-07-26)
| # | เรื่อง | ตัดสินใจ |
|---|---|---|
| D1 | ตัวตนสมาชิก | **ต่อยอด `Customer` เดิม** (เพิ่ม field แต้ม + เบอร์เป็น key สมาชิก) — reuse picker + การผูกบิล |
| D2 | ระดับสมาชิก | **ไม่มีระดับ** อัตราแต้มเดียวทั้งร้าน (ตั้งใน Settings) |
| D3 | การแลกแต้ม | **ทั้งสองแบบ**: (A) แลกเป็นส่วนลดเงินบาท, (B) แลกเป็นของแถม/สินค้าฟรี (มี catalog) |
| D4 | อายุแต้ม | **ไม่หมดอายุ** (v1) |
| D5 | สิทธิ์ | สมัคร/ผูก/แลกที่ POS = ทุก role (เหมือนลูกค้าเดิม); ตั้งค่าอัตรา + ปรับแต้มมือ + catalog = ADMIN |
| D6 | KRS | แต้ม = POS-only ไม่ส่ง KRS; **การแลก = ส่วนลด** ไหลผ่าน `Order.discount`→`Hdr.DiscountAmount` เดิม (ไม่แก้ฝั่ง ERP); ของแถม = line discount เต็มราคา→`Dtl.DiscountAmount` (เหมือน promo free unit) |

---

## Money Contract (แกนกลาง — ห้ามพัง)
Invariant เดิมที่ enforce 3 จุด (`pricing.ts:135`, `orders/route.ts:800-804`, `writeback.ts:410-458`):
**`subtotal − discount === total`** และ `Σ Dtl.Amount − Hdr.DiscountAmount === Hdr.TotalAmount`

- **แลกแต้มเป็นเงินบาท** = slice ส่วนลดท้ายบิลตัวที่ 3 (นอกจาก promo threshold + manual): fold เข้า
  `combinedBill` **ก่อน** `computeOrderTotals` (`orders/route.ts:787`) → invariant คงอยู่อัตโนมัติ + เข้า KRS ผ่าน
  `Hdr.DiscountAmount` (flag `KRS_DISCOUNT_WRITE_ENABLED` เปิดบน prod แล้ว)
- **แลกของแถม** = เพิ่ม cart line ราคาปกติ + line discount = ราคาเต็ม → `lineTotal 0` (path เดียวกับ Buy-X-Get-Y
  free unit ที่มีอยู่) → ตัดสต็อก + โชว์เป็นบรรทัด + เข้า `Dtl.DiscountAmount` เดิม
- **แต้ม = จำนวนเต็ม (Int)**; มูลค่าแลกคิดเป็น satang จาก setting → ไม่แตะ `pricing.ts` (คณิตศาสตร์เดิม)
- **ต้อง update drift guard** `orders/route.ts:800-804` จาก `billDiscount === promoBill + manual` →
  `=== promoBill + manual + pointsRedemption`
- **ห้าม** ทำ redeem เป็น payment line (ชน gate `amountPaidSatang === totalSatang` ที่ `orders/route.ts:833`) — เป็นส่วนลดเท่านั้น

---

## Data Model (additive migration)
**ขยาย `Customer`** (`prisma/schema.prisma:18-36`):
- `isMember Boolean @default(false)`, `pointsBalance Int @default(0)` (cache ยอด ledger สำหรับอ่านเร็ว),
  `memberSince DateTime?`
- เบอร์เป็น key สมาชิก: **partial unique index ผ่าน raw SQL ใน migration** —
  `CREATE UNIQUE INDEX ... ON "Customer"(phone) WHERE "isMember" = true AND phone IS NOT NULL`
  (ไม่ทำ `@unique` ตรง ๆ เพราะลูกค้าเก่ามีเบอร์ null/ซ้ำ จะ break migration); คง `phone` nullable ที่ column
  แต่ enroll boundary (API) บังคับมีเบอร์

**ใหม่ `PointsTransaction`** (ledger กันได้ตรวจสอบ):
- `id`, `customerId` (FK), `orderId String?` (snapshot บิลที่ได้/ใช้แต้ม), `type` (enum `EARN|REDEEM|ADJUST|REVERSAL`),
  `points Int` (มีเครื่องหมาย: +ได้ −ใช้), `balanceAfter Int`, `note String?`, `actorId String?`, `createdAt`
- `@@index([customerId, createdAt])`; `Customer.pointsBalance` อัปเดตใน tx เดียวกับ ledger เสมอ

**ใหม่ `Reward`** (catalog ของแถม — Phase 3):
- `id`, `name`, `pointsCost Int`, `productId String` (สินค้าที่แจกฟรี), `isActive Boolean @default(true)`, timestamps

**ขยาย `Order`** (snapshot no-FK เหมือน promo, `schema.prisma:326-328`):
- `pointsEarned Int @default(0)`, `pointsRedeemed Int @default(0)`,
  `pointsRedemptionDiscount Decimal(10,2) @default(0)` (ส่วน slice ของแต้มใน `discount` รวม)

**ขยาย `ShopSettings`** singleton (`schema.prisma:142-159`) — config โลก:
- `loyaltyEnabled Boolean @default(false)`, `earnBahtPerPoint Int @default(25)` (ใช้จ่าย ฿25 ได้ 1 แต้ม),
  `redeemPointValueSatang Int @default(10)` (1 แต้ม = ฿0.10 ตอนแลกเงิน), `minRedeemPoints Int @default(0)`

**enum `AuditAction`** เพิ่ม: `MEMBER_ENROLLED, POINTS_ADJUSTED` (+ `LOYALTY_SETTINGS_CHANGED` ถ้าแยกจาก KRS_SETTINGS)

---

## Phases (เรียงตาม deploy — Phase 1 ปลอดภัยขึ้นก่อน, Phase 2 แตะเงิน/KRS ต้อง pricing-tester)

### Phase 0 — Feature folder + plan artifact
สร้าง `process/features/loyalty/{active,completed,backlog,reports,references}/`, บันทึกแผนนี้เป็น
`loyalty-program_PLAN_21-07-26.md`, เพิ่ม "loyalty" ใน current features list ของ `process/context/all-context.md`

### Phase 1 — สมาชิก + สะสมแต้ม (EARN อย่างเดียว — ยังไม่แลก; ปลอดภัย ไม่แตะเงินบิล)
- **Schema**: migration `add_loyalty` (Customer fields + PointsTransaction + Order columns + ShopSettings config +
  enum + partial unique index raw SQL). Zod: `src/lib/schemas/shopSettings.ts` (เพิ่ม loyalty fields + bounds),
  `src/lib/schemas/customer.ts` (เพิ่ม `isMember`; enroll → phone required)
- **Engine (pure, isomorphic — ต้นแบบ `promotionEngine.ts`)**: ใหม่ `src/lib/loyalty.ts` —
  `pointsEarned(netTotalSatang, earnBahtPerPoint): number` (= `floor(netBaht / rate)`),
  `redemptionValueSatang(points, pointValueSatang, subtotalSatang): number` (clamp ≤ subtotal) — satang int, clock-free
- **Settings**: การ์ด loyalty ใน `src/app/(shell)/settings/page.tsx` + `/api/settings` PATCH (requireAdmin เดิม) —
  เปิด/ปิด, อัตราได้แต้ม, ค่าแต้ม, ขั้นต่ำการแลก
- **Enroll**: ขยาย `CustomerFormModal.tsx` (toggle "สมัครสมาชิก" + เบอร์ required เมื่อสมัคร) + `/api/customers`
  POST/PATCH (requireUser เดิม) เขียน `isMember/memberSince`; P2002 partial-index → 409 `MEMBER_PHONE_TAKEN`
- **EARN ที่ checkout**: `src/app/api/orders/route.ts` — **ใน `$transaction` (:920-1094)** ถ้าบิลมี member customer:
  คำนวณ `pointsEarned(totals.totalSatang, rate)` → `tx.pointsTransaction.create({type:EARN})` +
  `tx.customer.update({ pointsBalance: { increment } })` + เขียน `Order.pointsEarned`; หลัง commit `logAudit`
- **POS display**: customer chip (`pos/page.tsx:1619-1659`) โชว์ "สมาชิก · {balance} แต้ม" เมื่อ `customer.isMember`;
  DTO customer เพิ่ม `isMember/pointsBalance`
- **จอสมาชิก** ใหม่ `/members`: nav wiring (`roleAccess.ts` + `NavRail.tsx` + `auth.config.ts` PROTECTED_PREFIXES),
  หน้า template จาก promotions/customers — ค้นหา (เบอร์/ชื่อ), ตารางสมาชิก + ยอดแต้ม, drawer ประวัติ ledger,
  ปุ่มปรับแต้มมือ (requireAdmin) → `/api/members` + `/api/members/[id]` (GET list/detail requireUser; POST adjust requireAdmin)
- **ใบเสร็จ**: `ReceiptModal.tsx` (totals block :310-354) + `receiptPrint.ts` + `print/receiptImage.ts` เพิ่ม
  "แต้มที่ได้รับ: +X · แต้มคงเหลือ: Z"
- **รายงานแต้ม**: `/api/loyalty/report?from&to` (requireUser, COMPLETED-only, Bangkok half-open window ผ่าน
  `bangkokDayStringToWindow`/`parseBangkokDay` เดิม) + tab/หน้ารายงาน (template `PromotionReportTab.tsx`)

### Phase 2 — แลกแต้มเป็นส่วนลดเงินบาท (แตะเงิน + KRS — ต้อง pricing-tester + KRS proof)
- **Redeem ที่ checkout**: client ส่ง `redeemPoints: number` (ไม่ส่งเงิน); server (pre-tx) validate balance +
  คำนวณ `redemptionValueSatang` → fold เป็น bill-discount slice เข้า `application.combinedBill` **ก่อน**
  `computeOrderTotals`; **update drift guard** (:800-804) เป็น 3 slice; เขียน `Order.pointsRedeemed/pointsRedemptionDiscount`
- **หัก แต้ม atomic (กัน overdraw — pattern เดียวกับ stock `updateMany WHERE stock>=qty`)**: ใน tx
  `tx.customer.updateMany({ where:{ id, pointsBalance:{ gte:redeemPoints } }, data:{ pointsBalance:{ decrement }}})`;
  count 0 → throw → 422 `POINTS_INSUFFICIENT` (rollback ทั้งบิล) + `pointsTransaction.create({type:REDEEM})`
- **Stale preview**: reuse `PAYMENT_MISMATCH` เดิม (ยอดจ่ายไม่ตรง → client refetch balance + recompute) — ไม่ต้องทำใหม่
- **POS UI**: control "ใช้แต้มแลกส่วนลด" ใน `PaymentModal`/`TotalsBar` (กรอกแต้ม → โชว์ ฿ ที่ลด, clamp ≤ ยอดบิล +
  ≤ balance + ≥ minRedeem); แถวส่วนลดแยก (สี gold ใหม่ — ดูล่าง)
- **ใบเสร็จ**: แถว "ใช้แต้มแลกส่วนลด −฿Y (−N แต้ม)" แยกจาก manual/promo ทั้ง 3 render path
- **KRS**: ไม่แก้ writeback — redemption อยู่ใน `Order.discount` รวม → `Hdr.DiscountAmount` เดิม; รัน
  `krs-discount-proof.cjs` ยืนยันบิล redeem ผ่าน identity

### Phase 3 — Reward catalog + แลกของแถม
- **`Reward` model + admin CRUD**: หน้า `/rewards` (หรือ tab ใน /members) requireAdmin — สร้างของรางวัล (ชื่อ,
  แต้มที่ใช้, สินค้าที่แจก, เปิด/ปิด) template PromotionFormModal
- **Redeem ของแถมที่ POS**: เลือก reward → เพิ่มสินค้าเข้า cart + line discount = ราคาเต็ม (`lineTotal 0`) +
  หัก `pointsCost` (atomic เหมือน Phase 2) → ตัดสต็อกจริง + โชว์บรรทัด "แลกของรางวัล: {ชื่อ}"
- **ข้อจำกัด (documented)**: บิลที่มีแต่ของแถมล้วน `total=0` จะโดน KRS assert (2f) `total>0` ปฏิเสธ →
  การแลกของแถมต้องมากับบิลที่มียอดจ่าย > 0 (checkout เดิมกัน 0-total อยู่แล้ว)

### Closeout — UPDATE PROCESS
context (`all-context.md` features + `database/all-database.md` โมเดลใหม่), memory: loyalty-program-state

---

## Public Contracts
- `GET /api/members` (requireUser) → member list + balance; `GET /api/members/[id]` → detail + ledger;
  `POST /api/members/[id]/adjust` (requireAdmin) → manual points ± + ledger
- `GET /api/loyalty/report?from&to` (requireUser) → earned/redeemed aggregate (COMPLETED-only, 2dp/int)
- `POST /api/orders` body เพิ่ม (optional): `redeemPoints?: number`, `redeemRewardId?: string` (Phase 3);
  response + `GET /api/orders/[id]` เพิ่ม `pointsEarned/pointsRedeemed/pointsRedemptionDiscount`
- `/api/settings` PATCH เพิ่ม loyalty config (requireAdmin); customer DTO เพิ่ม `isMember/pointsBalance`
- Invariant ใหม่: `billDiscount === promoBill + manual + pointsRedemption`; แต้มไม่มีวันติดลบ (atomic guard)

## Blast Radius
- **สูงสุด**: `orders/route.ts` (checkout — EARN in-tx + redeem slice + drift guard), `pricing.ts` **ไม่แตะคณิต**
  (redemption เป็น input ผ่าน combinedBill เดิม)
- **กลาง**: schema migration + partial unique index, ShopSettings/Settings, receipt (3 paths), POS payment/totals
- **ต่ำ**: จอ /members, /rewards, รายงาน, engine `loyalty.ts` ใหม่ (pure)
- **ไม่แตะ**: `writeback.ts`/KRS (redemption ใช้ discount slice เดิม), inbound sync, stock decrement กลไก, idempotency

## สี / Design
โปร = mint, manual/tax = blue (มีอยู่) → **loyalty/แต้ม = โทน gold/amber ใหม่** (เช่น `#B45309`/`#F59E0B`, bg
`#FFFBEB`) เพื่อไม่สับสน; ให้ vc-ui-ux-designer เก็บ token ตอน execute; Thai-first microcopy

## Verification Evidence (ต่อ Phase)
1. **P1**: `npm test` (loyalty engine golden: earn floor by rate, edge rate; ledger balance = Σ points); enroll →
   ขาย → `Order.pointsEarned` + balance เพิ่มถูก + ledger row; ใบเสร็จโชว์แต้ม; รายงานนับเฉพาะ COMPLETED
2. **P2**: `pricing-tester` agent + `/verify`; redeem → `subtotal−discount===total` คงอยู่ + drift guard 3-slice ผ่าน;
   POINTS_INSUFFICIENT เมื่อแต้มไม่พอ (atomic, บิล rollback); stale redeem → PAYMENT_MISMATCH + replay identical;
   `krs-discount-proof.cjs` บิล redeem ผ่าน identity บน sandbox/live
3. **P3**: แลกของแถม → สต็อกตัด + บรรทัดโชว์ + `Dtl.DiscountAmount` ถูก; บิลของแถมล้วน (total 0) ถูกกันตามข้อจำกัด
- ทุก Phase: `npm run type-check` + `npm run build`; **ห้าม NUL bytes**; commit แยก Phase; push `gh auth switch --user innovera2025`

## Resume / Execution Handoff
- Phase เรียงตาม dependency; **P1 shippable เดี่ยว (earn only ปลอดภัย)** → P2 (money+KRS, ต้อง pricing-tester +
  owner ยังไม่ต้อง flip อะไร เพราะ KRS_DISCOUNT_WRITE_ENABLED เปิดแล้ว) → P3
- Reuse ยืนยันแล้ว: `applyPromotions`/`combinedBill` (engine slice), `computeOrderTotals` drift guard, atomic
  `updateMany WHERE >=` (stock→points), `logAudit` post-commit, `bangkokDayStringToWindow` (report),
  CustomerPicker/FormModal, ShopSettings singleton, nav-wiring 3-file pattern
- ⚠️ partial unique index ต้องเขียน raw SQL ใน migration (Prisma ไม่รองรับ native); ลูกค้าเก่าเบอร์ null/ซ้ำต้องไม่ break

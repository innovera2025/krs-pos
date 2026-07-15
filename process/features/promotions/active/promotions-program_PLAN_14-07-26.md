<!-- Created 14-07-26 | Type: multi-phase program | Status: all 8 phases code-complete 14-07-26
     (commits 8e124b2, 939b477, 2b73ced, 70aa429, cd3bc3d, fbc764e, 296197c, fe507ce, 0c191c0,
     e584284, dd0ae0c). Verified: 85/85 vitest (pricing.test.ts + checkoutPromo.test.ts +
     promotionEngine.test.ts + datetime.test.ts) + type-check + build + pricing-tester agent SHIP
     verdict. REMAINING before production promo use: (a) deploy — Phase 1 (KRS net-out mapping)
     must reach prod BEFORE any promotion is created/used at checkout; (b) send vendor questions
     Q1-Q8 (process/features/promotions/references/krs-discount-writeback-contract_14-07-26.md);
     (c) sandbox verification of the net-out mapping; (d) owner flips `KRS_DISCOUNT_WRITE_ENABLED`
     themselves after (b)+(c) pass; (e) manual QA checklist — pending, not yet executed. -->

# Promotion Feature — สร้างโปรโมชันที่ POS + ส่งยอดกลับ KRS ไปกับบิลขายปกติ

## Context

ร้านต้องการระบบโปรโมชันใน POS: ADMIN สร้าง/จัดการโปรโมชันเอง ระบบ apply อัตโนมัติที่หน้าขาย และยอดขายหลังหักโปรส่งกลับ KRS **ไปกับบิลขายปกติ** (writeback เดิมที่ live อยู่แล้วสำหรับขายสด)

ปัจจุบัน **ไม่มีระบบโปรโมชันเลย** — มีแค่ส่วนลด manual (ต่อรายการ + ท้ายบิล) และมีช่องโหว่จริงใน prod: writeback ปัจจุบันเขียนบิลที่มีส่วนลดแบบ **ไม่ reconcile** (Σ `SalesInvoiceDtl.Amount` = ยอด gross แต่ `SalesInvoiceHdr.TotalAmount` = ยอด net; คอลัมน์ `DiscountAmount/DiscountPercent` ใน Dtl ถูก hardcode 0) — ร้านเลี่ยงด้วยการไม่ใช้ส่วนลด (backlog #2 ของ krs-sync) แผนนี้ปิดช่องโหว่นั้นเป็นเฟสแรกก่อนเปิดใช้โปรโมชัน

### การตัดสินใจที่ล็อกแล้ว (owner ตอบ 14-07-26)
| # | เรื่อง | ตัดสินใจ |
|---|---|---|
| D1 | ประเภทโปร | ทั้ง 4: ลดต่อสินค้า (%/฿), ราคาพิเศษ (fixed), ซื้อ X แถม/ลด Y (สินค้าเดียวกัน v1), ลดตามยอดบิล (threshold) |
| D2 | สิทธิ์จัดการ | ~~**ADMIN เท่านั้น** (MANAGER ไม่ได้ — guard `requireStrictAdmin` ใหม่)~~ **(superseded 15-07-26)** → **ทุก role ที่ล็อกอิน จัดการโปรได้** (owner decision; create/edit/toggle + Report tab); accountability ผ่าน AuditLog (actor ถูกบันทึกทุก mutation) + Z-report/รายงานต่อโปร |
| D3 | ส่งยอด KRS | ไปกับบิลขายปกติ (writeback SALE เดิม) ด้วย mapping net-out ที่ reconcile ในตัว; ทดสอบ sandbox ก่อนเปิด flag |
| D4 | การ apply | อัตโนมัติ (server-authoritative; client preview ด้วย engine เดียวกัน) |
| D5 | ซ้อนส่วนลด manual | ซ้อนได้ — คิดโปรก่อน แล้ว manual ทับได้; บันทึกแยกส่วนโปร/manual ชัดเจน |
| D6 | Z-report | สรุปยอดโปรในเฟสแรกด้วย |

### Default ที่ใช้ (documented, เปลี่ยนทีหลังได้)
- โปรต่อบรรทัดสูงสุด 1 ตัว (เลือกตัวที่ลดมากสุด; เสมอกัน → id น้อยสุด — deterministic ทั้ง client/server)
- Buy X Get Y = สินค้าเดียวกันเท่านั้น (ของแถมต้องอยู่ในตะกร้า เช่น ซื้อ 2 แถม 1 ต้องกด qty 3); qty ไม่ครบชุด → เศษจ่ายเต็ม
- Threshold ประเมินบน subtotal ที่แสดงบนจอ (หลังส่วนลดระดับบรรทัดทั้งหมด)
- FIXED_PRICE ≥ ราคาปกติ → โปรไม่ apply (ไม่มีทาง markup); โปรห้ามแตะ `Product.price` (KRS เป็นเจ้าของ, inbound sync ทับทุกรอบ)
- หน้า /promotions ทั้งหน้าเป็น strict-ADMIN (MANAGER มองไม่เห็น); CASHIER เห็นโปรเฉพาะผลที่ apply บนหน้าขาย

---

## Money Contract (แกนกลางที่ทุกเฟสต้องยึด)

**ระดับบรรทัด** — fold แบบเดียวกับส่วนลด manual เดิม:
- `OrderItem.lineTotal` = gross − manualLineDiscount − **promoLineDiscount** (Σ lineTotal === Order.subtotal คงเดิม)
- คอลัมน์ใหม่ `OrderItem`: `promotionId String?` (ไม่มี FK — snapshot), `promotionName String?`, `promoDiscount Decimal(10,2) @default(0)` + `@@index([promotionId])`

**ระดับบิล** — `Order.discount` **คงความหมาย = ส่วนลดท้ายบิลรวม (โปร threshold + manual)** → invariant `subtotal − discount === total` **ไม่เปลี่ยนทุกจุด** (checkout, writeback assert :387, Z-report, sales history)
- คอลัมน์ใหม่ `Order`: `promoBillDiscount Decimal(10,2) @default(0)` (ส่วนของโปร; manual = discount − promoBillDiscount), `billPromotionId String?`, `billPromotionName String?`

**ลำดับการคิด (ใน engine เดียว ใช้ทั้ง client preview และ server):**
1. ต่อบรรทัด: หา candidate โปร (type 1-3) จาก line gross (ราคา catalog × qty) → เลือกตัวลดมากสุด
2. `combinedLineDiscountSatang = min(promoLine + manualLine, gross)` → ป้อนเป็น `lineDiscountSatang` ให้ pricing ตามเดิม
3. subtotal = Σ max(gross − combined, 0) (สูตรเดียวกับ pricing → เท่ากันแน่นอน)
4. โปร threshold: ถ้า subtotal ≥ min → ลด (clamp ≤ subtotal)
5. manual bill discount ทับ (percent คิดจาก subtotal เดียวกัน, clamp ≤ subtotal − promoBill)
6. `computeOrderTotals(products, lines, { type: "amount", value: (promoBill+manualBill)/100 })` — **pricing.ts คณิตศาสตร์ไม่แตะ** (round-trip satang→baht→satang exact, มี proof ใน comment)
7. Server cross-check: `totals.subtotalSatang === engine.subtotalSatang` มิฉะนั้น 500 INTERNAL

**KRS wire (net-out):** ต่อบรรทัด `gross = toSatang(unitPrice)×qty`, `net = lineNet` (จาก pricing หลัง allocate ส่วนลดบิลแบบ largest-remainder) →
`Dtl.UnitPrice = catalog เดิม`, `Dtl.DiscountAmount = (gross−net)/100`, `Dtl.DiscountPercent = 0 เสมอ` (exact, ไม่มี division-by-zero), `Dtl.Amount = net/100`
Identity: `UnitPrice×Qty − DiscountAmount == Amount` (exact ระดับ satang) และ **Σ Dtl.Amount == Hdr.TotalAmount** ✓ | Hdr / TheJournal / SalePurchaseTax **ไม่แตะเลย** (net อยู่แล้ว, VAT คิดบนยอดหลังหักส่วนลดอยู่แล้ว)

---

## Phases (เรียงตาม deploy ordering — เฟส 1 ต้อง deploy ก่อนเฟส 6 ขึ้น prod)

Verify gate ทุกเฟส: `npm run type-check` + `npm run build` (+ `npm test` เฟสที่มี test; vitest มีจริง: `src/lib/pricing.test.ts`, `datetime.test.ts` — โน้ต "ไม่มี test runner" ใน CLAUDE.md เก่าแล้ว)

### Phase 0 — Feature folder + repo plan artifact
สร้าง `process/features/promotions/{active,completed,backlog,reports,references}/`, บันทึก plan นี้เป็น `promotions-program_PLAN_14-07-26.md` ใน `active/`, เพิ่ม "promotions" ใน current features list ของ `process/context/all-context.md`

### Phase 1 — KRS discount-safety + net-out mapping (อิสระจากโปรโมชัน; ปิด hazard เดิมของส่วนลด manual ด้วย)
- `src/lib/pricing.ts` — **additive เท่านั้น**: เพิ่ม `lineNetSatang` (= `totals.lines[i].netSatang`) และ `lineDiscountSatang` (ค่า clamped) ใน `OrderLineResult` (map ที่ ~line 329-338); math ไม่แตะ; test เดิมต้องผ่านโดยไม่แก้ + เพิ่ม assert `Σ lineNetSatang === totalSatang`
- `src/lib/krs/salePayload.ts` — เพิ่มฟิลด์ (parse แบบ lenient ตาม precedent `warehouseCode` :156-164): item `lineNet: string|null` (null = legacy), `linePromoDiscount` default "0.00", `promotionName: string|null`; header `promoBillDiscount` default "0.00", `billPromotionName: string|null`; `discount` **คงความหมายรวมเดิม**; helper pure `salePayloadHasDiscount(p)` (discount>0 ∨ promoBillDiscount>0 ∨ มี line ที่ unitPrice×qty ≠ lineTotal)
- `src/app/api/orders/route.ts` (enqueue ~:810-823) — เลิก hardcode `lineDiscount:"0.00"` → ใส่ค่าจริงจาก `lineDiscountSatang` + ใส่ `lineNet`
- `src/lib/krs/writeback.ts` — Dtl bindings ตาม Money Contract (ลบ `TODO(line-discount)` :556-561); assertion block ใหม่ (integer satang, ก่อนเปิด connection → ไม่ burn anchor): assert เดิม `total === subtotal − discount` คงไว้; เพิ่ม `Σ net === total`, `0 ≤ net[i] ≤ gross[i]`, `total > 0`; legacy payload (`lineNet == null`): ถ้า discount รวม == 0 → `net := lineTotal` (เขียน byte-identical กับปัจจุบัน = no-regression property) มิฉะนั้น throw ให้ manual review
- `src/lib/env.ts` — เพิ่ม `KRS_DISCOUNT_WRITE_ENABLED` default `"false"` (ข้าง `KRS_OUTBOUND_ENABLED` :145)
- `src/lib/krs/dispatcher.ts` — gate **หลัง reclaim block (:462) ก่อน KRS WRITE (:464)** (ตำแหน่งสำคัญ: job ที่ commit แล้วต้อง recover เป็น SYNCED + advance snapshot ได้): flag off + `salePayloadHasDiscount` → requeue แบบไม่นับ attempt (pattern เดียวกับ :328), log `DISCOUNT_HELD`
- เอกสารใน `process/features/promotions/references/`: คำถาม vendor Q1-Q8 (Q-AMOUNT: KRS อ่าน `Amount` เป็นยอดสุดท้าย หรือมี report ที่คิด `Amount − DiscountAmount` ซ้ำ?; Q-HDR: header ต้องมี discount field ไหม + ขอ workbook ตัวอย่างบิลมีส่วนลด; Q-TAD `TaxAndDiscount`; Q-PCT percent=0 legal?; Q-GL journal net ok?; Q-VAT ฐาน net?; Q-ZERO บิล 0 บาท?; Remarks) + ขั้นตอน sandbox verification (test matrix 7 เคส + proof SELECTs cross-foot Hdr/Dtl/Journal/Tax — อยู่ใน proposal ของ agent, คัดลอกลง reference doc)
- **Rollout**: deploy → บิลมีส่วนลดถูก hold (PENDING) → sandbox test ผ่าน → owner flip flag เอง (agent ห้ามแตะ ตาม invariant เดิมของ krs-sync)

### Phase 2 — Prisma schema (additive migration เดียว `add_promotions`)
- enum `PromotionType { PRODUCT_DISCOUNT, FIXED_PRICE, BUY_X_GET_Y, BILL_THRESHOLD }`
- model `Promotion`: `id cuid`, `name` (ไทย — โชว์บนจอ+ใบเสร็จ), `code String? @unique`, `type`, `isActive @default(true)` (soft delete — DB role ไม่มี DELETE), `startsAt/endsAt DateTime?` (UTC instant; UI แปลงวัน กทม. → 00:00 กทม., end เป็น exclusive วันถัดไป ผ่าน helper ใน `src/lib/datetime.ts`), `branchId @default("BR-01")`, ฟิลด์ต่อ type: `percentOff Decimal(5,2)?`, `amountOffSatang Int?`, `fixedPriceSatang Int?`, `buyQty/getQty Int?`, `getDiscountPercent Int?`, `minSubtotalSatang Int?`, **`productIds String[] @default([])`** (ไม่ใช้ join table — DB role ไม่มี DELETE จะแก้ list ลำบาก; validate ตอน write; product ไม่มีวันถูก hard delete), timestamps, `@@index([isActive, startsAt, endsAt])`
- คอลัมน์ Order/OrderItem ตาม Money Contract (nullable/defaulted — zero backfill)
- `AuditAction` เพิ่ม: `PROMOTION_CREATED, PROMOTION_UPDATED, PROMOTION_ACTIVATED, PROMOTION_DEACTIVATED`

### Phase 3 — Pure engine + unit tests
- ใหม่ `src/lib/promotionEngine.ts` — isomorphic (ห้าม import Prisma/mssql/schemas) สไตล์ pricing.ts: types `ActivePromotion` (DTO satang ints — ปลอดภัยฝั่ง client), `applyPromotions(lines, promotions, manualBill) → PromotionApplication` ตามลำดับการคิดใน Money Contract; per-type: PRODUCT_DISCOUNT percent → round ระดับบรรทัด, amount → `min(amountOff×qty, gross)`; FIXED_PRICE → `max(price−fixed,0)×qty`; BUY_X_GET_Y → `floor(qty/(X+Y))×Y` หน่วยฟรี × `getDiscountPercent`; BILL_THRESHOLD amount/percent; clamp ทุกชั้น; **การกรองช่วงเวลา/isActive อยู่ที่ boundary การ fetch ไม่อยู่ใน engine** (pure, clock-free)
- ใหม่ `src/lib/promotionEngine.test.ts` (vitest): golden tables ทุก type (buy-2-แถม-1 ที่ qty 1/2/3/5/6/7; threshold ที่ =min, −1 satang, มี manual line discount เลื่อนเส้น), tie-break, clamp, parity property: `applyPromotions`+`computeTotals` (client path) === `applyPromotions`+`computeOrderTotals` (server path)

### Phase 4 — Auth guard + CRUD API
- `src/lib/auth.ts` — ใหม่ `requireStrictAdmin()` (เฉพาะ `Role.ADMIN`; 401/403 shape เดิม) — **ห้ามแก้ `isAdminRole`** (การ map MANAGER→admin เป็นการตัดสินใจระบบเดิม)
- ใหม่ `src/lib/schemas/promotion.ts` (NODE-ONLY, full Zod — กฎ wrap-only เป็นของ orders POST เท่านั้น): discriminated union ตาม type; เงิน = บาท + 2dp guard (`Math.round(v*100)===v*100`), percent ≤100, X/Y int ≥1, `productIds` min 1 max 200 (ยกเว้น BILL_THRESHOLD); PATCH schema ไม่มี `type` (**immutable** — เปลี่ยน type = ปิดตัวเก่าสร้างตัวใหม่)
- ใหม่ `src/app/api/promotions/route.ts`: `GET ?view=pos` → `requireUser`, คืนเฉพาะโปร effective ตอนนี้ (isActive + window) เป็น `ActivePromotion[]`; GET default → `requireStrictAdmin` (ทุกสถานะ + filter `?active=&type=`); `POST` → strict, coded guards: `BAD_DATE_WINDOW` (startsAt<endsAt), `UNKNOWN_PRODUCT` (422, findMany นับ), P2002 code → 409 `CODE_TAKEN`; audit post-commit
- ใหม่ `src/app/api/promotions/[id]/route.ts`: GET/PATCH strict; `isActive:false` = soft delete; ไม่มี DELETE handler
- Serialize: satang Int → ผ่าน JSON ตรง; `percentOff` → `Number()`; ไม่มี Decimal เงินใน DTO (หลบ pitfall trailing-zero)

### Phase 5 — Admin UI (/promotions)
- Strict-ADMIN plumbing: `src/lib/roleAccess.ts` (`promotions: ["admin"]` + `STRICT_ADMIN_NAV` set + `canAccessStrict()`), `src/auth.config.ts` (`PROTECTED_PREFIXES` + `/promotions` + authorized callback), `src/middleware.ts` (`canAccessStrict(navKey, appRole, role==="ADMIN")` — string compare, edge-safe), `src/components/RoleProvider.tsx` (`isStrictAdmin`), `src/components/AdminOnly.tsx` (prop `strict`), `src/components/NavRail.tsx` (item `โปรโมชัน` icon lucide `BadgePercent` ระหว่าง products/users + filter strict)
- ใหม่ `src/app/(shell)/promotions/page.tsx` (template: products page — header/search/filter pills/table card/toggle switch จาก settings :372 + confirm dialog ตอนปิดใช้งาน), `src/components/promotions/PromotionFormModal.tsx` (type selector 2×2 radio cards ล็อกตอน edit, dynamic fields ต่อ type, date inputs, mint family — **โปร = เขียวมิ้นต์ / manual discount = น้ำเงินเดิม ทั้งระบบ**), `PromotionProductPicker.tsx` (inline multi-select: search + checkbox list + mint pills), `promotionMeta.ts` (label/icon/summary formatter ใช้ร่วม admin↔POS)
- Thai microcopy ตามตาราง proposal ของ UI agent (มีครบใน task output — คัดลอกตอน execute)

### Phase 6 — Checkout integration (ไฟล์ sensitive สุด — ต้อง deploy หลัง Phase 1)
- `src/app/api/orders/route.ts`: fetch โปร effective **ก่อน `$transaction`** (pattern เดิมของ pre-tx reads); map → `ActivePromotion[]`; `applyPromotions` หลัง validate discount เดิม ก่อน `computeOrderTotals`; cross-check subtotal; persist คอลัมน์โปรใน nested `items.create` (ไม่มี query เพิ่ม); header promoBillDiscount/billPromotion*; salePayload ใส่ค่าโปรจริง; audit detail เพิ่มรายการโปร
- Client ส่งอะไรเพิ่ม: **ไม่ส่ง** — stale preview ถูกกันด้วย `PAYMENT_MISMATCH` (จำนวนจ่ายต้องตรงเป๊ะ) อยู่แล้ว; idempotent replay คืน order ที่ persist แล้ว (byte-identical) ไม่ recompute
- `src/lib/orderSerialize.ts`: เพิ่ม `promoDiscount` (item) + `promoBillDiscount`/`billPromotionName` (header) ใน 2dp map; `GET /api/orders/[id]` ได้ฟิลด์ตามด้วย (reprint)
- **รัน `pricing-tester` agent** หลังเฟสนี้ (invariants: subtotal−discount=total; Σ lineTotal=subtotal; promoBillDiscount≤discount≤subtotal; parity client/server; pricing.test.ts เดิมผ่านไม่แก้; PAYMENT_MISMATCH บน stale promo; replay identical)

### Phase 7 — POS cashier UI + ใบเสร็จ
- `src/app/(shell)/pos/page.tsx`: fetch `/api/promotions?view=pos` ตอน mount; memo `promoBadgeByProductId` (ProductCard เป็น React.memo — prop ต้อง stable); ขยาย totals memo (~:392) ด้วย engine; บน `PAYMENT_MISMATCH` → refetch โปร + recompute + toast "โปรโมชันมีการเปลี่ยนแปลง ยอดถูกคำนวณใหม่ กรุณาตรวจสอบ"
- `ProductCard.tsx`: pill โปร (มุมล่างซ้าย solid #11865a) — %/฿/fixed: ราคาขีดฆ่า + ราคาโปรเขียว; buy-X-get-Y: **ราคาปกติคงเดิม** โชว์แค่กติกา ("ซื้อ 3 แถม 1") เพราะราคา effective ขึ้นกับ qty; threshold ไม่มี badge บนการ์ด
- `CartLine.tsx`: chip โปรมิ้นต์ read-only (ชื่อ + −฿) แยกจาก chip น้ำเงิน manual; line net รวมโปร
- `TotalsBar.tsx`: แถว read-only "ส่วนลดโปรโมชัน" = **เฉพาะโปรระดับบิล** (โปรระดับบรรทัด net ใน subtotal แล้ว เหมือน manual line discount เดิม — เลขบนจอ foot: subtotal − โปรบิล − manual บิล = total); แถว hint threshold "ซื้อเพิ่มอีก ฿X ลดทันที ฿Y" (mint pill, โชว์ตัวใกล้สุดที่ยังไม่ถึง)
- `PaymentModal.tsx`: บรรทัด optional "รวมส่วนลดโปรโมชัน −฿X" (= โปรบรรทัด+บิลรวม, informational)
- `ReceiptModal.tsx` (template เดียวครอบทั้ง reprint/auto-print/agent raster): ใต้แต่ละ item → "โปร: {ชื่อ} −฿X"; บล็อกท้าย: ยอดรวม (subtotal) → ส่วนลดโปรท้ายบิล (ชื่อโปร) → ส่วนลดท้ายบิล (manual, >0 เท่านั้น) → รวมสุทธิ; บรรทัด "คุณประหยัดไป ฿X" (= ส่วนลดทั้งหมด gross−total); **ทดสอบ raster บิลยาวหลังเพิ่มบรรทัด** (agent path auto-height)

### Phase 8 — Z-report สรุปโปร
- `src/app/api/shift/route.ts`: aggregate **COMPLETED เท่านั้น** (กฎ money-aggregate เดิม), Decimal→string: ยอดโปรรวม (Σ `Order.promoBillDiscount` + Σ `OrderItem.promoDiscount`) + breakdown ต่อโปร (groupBy `promotionId`/`billPromotionId` + name + จำนวนบิล + ยอดลด)
- Shift UI: การ์ด "ส่วนลดโปรโมชัน" แยกจากส่วนลด manual + รายการต่อโปร

### Closeout — UPDATE PROCESS
Context updates: `process/context/all-context.md` (features list, routing), `process/context/database/all-database.md` (Promotion model + คอลัมน์ Order/OrderItem), krs-sync backlog #2 → mark addressed + อ้าง flag ใหม่; memory: สถานะ promotions program

---

## Public Contracts
- `GET /api/promotions?view=pos` (requireUser) → `ActivePromotion[]` (satang ints; เฉพาะ effective)
- `POST /api/orders` response + `GET /api/orders/[id]` → เพิ่ม `promoDiscount` ต่อ item, `promoBillDiscount`, `billPromotionName` (2dp strings)
- `SalePayload` v-next: additive + lenient (legacy jobs ใน queue dispatch ต่อได้; ไม่มี version field — discriminate ด้วย field presence)
- Env ใหม่: `KRS_DISCOUNT_WRITE_ENABLED` (default false; owner flip เอง) + เพิ่มใน `.env.example`
- Invariant คงเดิม: `subtotal − discount === total`; ใหม่: `Σ lineNet === total`, `promoBillDiscount ≤ discount`

## Blast Radius
- **สูงสุด**: `src/app/api/orders/route.ts` (checkout), `src/lib/krs/writeback.ts` (เขียน ERP จริง — มี no-regression property: บิลไม่มีส่วนลด → insert byte-identical), `src/lib/pricing.ts` (additive output เท่านั้น)
- **กลาง**: dispatcher (gate ใหม่ — วางผิดตำแหน่ง = stock double-count), salePayload/orderSerialize, middleware/roleAccess (พลาด = MANAGER เข้าหน้า promotions ได้)
- **ต่ำ**: หน้า UI ใหม่, schema additive, engine pure ใหม่
- ไม่แตะ: Hdr/Journal/Tax inserts, inbound sync, stock decrement, idempotency กลไกเดิม, `isAdminRole`

## Verification Evidence (ต่อเฟส)
1. P1: `npm test` (pricing เดิมผ่านไม่แก้); manual-discount bill ใน dev → job HELD; flag on ใน sandbox → proof SELECTs ผ่าน 7 เคส; บิลไม่มีส่วนลด → insert เทียบ byte เดิม
2. P2: `prisma migrate dev` สะอาด; `npm run build`
3. P3: `npm test` engine golden tables + parity
4. P4: curl ทดสอบ: CASHIER เรียก `?view=pos` ได้/mutation 403; MANAGER mutation 403; validation codes ครบ
5. P5: MANAGER session เด้งจาก `/promotions` **ทั้ง middleware และ client**; nav ไม่โชว์
6. P6: `pricing-tester` agent + `/verify`; ทดสอบ 4 type + ซ้อน manual + stale-promo → PAYMENT_MISMATCH + replay identical
7. P7: `/smoke` flow ขายจริง; ใบเสร็จ raster บิลยาว; badge/chip ครบ 4 type
8. P8: Z-report กะที่มี REFUNDED/VOIDED → ยอดโปรนับเฉพาะ COMPLETED

## Resume / Execution Handoff
- เฟสเรียงตาม dependency; แต่ละเฟส shippable เดี่ยว; **ข้อบังคับ deploy: Phase 1 ขึ้น prod ก่อน Phase 6** (outbound live อยู่ — ห้ามให้บิลโปรเจอ mapping เก่า)
- Proposal ละเอียดฉบับเต็ม 3 ฉบับ (domain/KRS/UI) อยู่ใน task outputs ของ session นี้ — สาระสำคัญถูก merge ในไฟล์นี้แล้ว; Money Contract ในไฟล์นี้เป็น**ตัวชี้ขาด**เมื่อขัดกัน (เปลี่ยนจาก proposal: `Order.discount` = รวมโปร+manual, `SalePayload.discount` คงความหมายรวม → writeback assert เดิมไม่แก้)
- คำถาม vendor Q1-Q8 ส่งได้ทันทีหลัง Phase 1 (ไม่ block เฟสอื่น — flag ค้าง false จน sandbox ผ่าน)
- Commit แยกเฟส `type(scope): summary`; push ต้อง `gh auth switch --user innovera2025`

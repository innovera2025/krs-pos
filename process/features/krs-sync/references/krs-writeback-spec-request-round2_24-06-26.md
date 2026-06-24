# คำขอข้อมูลเพิ่มเติม (รอบ 2) — เขียนการขายสด + ตัดสต็อกกลับเข้า KRS

**ถึง:** ทีมผู้พัฒนา/ผู้ดูแลระบบ KRS · **จาก:** ทีมพัฒนา KRS POS · **วันที่:** 24/06/2026
**อ้างอิง:** คำขอรอบ 1 (`krs-writeback-spec-request_23-06-26.md`) + การวิเคราะห์ฟิลด์ (`krs-writeback-field-analysis_24-06-26.md`)

ขอบคุณสำหรับชุดคำสั่ง INSERT (ยืนยันชำระเงินขายสด + ตัดสต็อก) — ชัดเจนมากครับ เราเข้าใจว่า 1 บิลขายสด = เขียน 5 ตารางใน transaction เดียว (`RunningNumber` → `SalesInvoiceHdr` → `SalesInvoiceDtl` → `InventoryFlowHdr` → `InventoryFlowDtl`) ผูกด้วย `TransactionNo`

**ฝั่ง POS เตรียมส่งได้แล้ว (~70%):** ItemCode, Description, MainQuantity, UnitPrice, Amount, ส่วนลดรายบรรทัด, TotalAmount/SubTotalAmnt/VATAmount/VATPercent(7)/DiscountAmount/CashValue/TotalMainQty, วันที่, cashier, BranchCode/Name, เลขบิล POS (สำหรับ trace/กันซ้ำ)

เหลือ **11 จุด** ที่ต้องรบกวนยืนยันเพื่อให้เขียนได้ถูกต้องและไม่ทำบัญชีเสียหาย:

---

## ส่วนบัญชี (สำคัญสุด)
**1. GL Journals (`*Jnl`)** — `ARAPJnl, RevenueJnl, CostOfSaleJnl, InventoryJnl, VATJnl, DiscountJnl, AccountsDescription, ChargeOrDiscountAccount`
- รูปแบบสตริง/โครงสร้างของแต่ละ journal เป็นอย่างไร (ขอ **ตัวอย่างจริง 1 บิล**)?
- **POS ต้องคำนวณ/ส่งเอง หรือ KRS สร้างให้** จากข้อมูลบิล?
- รหัสบัญชีที่ใช้ (เงินสด / รายได้ขาย / ภาษีขาย / สินค้าคงคลัง / ต้นทุนขาย)?

**2. ต้นทุนขาย (COGS)** — `CostOfSaleJnl` ต้องใช้ "ต้นทุน" แต่ POS เก็บแค่ราคาขาย (`Saleprice1`) ไม่มีต้นทุน
- **KRS คำนวณ COGS เองจากระบบต้นทุนใช่ไหม?** (ถ้าใช่ POS ไม่ต้องส่งต้นทุน) ถ้าต้อง POS ส่ง — ใช้ต้นทุนจากไหน?

**8. รหัสบัญชี/องค์กร** — `CompanyCode, DeptCode, Department, AccountCode` ใส่ค่าอะไร (ค่าคงที่ของร้าน)?

## ค่าคงที่ (codes/enums)
**3.** ค่าที่ต้องใส่สำหรับ **"ขายสด"** และ **"ตัดสต็อกจากการขาย"**:
`InvoiceType, SaleType, ItemType, TransactionTypeI, TransactionTypeT, DocuType` (ฝั่ง SalesInvoice) ·
`SourceType` (SalesInvoiceDtl) · `TransactionType, ReasonIndex, ReasonName` (InventoryFlow Hdr/Dtl) ·
`IsClosed` ของบิลขายที่ชำระแล้ว, `IsUndueVAT`

## เลขเอกสาร / การลิงก์
**4. RunningNumber** — `Name` key ที่ใช้ (SalesInvoice กับ InventoryFlow ใช้คนละ key ไหม) · รูปแบบเลข (เช่น `ORCM6906xxxxxx`) · **วิธี increment ให้ไม่ชนกันเมื่อขายพร้อมกัน** (lock/transaction ที่แนะนำ)?

**5. TransactionNo** — ใครออก / ออกอย่างไร (ค่าที่ผูกทั้ง 5 ตาราง)?

**6. ฟิลด์ลิงก์ระหว่างตาราง** — ค่าที่ต้องใส่ใน:
`InventoryFlowHdr.SalesInvoiceTrNo / SalesInvoiceNo` · `SalesInvoiceDtl.FlowNo / FlowTrNo` · `OrderNo/OrderTrNo` · `SONo/SOTrNo` (เราไม่มีใบสั่งขาย SO — เว้นว่างได้ไหม?)

## ความปลอดภัย/ความถูกต้อง
**7. กันลงซ้ำ (Idempotency)** — POS จะ retry อัตโนมัติเมื่อเน็ตสะดุด ต้องมีจุดกันลงซ้ำ
- เก็บ **เลขบิล POS** ไว้ที่ฟิลด์ไหน (เช่น `Remarks`) เพื่อเช็คก่อนลงว่าบิลนี้ลงไปแล้วหรือยัง?
- หรือ KRS มีกลไกกันซ้ำของตัวเอง?

**9. Warehouse** — รหัสคลังสำหรับตัดสต็อกขายหน้าร้าน = `WHFG` ใช่ไหม? (มีหลายคลังไหม)

**10. หน่วยนับ + VAT ในราคา** — `MainUnits` ดึงจากคอลัมน์ไหนใน `InventoryItem`? · `UnitPrice`/`Amount` ที่ต้องส่ง = **รวม VAT หรือก่อน VAT**? (POS เก็บราคารวม VAT)

**11. Sandbox (บังคับก่อน go-live)** — ขอ **ฐานทดสอบแยกจากของจริง + บัญชีผู้ใช้สิทธิ์จำกัด** (อ่าน InventoryItem/sp_Onhand + เขียน 5 ตารางนี้เท่านั้น) เราจะ **ไม่เขียนใดๆ บน production จนกว่าจะ verify ครบบน sandbox**

---

## สิ่งที่ฝั่ง POS รับประกัน
- เขียนผ่าน **5 INSERT นี้ใน 1 transaction** (parameterized ตามที่ให้มา) — ไม่แก้โครงสร้าง KRS
- **กันซ้ำทุกบิล** + retry ปลอดภัย · **fail-open** (KRS ล่ม → การขายไม่สะดุด ค้างไว้ส่งใหม่)
- ตั้ง `Approved=1, IsClosed=0` ใน InventoryFlow เพื่อให้ `sp_Onhand` นับยอดตรง
- ทดสอบบน **sandbox** จนครบก่อนเปิดจริง

> ขอตอบเป็นข้อ (1-11) + ตัวอย่างจริง 1 บิล (ทั้ง 5 ตาราง พร้อมค่าจริง) จะช่วยให้เรา map ได้แม่นที่สุดครับ

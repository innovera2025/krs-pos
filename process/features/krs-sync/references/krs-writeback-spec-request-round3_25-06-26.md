# คำขอข้อมูลเพิ่มเติม (รอบ 3 — จุดสุดท้าย) — ฝั่งตัดสต็อก (InventoryFlow)

**ถึง:** ทีมผู้พัฒนา/ผู้ดูแลระบบ KRS · **จาก:** ทีมพัฒนา KRS POS · **วันที่:** 25/06/2026
**อ้างอิง:** ไฟล์ที่ส่งมาแล้ว — `Insertขายสด.txt`, `ขายสด-gl.txt`, `osl.txt`, และตัวอย่าง `ขายสด.xlsx`

ขอบคุณมากครับ — จากไฟล์ + ตัวอย่าง xlsx (ขายสด F01-0001 ×10 = 100 บาท) เราได้ข้อมูลฝั่ง **บิลขาย (SalesInvoice) + ลงบัญชี (TheJournal)** ครบแล้ว และยืนยันได้ว่า:
- ✅ ฟิลด์ + ค่าคงที่ของ SalesInvoiceHdr/Dtl (InvoiceType=Local, SaleType=Invoice, ItemType=Item, DocuType=SC, CompanyCode=SNP, IsVAT=2, ลูกค้า C0001, บัญชีบรรทัด 4110-00 ฯลฯ)
- ✅ GL 3 บรรทัด (DR เงินสด `Assets3` / CR รายได้ `Revenues2` / CR ภาษีขาย `Liabilities4`)
- ✅ ราคารวม VAT (100 = 93.46 + 6.54), COGS ให้ KRS คำนวณเอง, ใช้ BEGIN TRAN/COMMIT
- ✅ เลขเอกสาร `SC-2606-0001`, RunningNumber keys (`SaleInvoiceTrNo`/`SC`+YYMM/`InventoryFlow`/`IBG`+YYMM/`Receipt`)

**เหลือเฉพาะฝั่ง "ตัดสต็อก" (`InventoryFlowHdr`/`InventoryFlowDtl`)** ที่ตัวอย่าง xlsx ยังไม่มี — รบกวนยืนยัน 4 จุดนี้ครับ:

---

### 1. ค่าคงที่ของเอกสารตัดสต็อก (สำหรับ "ตัดออกจากการขาย")
ขอค่าที่ต้องใส่ใน `InventoryFlowHdr` / `InventoryFlowDtl`:
- `TransactionType` = ?
- `ReasonIndex` = ?  · `ReasonName` = ? (ของเราเดาไว้ "ตัดออกจากการขาย" — ถูกไหม)
- `IncludeVat` = ?
- `DeptCode` / `Department` = ? (เดาว่า `SAL`)
- `IsStock` / `IsAssetForm` = ? (เราตั้ง `Approved=1`, `IsClosed=0`, `InOut=-1` เพื่อให้ `sp_Onhand` นับยอด — ถูกไหม)

### 2. รหัสคลัง (Warehouse)
- `InventoryFlowDtl.Warehouse` สำหรับตัดสต็อกขายหน้าร้าน = `WHFG` ใช่ไหมครับ? (มีหลายคลังไหม)

### 3. หน่วยนับสินค้า (MainUnits)
- ตัวอย่างเห็น `MainUnits = "ซอง"` (ต่อสินค้า) แต่ฝั่ง POS ไม่ได้เก็บหน่วยนับ
- รบกวนบอกว่า **หน่วยนับมาจากคอลัมน์ไหนใน `InventoryItem`** (เช่น `MainUnit`/`Unit`/`SaleUnit`?) — เราจะดึงมาตอน import สินค้า เพื่อส่งหน่วยให้ถูกต่อรายการ

### 4. (เล็กน้อย) เลขเอกสาร flow + JnlName
- รูปแบบเลข voucher ของ InventoryFlow (จาก key `IBG`+YYMM) = `IBG-2606-XXXX` ใช่ไหม
- ค่า `JnlName` ใน `TheJournal` ใส่อะไร (เราเดา = `Receipt`)

---

## 🎯 ขอแบบที่ช่วยได้มากสุด
**ขอตัวอย่างจริง 1 รายการของการตัดสต็อกขาย** — `InventoryFlowHdr` + `InventoryFlowDtl` พร้อมค่าจริง (แบบเดียวกับ `ขายสด.xlsx` ที่ให้มา) → เราจะ map ได้ 100% ไม่ต้องเดาเลย

> ได้ครบแล้วเราจะ **ทดลองเขียนกลับลงฐานทดสอบ `db_ACC_SNP`** (ตามที่อนุมัติให้ทดสอบ) แล้วเช็คยอดผ่าน `sp_Onhand` ว่าตัดสต็อกถูกต้อง ก่อนเปิดใช้จริง

# คำขอเปิด Change Tracking (P0.2) + ผลตรวจสอบ P0.1 — realtime inbound sync

- Program: `process/features/krs-sync/active/krs-realtime-inbound_PLAN_16-07-26.md`
- Status: **P0.1 discovery PASSED 16-07-26** (ผลแนบท้าย) · **P0.2 letter — ready to send, awaiting vendor**
- ส่งได้พร้อมชุดคำถามค้างเดิม: Q1-Q8 (ส่วนลด, `krs-discount-writeback-contract_14-07-26.md`) + Q9 (sp_Onhand, `krs-onhand-global-discrepancy_REPORT_15-07-26.md`)

---

## จดหมายถึง vendor (พร้อมส่ง)

เอกสารขอเปิดใช้ Change Tracking (CT) — ซิงค์สต็อกแบบเรียลไทม์จาก KRS เข้า POS

ถึง: ทีมผู้พัฒนา/ผู้ดูแลระบบ KRS (db_ACC_SNP)
จาก: ทีมพัฒนา KRS POS (ระบบขายหน้าร้าน)
เรื่อง: ขอเปิดใช้ SQL Server Change Tracking (อ่านอย่างเดียว ไม่กระทบข้อมูล/แอปฝั่งบัญชี)

บริบท: ปัจจุบัน POS ดึงสต็อกจาก KRS ทุก 60-80 วินาทีผ่าน sp_Onhand (แบบ warehouse-scoped เท่านั้น
ตามที่ตกลงไว้ก่อนหน้า — ไม่ใช้ค่ารวมทุกคลัง @Warehouse=NULL ซึ่งพบว่าให้ผลผิดพลาดใน 667 รายการ
ดูคำถาม Q9 ที่ส่งมาพร้อมกัน). เราต้องการลดเวลานี้ลงเหลือ 1-5 วินาที โดยใช้ฟีเจอร์ "Change Tracking"
ของ SQL Server ซึ่ง:
  - เป็นฟีเจอร์มาตรฐานในตัว SQL Server (เราตรวจแล้วเซิร์ฟเวอร์เป็น SQL Server 2019 Enterprise
    — รองรับเต็มรูปแบบ และฐานข้อมูลปัจจุบันมีขนาดเพียง ~72 MB ภาระเพิ่มจาก CT จึงต่ำมาก)
  - เป็นการอ่านอย่างเดียวฝั่งเรา — สิ่งที่ต้องทำฝั่ง KRS คือเปิดใช้งาน (ALTER DATABASE/ALTER TABLE)
    ไม่มีการเปลี่ยนโครงสร้างตารางเดิม ไม่มีคอลัมน์ใหม่ ไม่กระทบแอปบัญชีที่ใช้อยู่

คำขอ (โปรดตอบ/ดำเนินการเป็นข้อ):

1. เปิด Change Tracking ระดับฐานข้อมูล (รันครั้งเดียว):
   ALTER DATABASE db_ACC_SNP
     SET CHANGE_TRACKING = ON (CHANGE_RETENTION = 3 DAYS, AUTO_CLEANUP = ON);
   - เราตรวจสอบแล้ว (16-07-26): ฐานข้อมูลนี้ยังไม่เคยเปิด Change Tracking จึงไม่มี retention
     ของระบบอื่นให้ชนกัน

2. เปิด Change Tracking ระดับตาราง บน 3 ตาราง:
   ALTER TABLE dbo.InventoryFlowDtl ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF);
   ALTER TABLE dbo.InventoryFlowHdr ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = ON);
   ALTER TABLE dbo.InventoryItem    ENABLE CHANGE_TRACKING WITH (TRACK_COLUMNS_UPDATED = OFF);
   (Hdr ใช้ TRACK_COLUMNS_UPDATED = ON เผื่อในอนาคตเราต้องกรองเฉพาะการเปลี่ยนที่ Approved/IsClosed
   จริงๆ — ไม่บังคับสำหรับเวอร์ชันแรก)
   - เราตรวจสอบแล้ว: ทั้ง 3 ตารางมี PRIMARY KEY ครบตามที่ Change Tracking ต้องการ (ผลแนบท้าย)

3. สิทธิ์อ่าน Change Tracking ให้บัญชีที่ POS ใช้เชื่อมต่อ:
   GRANT VIEW CHANGE TRACKING ON dbo.InventoryFlowDtl TO <บัญชีที่ POS ใช้เชื่อมต่อ>;
   GRANT VIEW CHANGE TRACKING ON dbo.InventoryFlowHdr TO <บัญชีที่ POS ใช้เชื่อมต่อ>;
   GRANT VIEW CHANGE TRACKING ON dbo.InventoryItem    TO <บัญชีที่ POS ใช้เชื่อมต่อ>;
   - โปรดยืนยัน username ของบัญชีที่ใช้เชื่อมต่อจริงในปัจจุบัน (ถ้าเป็นบัญชีสิทธิ์สูงอยู่แล้ว
     อาจไม่จำเป็นต้อง GRANT เพิ่ม แต่ขอให้ยืนยันเพื่อความชัดเจน)

4. คำถามประกอบ (ช่วยให้เราวางแผนการตรวจจับการเปลี่ยนแปลงได้ถูกต้อง):
   - ตาราง dbo.InventoryFlowDtl / dbo.InventoryFlowHdr เคยมีการ DELETE แถวจริงหรือไม่ หรือการ
     "กลับรายการ" ทำผ่านเอกสารใหม่เสมอ (ไม่ลบของเดิม)?

5. ยืนยันว่าไม่มีผลกระทบต่อแอปบัญชี/ผู้ใช้ปัจจุบันของ KRS — Change Tracking ไม่เปลี่ยนพฤติกรรมการ
   query/insert/update ปกติของตารางเดิมแต่อย่างใด เป็นเพียงตารางบันทึกการเปลี่ยนแปลงเสริมภายใน
   SQL Server engine เอง

ความปลอดภัย: ฝั่ง POS จะอ่านอย่างเดียว (CHANGETABLE(CHANGES ...) + sp_Onhand แบบ warehouse-scoped
เดิม) ไม่มีการ INSERT/UPDATE/DELETE ใดๆ เข้าตารางของ KRS จากคำขอนี้

---

## ภาคผนวก: ผลตรวจสอบ P0.1 (รัน 16-07-26, read-only, script: `scripts/krs-ct-precheck.cjs`)

1. **Edition**: `Enterprise Edition (64-bit)`, EngineEdition 3, ProductVersion **15.0.2155.2 (SQL Server 2019)**
   — โน้ต: แผนเดิมตั้งสมมติฐานจากชื่อ instance `\SQLEXPRESS` ว่าเป็น Express; ของจริงคือ Enterprise
   → ข้อจำกัด 10GB/ไม่มี Agent หายไป (CDC เป็นไปได้ทางเทคนิค แต่ยังเลือก CT เพราะเบากว่าและ
   ไม่ต้องพึ่ง SQL Server Agent บนเครื่อง vendor)
2. **IsChangeTrackingEnabled = 0**; `sys.change_tracking_databases` / `sys.change_tracking_tables` ว่าง
   → ยังไม่มีใครใช้ CT บน DB นี้
3. **Primary keys (ครบทั้ง 3 ตาราง — ด่าน hard blocker ผ่าน):**
   - `dbo.InventoryFlowDtl`: PK = (RowOrder, TransactionNo, Number)
   - `dbo.InventoryFlowHdr`: PK = (Roworder, TransactionNo)
   - `dbo.InventoryItem`: PK = (Roworder, ItemCode)
   → ใช้เป็น JOIN predicate ของ `CHANGETABLE(CHANGES ...)` ใน P1 ได้โดยตรง; หมายเหตุ P1:
   `InventoryItem` มี PK ซ้อน (Roworder, ItemCode) — mapping ไป POS ใช้ ItemCode (= Product.sku)
   เป็นกุญแจธุรกิจตามเดิม
4. **ขนาด DB**: 72.25 MB (data 44 MB, index 5 MB) — ภาระ CT ต่ำมาก

**Gate ที่เหลือก่อนเริ่ม P1:** คำยืนยันจาก vendor ตามข้อ 1-3 (+ คำตอบข้อ 4) — บันทึกคำตอบลงไฟล์นี้เมื่อได้รับ

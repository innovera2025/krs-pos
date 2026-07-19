# รายงาน: เปิดใช้ discount writeback จริง + ระบายบิลค้างครบ (19-07-26)

## สรุปเหตุการณ์

| เวลา (19-07-26) | เหตุการณ์ |
|---|---|
| เวนเดอร์ตอบคำถาม | ยืนยันโมเดล: ส่วนลดรายการ → `SalesInvoiceDtl.DiscountAmount`, ส่วนลดท้ายบิล → `SalesInvoiceHdr.DiscountAmount`, GL/VAT ลงยอดสุทธิ ไม่แยกบัญชีตาม tender, อนุญาตทดสอบบน live DB |
| `ff2ad4c` | ปรับ `writeback.ts` จาก net-out allocation → **header/line discount split** ตามเวนเดอร์ (Dtl.Amount = lineTotal, Dtl.DiscountAmount = gross−lineTotal คำนวณเอง, Hdr.DiscountAmount = ส่วนลดท้ายบิลรวม) + assertion ชุดใหม่ + addendum ในสัญญา |
| `c39c5b8` | สคริปต์พิสูจน์ read-only `scripts/krs-discount-proof.cjs` (ตรวจ identity ทุกบิล POS ใน KRS) |
| Deploy + gate | `krs-hdr-fields-discovery.cjs` ยืนยัน `SalesInvoiceHdr.DiscountAmount` (decimal, nullable) มีจริงฝั่ง KRS |
| Owner เปิด flag | `KRS_DISCOUNT_WRITE_ENABLED=true` ใน `.env` + recreate app |
| ~10 นาทีต่อมา | **SyncJob SALE ทั้งหมด 93 ใบ = SYNCED** (ศูนย์ PENDING/FAILED) |

## ผลพิสูจน์ (krs-discount-proof.cjs, 60 บิลล่าสุด)

- **33 บิลมีส่วนลด, 0 FAILED** — สมการยึดครบทุกใบ:
  - `Σ Dtl.Amount − Hdr.DiscountAmount == Hdr.TotalAmount`
  - `SubTotalAmnt + VATAmount == TotalAmount` (VAT บนยอดสุทธิ ไม่เปลี่ยน)
- ครอบคลุม 3 รูปแบบบนบิลจริง:
  - **ลดรายการอย่างเดียว** เช่น SC-2607-0080 (ΣlineDisc 20.00, hdrDisc 0)
  - **ลดท้ายบิลอย่างเดียว** เช่น SC-2607-0076 (hdrDisc 40.00: 186−40=146 ✓), SC-2607-0072, SC-2607-0065
  - **ผสม** เช่น SC-2607-0063 (line 20 + bill 40, 19 บรรทัด), SC-2607-0077 (line 22 + bill 6, 6 บรรทัด), SC-2607-0057 (line 56 + bill 15, 12 บรรทัด)
- บิลไม่มีส่วนลด (OK 27 ใบ) เขียนเหมือนเดิม byte-identical — no-regression ยืนยันบนของจริง

## บิลที่ระบายเข้า ERP รอบเปิด flag

**SC-2607-0048 → SC-2607-0080 (33 ใบต่อเนื่อง)** — เป็น**ยอดขายจริง**ของร้านช่วง 15–19/07 ที่ระบบกักไว้ (DISCOUNT_HELD) ระหว่างรอคำตอบเวนเดอร์ **ไม่ใช่บิลทดสอบปลอม**:
- ไม่มีข้อมูลทดสอบให้เวนเดอร์ต้องลบ
- สต็อกที่ตัด (InventoryFlow OSL) เป็นการขายจริง ถูกต้อง ไม่ต้อง reverse
- เงื่อนไขเวนเดอร์ ("stock ทดสอบต้องลบ + แจ้งรายการ") ปิดด้วยการแจ้งรายการนี้ + ยืนยันว่าเป็นยอดจริง

หมายเหตุ: บิลที่มีส่วนลด**โปรโมชัน**ยังไม่มีของจริง (ลูกค้ายังไม่ใช้โปร) — แต่ payload โปรใช้ field ชุดเดียวกับส่วนลด manual (fold ใน lineTotal/discount) จึงพิสูจน์แล้วโดยโครงสร้าง

## สถานะปลายทาง

- `KRS_DISCOUNT_WRITE_ENABLED=true` **LIVE บน prod** — บิลส่วนลด/โปรโมชันเข้า ERP realtime เหมือนบิลปกติแล้ว
- Q-AMOUNT / Q-HDR / Q-GL / Q-VAT: **CLOSED** — เหลือเปิด: Q-TAD (TaxAndDiscount), Q-PCT (percent=0 — ship ตามนี้แล้ว เวนเดอร์สาธิตแบบ amount เอง), Q-ZERO (บิล 0 บาท — POS ยังกันไว้), Q-REMARKS
- Dispatcher `DISCOUNT_HELD` gate ยังอยู่ในโค้ด (dormant เมื่อ flag = true) — ปิด flag เมื่อไหร่ก็กลับไปกักได้ทันที

/**
 * Static field-map + account-mapping data for the KRS Data Link Field Mapping tab,
 * transcribed verbatim from the Simple POS source-of-truth (mapOut / mapIn /
 * productMap / paymentMap / taxMap / inventoryMap). These are UI display constants
 * (decision D) — there is no field-mapping CRUD in Phase 6b. The two `ok:false`
 * rows (vat_code, DS-001) + the unmapped e-Wallet are what the 2 FAILED seed jobs
 * represent (domain-mapping-blocks-sync surfaced as a warning, not a runtime gate).
 */

export type MapOutRow = {
  pos: string;
  krs: string;
  type: string;
  note: string;
  ok: boolean;
};

export const MAP_OUT: MapOutRow[] = [
  { pos: "pos_no", krs: "sales.ref_no", type: "string", note: "คีย์อ้างอิงบิล", ok: true },
  { pos: "total", krs: "sales.grand_total", type: "decimal(12,2)", note: "ยอดสุทธิรวม VAT", ok: true },
  { pos: "vat", krs: "sales.tax_amount", type: "decimal(12,2)", note: "ภาษีมูลค่าเพิ่ม", ok: true },
  { pos: "pay_method", krs: "sales.payment_type", type: "enum", note: "วิธีชำระเงิน", ok: true },
  { pos: "sku", krs: "stock_movements.item_code", type: "string", note: "รหัสสินค้า", ok: true },
  { pos: "qty", krs: "stock_movements.qty_delta", type: "int", note: "จำนวนเคลื่อนไหว", ok: true },
  { pos: "vat_code", krs: "sales.tax_code", type: "string", note: "รหัสภาษีขาย", ok: false },
];

export type MapInRow = {
  krs: string;
  pos: string;
  type: string;
  note: string;
};

export const MAP_IN: MapInRow[] = [
  { krs: "products.item_code", pos: "sku", type: "string", note: "รหัสสินค้า" },
  { krs: "products.name_th", pos: "name", type: "string", note: "ชื่อสินค้า (ไทย)" },
  { krs: "price_list.unit_price", pos: "price", type: "decimal(10,2)", note: "ราคาขายล่าสุด" },
  { krs: "products.vat_rate", pos: "vat", type: "int", note: "อัตราภาษี %" },
  { krs: "stock_balance.on_hand", pos: "stock", type: "int", note: "ยอดคงเหลือเรียลไทม์" },
  { krs: "customers.tax_id", pos: "customer.taxId", type: "string", note: "เลขผู้เสียภาษี" },
];

export type ProductMapRow = {
  sku: string;
  name: string;
  cat: string;
  acct: string;
  tax: string;
  ok: boolean;
};

export const PRODUCT_MAP: ProductMapRow[] = [
  { sku: "BV-001", name: "อเมริกาโน่ (ร้อน)", cat: "เครื่องดื่ม", acct: "4000 · รายได้จากการขาย", tax: "VAT 7%", ok: true },
  { sku: "FD-001", name: "ครัวซองต์แฮมชีส", cat: "อาหาร", acct: "4000 · รายได้จากการขาย", tax: "VAT 7%", ok: true },
  { sku: "GD-001", name: "เมล็ดกาแฟคั่ว 250g", cat: "ของใช้", acct: "4010 · รายได้สินค้า", tax: "VAT 7%", ok: true },
  { sku: "DS-001", name: "บราวนี่", cat: "ของหวาน", acct: "— ยังไม่ผูก —", tax: "VAT 7%", ok: false },
];

export type PaymentMapRow = { method: string; acct: string; ok: boolean };

export const PAYMENT_MAP: PaymentMapRow[] = [
  { method: "เงินสด", acct: "1010 · เงินสด", ok: true },
  { method: "QR PromptPay", acct: "1020 · ธ.กสิกร (พักรับโอน)", ok: true },
  { method: "โอนเงิน", acct: "1020 · ธ.กสิกร", ok: true },
  { method: "บัตรเครดิต", acct: "1030 · พักบัตรเครดิต", ok: true },
  { method: "e-Wallet", acct: "— ยังไม่ผูก —", ok: false },
];

export type GlMapRow = { left: string; right: string };

export const TAX_MAP: GlMapRow[] = [
  { left: "VAT 7%", right: "OUTPUT-VAT-7 · ภาษีขาย 7%" },
  { left: "VAT 0%", right: "OUTPUT-VAT-0 · ภาษีขาย 0%" },
  { left: "ยกเว้น VAT", right: "NON-VAT" },
];

export const INVENTORY_MAP: GlMapRow[] = [
  { left: "สินค้าคงคลัง (สินทรัพย์)", right: "1510 · Inventory asset" },
  { left: "ต้นทุนขาย · COGS", right: "5000 · Cost of goods sold" },
  { left: "ของเสีย/ปรับสต็อก", right: "5090 · Stock adjustment" },
  { left: "พักรับสินค้า (GRN)", right: "2150 · Goods received not invoiced" },
];

/** The outbound table has an unmapped field (vat_code) → incomplete badge/banner. */
export const MAP_OUT_INCOMPLETE = MAP_OUT.some((r) => !r.ok);

/** Account-mapping is incomplete (DS-001 + e-Wallet unmapped) → warning banner. */
export const MAPPING_INCOMPLETE =
  PRODUCT_MAP.some((r) => !r.ok) || PAYMENT_MAP.some((r) => !r.ok);

export type SyncModeDef = {
  key: "realtime" | "daily" | "manual";
  label: string;
  en: string;
  desc: string;
};

export const SYNC_MODE_DEFS: SyncModeDef[] = [
  {
    key: "realtime",
    label: "รายบิลทันที",
    en: "Realtime",
    desc: "ส่งทุกบิลเข้าบัญชีทันที — เหมาะกับร้านที่ออกใบกำกับภาษีบ่อย",
  },
  {
    key: "daily",
    label: "สรุปรายวัน",
    en: "Daily summary",
    desc: "รวมยอดทั้งวันเป็นเอกสารเดียว (ค่าเริ่มต้น) — ลดจำนวนเอกสาร",
  },
  {
    key: "manual",
    label: "แมนนวล",
    en: "Manual",
    desc: "ส่งเมื่อกดเองเท่านั้น — ควบคุมเต็มที่",
  },
];

export type StockMethodDef = {
  key: "perpetual" | "periodic";
  label: string;
  en: string;
  desc: string;
};

export const STOCK_METHOD_DEFS: StockMethodDef[] = [
  {
    key: "perpetual",
    label: "ต่อเนื่อง",
    en: "Perpetual",
    desc: "ลงต้นทุนขาย (COGS) อัตโนมัติทุกบิลที่ขาย — สต็อกในบัญชีตรงเรียลไทม์",
  },
  {
    key: "periodic",
    label: "เป็นงวด",
    en: "Periodic",
    desc: "ปรับมูลค่าสต็อกตอนปิดรอบ/สิ้นเดือน — เอกสารน้อยกว่า",
  },
];

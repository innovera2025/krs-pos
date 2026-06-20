/**
 * Static content for the admin Design Spec docs hub (Phase 6c).
 *
 * Transcribed FAITHFULLY from the Simple POS source-of-truth
 * (design/Simple POS.dc.html, data arrays lines 1794–1882). The docs hub is a
 * *design document*, not a live mirror of the built app — some entries are
 * roadmap/aspirational (e.g. the IndexedDB sync-queue impl notes, or component
 * names like <CartItem/> / <CustomerSelector/> that the build later named
 * CartLine / CustomerPickerModal). Per Phase 6c decision B these are kept AS
 * DOCUMENTED — do NOT rewrite them to match the current code.
 *
 * STATIC ONLY: there is no API/DB/schema behind this — these are display
 * constants rendered by the per-panel components in src/components/docs/.
 */

export type DocTabKey =
  | "overview"
  | "ia"
  | "flows"
  | "screens"
  | "components"
  | "tokens"
  | "copy"
  | "rules"
  | "visual"
  | "impl";

export type DocTab = { key: DocTabKey; label: string; en: string };

/** Tab list — Simple POS line 1882 (key · TH label · EN label). */
export const DOC_TABS: DocTab[] = [
  { key: "overview", label: "ภาพรวม", en: "Overview" },
  { key: "ia", label: "โครงสร้าง IA", en: "Sitemap" },
  { key: "flows", label: "User Flows", en: "Flows" },
  { key: "screens", label: "รายการหน้าจอ", en: "Screens" },
  { key: "components", label: "Components", en: "Components" },
  { key: "tokens", label: "Design Tokens", en: "Tokens" },
  { key: "copy", label: "UX Copy", en: "Copy" },
  { key: "rules", label: "กฎ UX บัญชี", en: "Rules" },
  { key: "visual", label: "2 แนว Visual", en: "Visual" },
  { key: "impl", label: "Dev Notes", en: "Notes" },
];

/* ----------------------------- IA (Sitemap) ----------------------------- */
// Role-access colors (Cashier green / Owner blue / Accountant-Admin purple);
// "off" = the muted slate from the source. Simple POS lines 1794–1805.
const IA_ON = { c: "#16a34a", o: "#2563eb", a: "#7c3aed" } as const;
const IA_OFF = "#e2e8f0";

export type IaRow = {
  title: string;
  en: string;
  subs: string;
  /** cashier / owner / accountant-admin access dot colors */
  cC: string;
  oC: string;
  aC: string;
};

export const IA_ROWS: IaRow[] = (
  [
    ["POS / Checkout", "ขายหน้าร้าน", "ขายสินค้า · พักบิล · ส่วนลด · เลือกลูกค้า · ชำระเงิน · ใบเสร็จ", 1, 0, 0],
    ["Sales History", "ประวัติการขาย", "ค้นหาบิล · ตัวกรอง · รายละเอียด · refund/void · ขอใบกำกับ", 1, 1, 1],
    ["Products", "สินค้า", "รายการสินค้า · ราคา/VAT · barcode · ผูกบัญชี · active/inactive", 0, 1, 1],
    ["Inventory", "สต็อก", "คงเหลือ · ปรับสต็อก · การเคลื่อนไหว · แจ้งเตือนสต็อกต่ำ", 0, 1, 1],
    ["Customers", "ลูกค้า", "ข้อมูลลูกค้า · เลขผู้เสียภาษี · ที่อยู่ออกใบกำกับ", 1, 1, 1],
    ["Shift Close", "ปิดรอบ", "สรุปยอด · นับเงินสด · ผลต่าง · สรุปบัญชีรายวัน", 1, 1, 0],
    ["Reports", "รายงาน", "ยอดขาย · ภาษี · สินค้าขายดี · สรุปวิธีชำระ", 0, 1, 1],
    ["KRS Data Link", "การเชื่อมข้อมูล", "เชื่อมต่อ KRS · map field 2 ทาง · insert/pull · live data", 0, 0, 1],
    ["Users & Roles", "จัดการผู้ใช้", "รายชื่อผู้ใช้ · เพิ่ม/ปิดใช้งาน · บทบาท ผู้ขาย/Admin · สิทธิ์เมนู", 0, 0, 1],
    ["Settings", "ตั้งค่า", "สาขา · ภาษี · เครื่องพิมพ์ · ทั่วไป", 0, 1, 1],
  ] as const
).map(([title, en, subs, c, o, a]) => ({
  title,
  en,
  subs,
  cC: c ? IA_ON.c : IA_OFF,
  oC: o ? IA_ON.o : IA_OFF,
  aC: a ? IA_ON.a : IA_OFF,
}));

/* ------------------------------- Flows ---------------------------------- */
export type FlowStep = { label: string; arrow: boolean };
export type FlowRow = { tag: string; color: string; title: string; steps: FlowStep[] };

export const FLOW_ROWS: FlowRow[] = (
  [
    [
      "CASHIER",
      "#16a34a",
      "เริ่มกะ → ขาย → รับเงิน",
      [
        "เข้าสู่ระบบ",
        "เปิดกะ + เงินทอนตั้งต้น",
        "เพิ่มสินค้าลงตะกร้า",
        "ส่วนลด",
        "เลือกลูกค้า/Walk-in",
        "รับเงิน",
        "พิมพ์/ส่งใบเสร็จ",
      ],
    ],
    ["DATA", "#2563eb", "ส่งข้อมูลเข้า KRS", ["ปิดการขาย", "map field → KRS.sales", "insert เข้า queue", "ดึงข้อมูล KRS มา map กลับ"]],
    [
      "CASHIER",
      "#16a34a",
      "ปิดรอบขาย",
      ["ดูสรุปยอด", "แยกตามวิธีชำระ", "นับเงินสดจริง", "ดูผลต่าง", "ปิดรอบ + สร้างสรุปบัญชีรายวัน"],
    ],
    ["DATA", "#2563eb", "เชื่อม KRS", ["POS → map field → INSERT KRS", "KRS → PULL → map → POS", "ได้ KRS id กลับมา"]],
    ["CASHIER", "#16a34a", "คืนเงิน / ยกเลิก", ["เปิดบิลเดิม", "เลือก refund หรือ void", "ระบุเหตุผล", "สร้างใบลดหนี้ (refund) อัตโนมัติ"]],
    ["ADMIN", "#7c3aed", "แก้ sync ที่ล้มเหลว", ["เปิด Sync Dashboard", "ดู error ที่ failed", "แก้ mapping ที่ขาด", "retry", "หรือ mark/skip + เหตุผล"]],
  ] as const
).map(([tag, color, title, steps]) => ({
  tag,
  color,
  title,
  steps: steps.map((label, i) => ({ label, arrow: i < steps.length - 1 })),
}));

/* ------------------------------- Screens -------------------------------- */
export type ScreenItem = {
  name: string;
  purpose: string;
  user: string;
  comps: string;
  actions: string;
  states: string;
};
export type ScreenGroup = { title: string; color: string; items: ScreenItem[] };

export const SCREEN_GROUPS: ScreenGroup[] = (
  [
    [
      "A · POS Core",
      "#16a34a",
      [
        ["POS Checkout", "ขายสินค้าหน้าร้าน", "Cashier", "ProductGrid, CartPanel, CategoryFilter, CustomerSelector", "เพิ่ม/ลบสินค้า, ส่วนลด, ชำระเงิน", "empty cart, scanning, hold"],
        ["Payment Modal", "รับชำระเงิน", "Cashier", "PaymentMethodButton, SplitRow, CashPanel", "เลือกวิธี, split, ยืนยัน", "validation error, change"],
        ["Receipt", "แสดง/ส่งใบเสร็จ", "Cashier", "ReceiptPreview, SyncStatusBadge, QR", "พิมพ์, ส่งลิงก์", "synced, pending, daily"],
      ],
    ],
    [
      "B · KRS Data Link",
      "#2563eb",
      [
        ["Sales History", "ค้นหา/จัดการบิล", "Owner/Admin", "SalesTable, FilterChips, SaleDrawer", "refund, void, ขอใบกำกับ", "paid, refunded, voided, failed"],
        ["KRS Data Link", "เชื่อม/ตรวจ KRS", "Admin", "ConnectionForm, FieldMapTable, SyncJobTable, LiveData", "test, map field, insert, pull", "connected, pending, synced, failed"],
      ],
    ],
    [
      "C · Inventory",
      "#0f766e",
      [
        ["Products", "จัดการสินค้า", "Owner/Admin", "ProductTable, ProductForm", "เพิ่ม/แก้, active/inactive", "active, inactive"],
        ["Inventory Basic", "ดูสต็อก", "Owner/Admin", "StockTable, AdjustDialog, MovementLog", "ปรับสต็อก", "low stock, out of stock"],
      ],
    ],
    [
      "D · Reporting/Admin",
      "#7c3aed",
      [
        ["Shift Close", "ปิดรอบขาย", "Owner/Cashier", "ShiftSummaryCard, CashCountingPanel", "ปิดรอบ, สรุปรายวัน", "open, counting, closed"],
        ["Reports", "รายงานยอดขาย", "Owner/Admin", "ReportChart, ExportButton", "ดู/ส่งออก", "loading, empty"],
      ],
    ],
  ] as const
).map(([title, color, items]) => ({
  title,
  color,
  items: items.map(([name, purpose, user, comps, actions, states]) => ({
    name,
    purpose,
    user,
    comps,
    actions,
    states,
  })),
}));

/* ----------------------------- Components ------------------------------- */
export type ComponentRow = { name: string; props: string };

export const COMPONENT_ROWS: ComponentRow[] = (
  [
    ["ProductCard", "{ id, name, price, vat, image?, onAdd }"],
    ["CartItem", "{ line, onInc, onDec, onRemove, onDiscount }"],
    ["PaymentMethodButton", "{ method, active, icon, onPick }"],
    ["ReceiptPreview", "{ sale, accountingDocNo?, taxInfo?, qrUrl }"],
    ["SyncStatusBadge", "{ status: pending|synced|failed|retrying|skipped|daily }"],
    ["ShiftSummaryCard", "{ gross, byMethod[], expected, counted, variance }"],
    ["SyncJobTable", "{ jobs[], onRowClick, filter }"],
    ["MappingTable", "{ rows[], type, onEdit, incompleteFlag }"],
    ["TaxBadge", "{ hasTax: boolean, taxId? }"],
    ["RefundDialog", "{ sale, onConfirm, reason }"],
    ["VoidConfirmDialog", "{ sale, blockedIfSynced, onConfirm }"],
    ["CashCountingPanel", "{ expected, counted, onCount, variance }"],
    ["ErrorResponsePanel", "{ error, providerResponse, onRetry, onSkip }"],
  ] as const
).map(([name, props]) => ({ name, props }));

/* ------------------------------- Tokens --------------------------------- */
export type TokenColor = { name: string; hex: string; use: string };

export const TOKEN_COLORS: TokenColor[] = (
  [
    ["Navy / Structure", "#0f172a", "sidebar, nav, หัวข้อ"],
    ["Green / Pay", "#16a34a", "ปุ่มขาย, สำเร็จ, synced"],
    ["Blue / Accounting", "#2563eb", "สถานะบัญชี, trust"],
    ["Teal / Accent", "#0f766e", "ไอคอน, หมวดเครื่องดื่ม"],
    ["Amber / Retry", "#d97706", "retrying, warning"],
    ["Red / Error", "#dc2626", "failed, void, error"],
    ["Slate / Muted", "#64748b", "ข้อความรอง, เส้น"],
    ["Surface", "#eef2f6", "พื้นหลังแอป"],
  ] as const
).map(([name, hex, use]) => ({ name, hex, use }));

/* -------------------------------- Copy ---------------------------------- */
export type CopyRow = { th: string; en: string };
export type CopyGroup = { title: string; rows: CopyRow[] };

export const COPY_GROUPS: CopyGroup[] = (
  [
    [
      "ปุ่ม · Buttons",
      [
        ["ชำระเงิน", "Pay"],
        ["ยืนยันการชำระเงิน", "Confirm payment"],
        ["พักบิล", "Hold bill"],
        ["ยกเลิกบิล", "Cancel bill"],
        ["เริ่มบิลใหม่", "New sale"],
        ["ลองส่งใหม่", "Retry sync"],
        ["ข้าม + ระบุเหตุผล", "Skip with reason"],
        ["ปิดรอบ", "Close shift"],
        ["ขอใบกำกับภาษี", "Request tax invoice"],
      ],
    ],
    [
      "สถานะ · Status",
      [
        ["รอส่ง KRS", "Pending"],
        ["ส่ง KRS แล้ว", "Synced"],
        ["ส่ง KRS ไม่สำเร็จ", "Sync failed"],
        ["กำลังลองใหม่", "Retrying"],
        ["รวมในสรุปรายวัน", "In daily summary"],
        ["ข้าม", "Skipped"],
      ],
    ],
    [
      "ข้อความ Error",
      [
        ["ยอดชำระไม่ตรงกับยอดที่ต้องจ่าย", "Paid amount does not match total due"],
        ["รับเงินสดน้อยกว่ายอด", "Cash received is less than amount due"],
        ["ต้องเลือกลูกค้าที่มีเลขผู้เสียภาษีก่อน", "Select a customer with a tax ID first"],
        ["การผูกบัญชียังไม่ครบ ระบบบล็อกการส่ง", "Mapping incomplete — sync blocked"],
        ["เชื่อมต่อระบบบัญชีไม่สำเร็จ กำลังลองใหม่", "Cannot reach accounting — retrying"],
      ],
    ],
    [
      "ยืนยัน · Confirm",
      [
        ["คืนเงินบิลนี้ทั้งหมด? ระบบจะสร้างใบลดหนี้", "Refund this sale? A credit note will be issued"],
        ["ยกเลิกบิล (Void)? ใช้ได้เฉพาะบิลที่ยังไม่ส่งบัญชี", "Void this bill? Only allowed before it is synced"],
      ],
    ],
  ] as const
).map(([title, rows]) => ({ title, rows: rows.map(([th, en]) => ({ th, en })) }));

/* -------------------------------- Rules --------------------------------- */
export type RuleRow = {
  /** lucide icon key (mapped to a component in RulesPanel) */
  icon: "check" | "retry" | "lock" | "refund" | "warn" | "block" | "bolt";
  bg: string;
  fg: string;
  th: string;
  en: string;
};

export const RULE_ROWS: RuleRow[] = [
  { icon: "check", bg: "#f0fdf4", fg: "#16a34a", th: "sync สำเร็จ → แสดงเลขเอกสารบัญชี", en: "On success, show the accounting document number on the sale & receipt" },
  { icon: "retry", bg: "#fffbeb", fg: "#d97706", th: "sync fail → แสดง error + ปุ่ม retry", en: "On failure, show a readable error and a retry action" },
  { icon: "lock", bg: "#eff6ff", fg: "#2563eb", th: "บิลที่ส่งบัญชีแล้ว ห้ามแก้ยอดโดยตรง", en: "Synced bills are locked — no direct amount edits" },
  { icon: "refund", bg: "#fff7ed", fg: "#c2410c", th: "ต้องคืนเงิน → ใช้ refund / credit note flow", en: "Refunds go through a credit-note flow, never edits" },
  { icon: "warn", bg: "#fffbeb", fg: "#b45309", th: "ลูกค้าไม่มี tax info → เตือนก่อนขอใบกำกับ", en: "Warn before requesting a tax invoice without tax info" },
  { icon: "block", bg: "#fef2f2", fg: "#dc2626", th: "mapping ไม่ครบ → block sync + บอกสิ่งที่ต้องแก้", en: "Block sync when mapping is incomplete; list what to fix" },
  { icon: "bolt", bg: "#f0fdf4", fg: "#15803d", th: "ระบบบัญชีล่ม → POS ยังขายต่อได้", en: "POS must keep selling even when accounting is down" },
];

/* ------------------------- Implementation notes ------------------------- */
export type ImplRow = { title: string; body: string };

export const IMPL_ROWS: ImplRow[] = (
  [
    [
      "สถาปัตยกรรม sync queue",
      "ทุกการขาย/คืนเงินสร้าง SyncJob เก็บใน local queue (IndexedDB) ก่อน แล้วค่อยส่งแบบ background พร้อม exponential backoff retry (เช่น 1, 5, 30 นาที สูงสุด 5 ครั้ง) — POS ไม่ block UI รอผลบัญชี",
    ],
    [
      "แยกเลขเอกสาร",
      "posNo สร้างฝั่ง client ทันที (POS-YYYYMMDD-####). accountingDocNo มาจาก provider response หลัง sync สำเร็จเท่านั้น — อย่าผูกสองค่านี้เป็นตัวเดียวกัน",
    ],
    ["Idempotency", "ส่ง sync ทุกครั้งแนบ idempotency key = posNo+jobType กัน provider ออกเอกสารซ้ำเวลา retry"],
    [
      "สถานะเป็น state machine",
      "SyncJob: pending → retrying → (synced | failed | skipped). UI render badge จาก enum เดียวกันทุกที่ (SyncStatusBadge) เพื่อความสม่ำเสมอ",
    ],
    ["ห้าม destructive delete", "ไม่มี endpoint ลบบิล — มีแค่ void (ก่อน sync) และ refund/credit note (หลัง sync) ทุกอย่างเก็บ audit trail"],
    ["เผื่อ multi-branch", "ใส่ branchId ในทุก entity ตั้งแต่ MVP (default BR-01) เพื่อให้ขยายหลายสาขาได้โดยไม่ต้อง migrate ข้อมูล"],
  ] as const
).map(([title, body]) => ({ title, body }));

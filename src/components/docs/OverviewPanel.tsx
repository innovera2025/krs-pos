import { Zap, RefreshCw, FileText } from "lucide-react";

/**
 * Overview panel — Simple POS source lines 570–594. Dark hero + 3 pillar cards +
 * 6 design principles. Content is inline (not a data array in the source).
 * Ported into the Taste visual language (forest hero, --surface/--line cards).
 */

const PILLARS = [
  {
    Icon: Zap,
    bg: "var(--mint)",
    fg: "var(--brand-2)",
    title: "ขายเร็วบนแท็บเล็ต",
    body: "แตะสินค้า → ตะกร้า → รับเงิน จบใน 3 ขั้น ปุ่มใหญ่ แตะง่าย เหมาะกับ cashier มือใหม่",
  },
  {
    Icon: RefreshCw,
    bg: "var(--blue-soft)",
    fg: "var(--blue)",
    title: "Sync queue กันล่ม",
    body: "ทุกบิลเข้า queue ขายต่อได้แม้บัญชีล่ม retry อัตโนมัติ มองเห็นสถานะชัด",
  },
  {
    Icon: FileText,
    bg: "var(--sunken)",
    fg: "var(--ink)",
    title: "แยกเลข POS / บัญชี",
    body: "เลขบิล POS คนละชุดกับเลขเอกสารบัญชี daily summary เป็นค่าเริ่มต้น",
  },
] as const;

const PRINCIPLES = [
  { n: "01", title: "ขายมาก่อน บัญชีตามหลัง", body: "POS ขายได้เสมอ แม้ระบบบัญชีล่ม งานบัญชีเป็น async" },
  { n: "02", title: "ห้ามลบบิล", body: "ใช้ cancel / void / refund เท่านั้น เพื่อรอยตรวจสอบครบ" },
  { n: "03", title: "สถานะบัญชีต้องมองเห็น", body: "Unsynced / Synced / Failed / Retry มีสีและ badge ชัด" },
  { n: "04", title: "error ต้อง actionable", body: "บอกสาเหตุเป็นภาษาคน + ปุ่มแก้ไข/retry ทันที" },
  { n: "05", title: "MVP ไม่ใช่ ERP", body: "ตัดความซับซ้อน เหลือสิ่งที่ร้านต้องใช้จริง" },
  { n: "06", title: "ต่อยอด multi-branch ได้", body: "MVP สาขาเดียว แต่โครงข้อมูลเผื่อหลายสาขา" },
] as const;

export function OverviewPanel() {
  return (
    <div className="flex flex-col gap-4">
      {/* Dark/forest hero */}
      <div
        className="rounded-[20px] px-[30px] py-7 text-white"
        style={{ background: "linear-gradient(135deg, var(--forest), var(--forest-2))" }}
      >
        <div className="text-[12px] font-semibold uppercase tracking-[.08em]" style={{ color: "var(--mint)" }}>
          Product Design Package
        </div>
        <div className="mt-1.5 text-[26px] font-bold leading-snug">
          KRS — Simple POS ที่เชื่อมข้อมูลกับฐานข้อมูล KRS
        </div>
        <div className="mt-2 max-w-[680px] text-[14px] leading-relaxed" style={{ color: "rgba(255,255,255,.78)" }}>
          ระบบขายหน้าร้านแบบ web/tablet สำหรับร้านเล็ก–กลาง เน้นขายเร็ว ปิดรอบง่าย และเตรียมข้อมูลให้พร้อมส่งเข้าระบบบัญชีภายนอก
          (PEAK, FlowAccount, Xero, QuickBooks, Custom API) โดยไม่ทำให้รกแบบ ERP
        </div>
      </div>

      {/* 3 pillar cards */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        {PILLARS.map(({ Icon, bg, fg, title, body }) => (
          <div
            key={title}
            className="rounded-[14px] p-5"
            style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
          >
            <div className="grid h-11 w-11 place-items-center rounded-xl" style={{ background: bg, color: fg }}>
              <Icon size={23} strokeWidth={1.7} />
            </div>
            <div className="mt-3 text-[14.5px] font-bold">{title}</div>
            <div className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              {body}
            </div>
          </div>
        ))}
      </div>

      {/* Design principles */}
      <div
        className="rounded-[16px] px-6 py-[22px]"
        style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
      >
        <div className="mb-3.5 text-[15px] font-bold">หลักการออกแบบ · Design principles</div>
        <div className="grid grid-cols-1 gap-x-7 gap-y-3 sm:grid-cols-2">
          {PRINCIPLES.map((p) => (
            <div key={p.n} className="flex gap-2.5">
              <span className="font-bold" style={{ color: "var(--brand)" }}>
                {p.n}
              </span>
              <div>
                <div className="text-[13.5px] font-semibold">{p.title}</div>
                <div className="text-[12px]" style={{ color: "var(--muted)" }}>
                  {p.body}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

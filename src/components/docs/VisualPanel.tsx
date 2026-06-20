/**
 * Visual directions panel — Simple POS source lines 745–802 (inline content).
 * "2 แนวทาง Visual — POS Checkout" — 2 direction cards (1 · Clean modern SaaS
 * [prototype base], 2 · Friendly small-business) each with a 5-swatch palette +
 * Type/Radius/Spacing/Icon/Tone line + a mini wireframe mock; then the blue
 * recommendation banner.
 *
 * The two palettes are deliberate design *specimens* comparing the directions, so
 * their swatch hexes are reproduced verbatim from the source (this is the spec).
 * The surrounding card chrome is ported into the live Taste tokens.
 */

const DIR1_SWATCHES = ["#0f172a", "#16a34a", "#2563eb", "#f1f5f9", "#0f766e"];
const DIR2_SWATCHES = ["#1e293b", "#15803d", "#f59e0b", "#fef3c7", "#fb7185"];

export function VisualPanel() {
  return (
    <div className="flex flex-col gap-4">
      <div className="text-[18px] font-bold">2 แนวทาง Visual — POS Checkout</div>

      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-2">
        {/* Direction 1: Clean SaaS */}
        <div className="flex flex-col gap-3">
          <div
            className="rounded-[16px] px-5 py-[18px]"
            style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
          >
            <div className="text-[15px] font-bold">1 · Clean modern SaaS POS</div>
            <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted)" }}>
              โทนนิ่ง มืออาชีพ น่าเชื่อถือ (แนวที่ใช้ใน prototype นี้)
            </div>
            <div className="my-3.5 flex gap-[7px]">
              {DIR1_SWATCHES.map((c, i) => (
                <span
                  key={i}
                  className="h-[34px] w-[34px] rounded-[8px]"
                  style={{ background: c, border: c === "#f1f5f9" ? "1px solid #e2e8f0" : undefined }}
                />
              ))}
            </div>
            <div className="text-[12px] leading-[1.7]" style={{ color: "var(--ink)" }}>
              <b>Type:</b> IBM Plex Sans Thai · <b>Radius:</b> 11–14px · <b>Spacing:</b> โปร่ง · <b>Icon:</b> เส้น 2px outline ·{" "}
              <b>Tone:</b> กระชับ ตรงไปตรงมา
            </div>
          </div>
          {/* mini mock — clean */}
          <div className="rounded-[14px] p-3" style={{ background: "var(--bg)", border: "1px solid var(--line)" }}>
            <div className="flex h-[150px] gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="h-[22px] rounded-[7px]" style={{ background: "var(--surface)", border: "1px solid #e2e8f0" }} />
                <div className="grid flex-1 grid-cols-3 gap-1.5">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="rounded-[8px]" style={{ background: "var(--surface)", border: "1px solid var(--line)" }} />
                  ))}
                </div>
              </div>
              <div
                className="flex w-24 flex-col gap-[5px] rounded-[8px] p-1.5"
                style={{ background: "var(--surface)", border: "1px solid #e2e8f0" }}
              >
                <div className="h-2 rounded-[3px]" style={{ background: "#f1f5f9" }} />
                <div className="h-2 w-[70%] rounded-[3px]" style={{ background: "#f1f5f9" }} />
                <div className="flex-1" />
                <div className="h-[26px] rounded-[7px]" style={{ background: "#16a34a" }} />
              </div>
            </div>
          </div>
        </div>

        {/* Direction 2: Friendly */}
        <div className="flex flex-col gap-3">
          <div
            className="rounded-[16px] px-5 py-[18px]"
            style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
          >
            <div className="text-[15px] font-bold">2 · Friendly small-business POS</div>
            <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted)" }}>
              อบอุ่น เป็นกันเอง มุมโค้งมาก ตัวอักษรใหญ่
            </div>
            <div className="my-3.5 flex gap-[7px]">
              {DIR2_SWATCHES.map((c, i) => (
                <span key={i} className="h-[34px] w-[34px] rounded-[11px]" style={{ background: c }} />
              ))}
            </div>
            <div className="text-[12px] leading-[1.7]" style={{ color: "var(--ink)" }}>
              <b>Type:</b> Sarabun/Mali (กลม) · <b>Radius:</b> 16–22px · <b>Spacing:</b> แน่นอุ่น · <b>Icon:</b> filled มน ·{" "}
              <b>Tone:</b> เป็นมิตร ชวนคุย
            </div>
          </div>
          {/* mini mock — friendly */}
          <div className="rounded-[18px] p-3" style={{ background: "#fffbeb", border: "1px solid #fde68a" }}>
            <div className="flex h-[150px] gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="h-[22px] rounded-[11px]" style={{ background: "#fff" }} />
                <div className="grid flex-1 grid-cols-3 gap-1.5">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="rounded-[13px]" style={{ background: "#fff" }} />
                  ))}
                </div>
              </div>
              <div className="flex w-24 flex-col gap-[5px] rounded-[14px] p-1.5" style={{ background: "#fff" }}>
                <div className="h-2 rounded-[4px]" style={{ background: "#fef3c7" }} />
                <div className="h-2 w-[70%] rounded-[4px]" style={{ background: "#fef3c7" }} />
                <div className="flex-1" />
                <div className="h-[30px] rounded-[12px]" style={{ background: "#15803d" }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Recommendation banner */}
      <div
        className="rounded-[13px] px-[18px] py-3.5 text-[12.5px] leading-relaxed"
        style={{ background: "var(--blue-soft)", border: "1px solid #bfdbfe", color: "#1e40af" }}
      >
        <b>ข้อเสนอแนะ:</b> ใช้ Direction 1 (Clean SaaS) เป็นฐานของ prototype เพราะอ่านง่าย ดูน่าเชื่อถือสำหรับงานบัญชี และคุม visual
        hierarchy ได้ดี — สามารถดึงความ &quot;เป็นมิตร&quot; จาก Direction 2 (มุมโค้ง ปุ่มใหญ่ขึ้น) มาผสมเฉพาะหน้าจอ cashier ได้
      </div>
    </div>
  );
}

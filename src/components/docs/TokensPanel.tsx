import { TOKEN_COLORS } from "./docsContent";

/**
 * Tokens panel — Simple POS source lines 680–711 (data: TOKEN_COLORS, 8 swatches;
 * rest inline). "Design tokens" — 8 color-role swatches (hex + use) + a
 * typography demo (IBM Plex Sans Thai) + a spacing/radius/shadow/hit-target block.
 *
 * NOTE (Phase 6c decision D): the swatch hexes are the *documented design-spec*
 * token table (navy/green from Simple POS). The shipped app's Taste palette is
 * forest/mint — kept as documented; this is a design-spec page, not the live
 * token export. The surrounding cards use the live Taste tokens.
 */

export function TokensPanel() {
  return (
    <div className="flex flex-col gap-4">
      <div className="text-[18px] font-bold">Design tokens (เบื้องต้น)</div>

      {/* Color roles */}
      <div
        className="rounded-[16px] px-[22px] py-5"
        style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
      >
        <div className="mb-3 text-[14px] font-bold">Color roles</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {TOKEN_COLORS.map((c) => (
            <div key={c.name}>
              <div className="h-[52px] rounded-[10px]" style={{ background: c.hex, border: "1px solid rgba(0,0,0,.06)" }} />
              <div className="mt-1.5 text-[12px] font-semibold">{c.name}</div>
              <div className="mono text-[11px]" style={{ color: "var(--soft)" }}>
                {c.hex}
              </div>
              <div className="text-[10.5px]" style={{ color: "var(--muted)" }}>
                {c.use}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Typography demo */}
        <div
          className="rounded-[16px] px-[22px] py-5"
          style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
        >
          <div className="mb-3 text-[14px] font-bold">Typography · IBM Plex Sans Thai</div>
          <div className="text-[26px] font-bold">฿1,240.00 · ยอดสุทธิ</div>
          <div className="mt-1.5 text-[18px] font-semibold">หัวข้อหน้าจอ · Screen title</div>
          <div className="mt-1 text-[14px]" style={{ color: "var(--ink)" }}>
            เนื้อความปกติ · Body 14px / line-height 1.5
          </div>
          <div className="mono mt-1 text-[13px]" style={{ color: "var(--muted)" }}>
            POS-20260616-0042 · Mono / tabular nums
          </div>
          <div className="mt-2 text-[11.5px]" style={{ color: "var(--soft)" }}>
            น้ำหนัก 400 / 500 / 600 / 700 — ตัวเลขเงินใช้ tabular figures เสมอ
          </div>
        </div>

        {/* Spacing / Radius / Shadow / Hit target */}
        <div
          className="rounded-[16px] px-[22px] py-5"
          style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
        >
          <div className="mb-3 text-[14px] font-bold">Spacing · Radius · Shadow</div>
          <div className="flex flex-col gap-[9px] text-[12.5px]" style={{ color: "var(--ink)" }}>
            <div>
              Spacing scale: <span className="mono">4 · 8 · 12 · 16 · 20 · 24</span>
            </div>
            <div className="flex items-center gap-2">
              Radius:
              <span className="h-[30px] w-[30px] rounded-[8px]" style={{ background: "var(--sunken)" }} />8
              <span className="h-[30px] w-[30px] rounded-[11px]" style={{ background: "var(--sunken)" }} />11
              <span className="h-[30px] w-[30px] rounded-[14px]" style={{ background: "var(--sunken)" }} />14
            </div>
            <div>
              Card shadow: <span className="mono">0 6px 18px rgba(15,23,42,.10)</span>
            </div>
            <div>
              Hit target ≥ <span className="font-bold">44px</span> (ปุ่มหลัก 52–58px)
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

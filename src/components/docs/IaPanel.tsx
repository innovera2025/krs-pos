import { IA_ROWS } from "./docsContent";

/**
 * IA / Sitemap panel — Simple POS source lines 597–621 (data: IA_ROWS, 10 rows).
 * "Sitemap & สิทธิ์การเข้าถึง" + role legend (Cashier green / Owner blue /
 * Accountant-Admin purple) + 10 rows each with subs + 3 role-access dots.
 * Ported into Taste (--surface/--line/--muted) — role dot colors are the
 * semantic source colors and are kept as documented.
 */

const LEGEND = [
  { color: "#16a34a", label: "Cashier" },
  { color: "#2563eb", label: "Owner" },
  { color: "#7c3aed", label: "Accountant/Admin" },
] as const;

export function IaPanel() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3.5">
        <div className="text-[18px] font-bold">Sitemap &amp; สิทธิ์การเข้าถึง</div>
        <div className="flex gap-2">
          {LEGEND.map((l) => (
            <span key={l.label} className="inline-flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--muted)" }}>
              <span className="h-[9px] w-[9px] rounded-full" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      <div
        className="rounded-[16px] px-2 py-2.5"
        style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
      >
        {IA_ROWS.map((r, i) => (
          <div
            key={r.title}
            className="flex items-center gap-3 px-4 py-[13px]"
            style={{ borderBottom: i < IA_ROWS.length - 1 ? "1px solid var(--surface-2)" : undefined }}
          >
            <div className="w-[180px] flex-shrink-0 sm:w-[200px]">
              <div className="text-[14px] font-bold" style={{ color: "var(--ink)" }}>
                {r.title}
              </div>
              <div className="text-[11.5px]" style={{ color: "var(--soft)" }}>
                {r.en}
              </div>
            </div>
            <div className="flex-1 text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              {r.subs}
            </div>
            <div className="flex flex-shrink-0 gap-[5px]">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.cC }} />
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.oC }} />
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.aC }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

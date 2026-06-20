import { COPY_GROUPS } from "./docsContent";

/**
 * UX copy panel — Simple POS source lines 714–729 (data: COPY_GROUPS, 4 groups:
 * Buttons 9 / Status 6 / Error 5 / Confirm 2 = 22 TH/EN pairs). "UX copy —
 * ไทย/English" — group title + TH/EN 2-col rows. Ported into Taste.
 */

export function CopyPanel() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="text-[18px] font-bold">UX copy — ไทย / English</div>
      {COPY_GROUPS.map((g) => (
        <div
          key={g.title}
          className="overflow-hidden rounded-[14px]"
          style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
        >
          <div
            className="px-[18px] py-3 text-[13.5px] font-bold"
            style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--line)" }}
          >
            {g.title}
          </div>
          {g.rows.map((r, i) => (
            <div
              key={r.en}
              className="grid grid-cols-2 gap-4 px-[18px] py-[11px]"
              style={{ borderBottom: i < g.rows.length - 1 ? "1px solid var(--surface-2)" : undefined }}
            >
              <div className="text-[13px]" style={{ color: "var(--ink)" }}>
                {r.th}
              </div>
              <div className="text-[13px]" style={{ color: "var(--muted)" }}>
                {r.en}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

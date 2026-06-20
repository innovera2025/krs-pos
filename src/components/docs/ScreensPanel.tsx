import { SCREEN_GROUPS } from "./docsContent";

/**
 * Screens panel — Simple POS source lines 642–662 (data: SCREEN_GROUPS, 4 groups
 * / 9 screen cards). "Screen list (MVP)" + 4 groups (color dot + title) → screen
 * cards (name · purpose · user + Components / Actions / States).
 * Ported into Taste; the group color dot is the semantic source color.
 */

export function ScreensPanel() {
  return (
    <div className="flex flex-col gap-[18px]">
      <div className="text-[18px] font-bold">Screen list (MVP)</div>
      {SCREEN_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="mb-2.5 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: g.color }} />
            <span className="text-[14px] font-bold">{g.title}</span>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {g.items.map((sc) => (
              <div
                key={sc.name}
                className="rounded-[13px] px-[17px] py-[15px]"
                style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <div className="text-[14px] font-bold">{sc.name}</div>
                  <span className="text-[11px]" style={{ color: "var(--soft)" }}>
                    {sc.user}
                  </span>
                </div>
                <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted)" }}>
                  {sc.purpose}
                </div>
                <div className="mt-2.5 text-[11.5px] leading-relaxed" style={{ color: "var(--ink)" }}>
                  <span style={{ color: "var(--soft)" }}>Components:</span> {sc.comps}
                </div>
                <div className="text-[11.5px] leading-relaxed" style={{ color: "var(--ink)" }}>
                  <span style={{ color: "var(--soft)" }}>Actions:</span> {sc.actions}
                </div>
                <div className="mt-2 text-[11px]" style={{ color: "var(--muted)" }}>
                  <span style={{ color: "var(--soft)" }}>States:</span> {sc.states}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

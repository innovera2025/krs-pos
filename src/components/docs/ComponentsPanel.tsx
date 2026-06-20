import { COMPONENT_ROWS } from "./docsContent";

/**
 * Components panel — Simple POS source lines 665–677 (data: COMPONENT_ROWS, 13
 * rows). "Component inventory" — <Name/> (mono) + prop signature (mono).
 * Ported into Taste. NOTE: these are the *documented design-spec* component
 * names (e.g. <CartItem/>, <CustomerSelector/> in screens); the built app later
 * named some of them differently (CartLine, CustomerPickerModal). Per Phase 6c
 * decision B they are kept as documented — this is a design spec, not a mirror.
 */

export function ComponentsPanel() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="text-[18px] font-bold">Component inventory</div>
      <div
        className="overflow-hidden rounded-[16px]"
        style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
      >
        {COMPONENT_ROWS.map((c, i) => (
          <div
            key={c.name}
            className="grid grid-cols-[160px_1fr] items-center gap-4 px-[18px] py-[13px] sm:grid-cols-[200px_1fr]"
            style={{ borderBottom: i < COMPONENT_ROWS.length - 1 ? "1px solid var(--surface-2)" : undefined }}
          >
            <div className="mono text-[13px] font-semibold" style={{ color: "var(--blue)" }}>
              &lt;{c.name}/&gt;
            </div>
            <div className="mono text-[12px]" style={{ color: "var(--muted)" }}>
              {c.props}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

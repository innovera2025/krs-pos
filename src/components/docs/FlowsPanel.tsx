import { Fragment } from "react";
import { ArrowRight } from "lucide-react";
import { FLOW_ROWS } from "./docsContent";

/**
 * Flows panel — Simple POS source lines 624–639 (data: FLOW_ROWS, 6 cards).
 * "Key user flows" + 6 flow cards (tag chip + step chain with arrows).
 * Ported into Taste; the tag chip color is the semantic source color.
 */

export function FlowsPanel() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="text-[18px] font-bold">Key user flows</div>
      {FLOW_ROWS.map((f) => (
        <div
          key={f.title}
          className="rounded-[14px] px-5 py-4"
          style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
        >
          <div className="mb-3 flex items-center gap-2.5">
            <span
              className="rounded-md px-2.5 py-[3px] text-[11px] font-bold text-white"
              style={{ background: f.color }}
            >
              {f.tag}
            </span>
            <span className="text-[14.5px] font-bold">{f.title}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {f.steps.map((st, i) => (
              <Fragment key={i}>
                <span
                  className="rounded-lg px-[11px] py-1.5 text-[12px]"
                  style={{ background: "var(--sunken)", color: "var(--ink)" }}
                >
                  {st.label}
                </span>
                {st.arrow ? <ArrowRight size={15} style={{ color: "var(--line-strong)" }} /> : null}
              </Fragment>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

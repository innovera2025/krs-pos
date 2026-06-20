import type { LucideIcon } from "lucide-react";
import { Check, RotateCcw, Lock, Undo2, AlertTriangle, Ban, Zap } from "lucide-react";
import { RULE_ROWS, type RuleRow } from "./docsContent";

/**
 * Accounting UX rules panel — Simple POS source lines 732–742 (data: RULE_ROWS,
 * 7 rows). Each row = icon tile + TH + EN. The source rendered icons via
 * iconEl(icon, fg, 17); here the icon keys map to lucide icons. Ported into Taste;
 * the tile bg/fg are the semantic source colors (success/retry/lock/refund/etc.).
 */

const ICON_MAP: Record<RuleRow["icon"], LucideIcon> = {
  check: Check,
  retry: RotateCcw,
  lock: Lock,
  refund: Undo2,
  warn: AlertTriangle,
  block: Ban,
  bolt: Zap,
};

export function RulesPanel() {
  return (
    <div className="flex flex-col gap-3.5">
      <div className="text-[18px] font-bold">Accounting UX rules</div>
      {RULE_ROWS.map((r) => {
        const Icon = ICON_MAP[r.icon];
        return (
          <div
            key={r.icon}
            className="flex items-start gap-3.5 rounded-[13px] px-[18px] py-[15px]"
            style={{ background: "var(--surface)", border: "1px solid var(--line)" }}
          >
            <div
              className="grid h-[30px] w-[30px] flex-shrink-0 place-items-center rounded-[8px]"
              style={{ background: r.bg, color: r.fg }}
            >
              <Icon size={17} strokeWidth={2} />
            </div>
            <div>
              <div className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>
                {r.th}
              </div>
              <div className="mt-0.5 text-[12px]" style={{ color: "var(--muted)" }}>
                {r.en}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

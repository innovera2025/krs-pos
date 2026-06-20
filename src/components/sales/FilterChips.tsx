"use client";

import { SALES_FILTERS, type SalesFilter } from "./saleMeta";

type FilterChipsProps = {
  active: SalesFilter;
  onChange: (filter: SalesFilter) => void;
};

/**
 * Sales History filter chips (action-sales-filter-chips). Ported from Simple POS
 * salesChips into the Taste pill language: active chip = forest-green fill, others
 * = white with hairline border.
 */
export function FilterChips({ active, onChange }: FilterChipsProps) {
  return (
    <div className="flex items-center gap-2 overflow-x-auto">
      {SALES_FILTERS.map((f) => {
        const isActive = active === f.key;
        return (
          <button
            key={f.key}
            type="button"
            onClick={() => onChange(f.key)}
            aria-pressed={isActive}
            className="h-9 flex-shrink-0 whitespace-nowrap rounded-full border px-4 text-[12.5px] font-semibold transition"
            style={{
              borderColor: isActive ? "var(--brand)" : "var(--line)",
              background: isActive ? "var(--brand)" : "#fff",
              color: isActive ? "#fff" : "var(--ink)",
            }}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

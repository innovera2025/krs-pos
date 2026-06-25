"use client";

import { LayoutGrid, Package } from "lucide-react";

export type CategoryChip = {
  /** Selection key: "all" for the synthetic all-chip, else the real category id. */
  key: string;
  /** Thai label (real category name, or "ทั้งหมด" for the all-chip). */
  label: string;
  /** Secondary line under the label (e.g. "378 รายการ" or "All items"). */
  sublabel?: string;
};

type CategoryPanelProps = {
  chips: CategoryChip[];
  active: string;
  onSelect: (key: string) => void;
};

/**
 * Left category panel (168px) — Taste forest-active chips with icon + TH/EN.
 *
 * Chips are derived data-driven from the fetched products' real categories
 * (KRS ItemTypename), one chip per distinct category plus a synthetic
 * "ทั้งหมด / All" chip, built by the page; this component only renders + selects.
 * The "all" chip gets the grid icon; every real-category chip gets a generic box
 * icon. The list scrolls (overflow-y-auto) since there can be 17+ categories.
 */
export function CategoryPanel({ chips, active, onSelect }: CategoryPanelProps) {
  return (
    <aside
      aria-label="หมวดหมู่สินค้า"
      className="flex min-h-0 flex-col gap-2 overflow-y-auto rounded-[22px] border p-3"
      style={{
        background: "rgba(255,255,255,.74)",
        borderColor: "var(--line)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      {chips.map((chip) => {
        const Icon = chip.key === "all" ? LayoutGrid : Package;
        const isActive = active === chip.key;
        return (
          <button
            key={chip.key}
            type="button"
            onClick={() => onSelect(chip.key)}
            aria-pressed={isActive}
            className="flex flex-shrink-0 items-center gap-2.5 rounded-2xl border p-3 text-left transition"
            style={{
              borderColor: "transparent",
              background: isActive ? "var(--forest)" : "transparent",
              color: isActive ? "#fff" : "#475467",
              boxShadow: isActive ? "0 12px 24px rgba(14,59,46,.20)" : "none",
            }}
          >
            <span
              className="grid h-[34px] w-[34px] flex-shrink-0 place-items-center rounded-xl"
              style={{
                background: isActive ? "rgba(255,255,255,.14)" : "#f2f4f7",
                color: isActive ? "#fff" : "#667085",
              }}
            >
              <Icon size={18} strokeWidth={2} />
            </span>
            <span className="min-w-0">
              <strong className="block truncate text-[13px] leading-none">
                {chip.label}
              </strong>
              {chip.sublabel ? (
                <span
                  className="mt-0.5 block truncate text-[10.5px]"
                  style={{ opacity: 0.72 }}
                >
                  {chip.sublabel}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </aside>
  );
}

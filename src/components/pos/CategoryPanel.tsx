"use client";

import type { CategorySlug } from "@/types";
import { CATEGORY_META } from "./categoryMeta";

export type CategoryChip = {
  slug: CategorySlug;
  /** Thai label (e.g. "เครื่องดื่ม" or "ทั้งหมด" for the all-chip). */
  label: string;
};

type CategoryPanelProps = {
  chips: CategoryChip[];
  active: CategorySlug;
  onSelect: (slug: CategorySlug) => void;
};

/**
 * Left category panel (168px) — Taste forest-active chips with icon + TH/EN.
 *
 * Chips are derived from the fetched products' categories (plus a synthetic
 * "ทั้งหมด / All" chip) by the page; this component only renders + selects.
 */
export function CategoryPanel({ chips, active, onSelect }: CategoryPanelProps) {
  return (
    <aside
      aria-label="หมวดหมู่สินค้า"
      className="flex flex-col gap-2 rounded-[22px] border p-3"
      style={{
        background: "rgba(255,255,255,.74)",
        borderColor: "var(--line)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      {chips.map((chip) => {
        const meta = CATEGORY_META[chip.slug];
        const Icon = meta.icon;
        const isActive = active === chip.slug;
        return (
          <button
            key={chip.slug}
            type="button"
            onClick={() => onSelect(chip.slug)}
            aria-pressed={isActive}
            className="flex items-center gap-2.5 rounded-2xl border p-3 text-left transition"
            style={{
              borderColor: isActive ? "transparent" : "transparent",
              background: isActive ? "var(--forest)" : "transparent",
              color: isActive ? "#fff" : "#475467",
              boxShadow: isActive ? "0 12px 24px rgba(14,59,46,.20)" : "none",
            }}
          >
            <span
              className="grid h-[34px] w-[34px] place-items-center rounded-xl"
              style={{
                background: isActive ? "rgba(255,255,255,.14)" : "#f2f4f7",
                color: isActive ? "#fff" : "#667085",
              }}
            >
              <Icon size={18} strokeWidth={2} />
            </span>
            <span className="min-w-0">
              <strong className="block text-[13px] leading-none">
                {chip.label}
              </strong>
              <span
                className="mt-0.5 block text-[10.5px]"
                style={{ opacity: 0.72 }}
              >
                {meta.en}
              </span>
            </span>
          </button>
        );
      })}
    </aside>
  );
}

"use client";

import type { SyncCountsDTO } from "@/types";

/** The 5 KPI filter keys (one per SyncJobStatus) plus the synthetic "all". */
export type SyncFilter =
  | "all"
  | "pending"
  | "synced"
  | "retrying"
  | "failed"
  | "skipped";

type CardDef = {
  key: Exclude<SyncFilter, "all">;
  label: string;
  en: string;
  color: string;
};

const CARD_DEFS: CardDef[] = [
  { key: "pending", label: "รอส่ง", en: "Pending", color: "#2563eb" },
  { key: "synced", label: "สำเร็จ", en: "Synced", color: "#16a34a" },
  { key: "retrying", label: "กำลังลองใหม่", en: "Retrying", color: "#d97706" },
  { key: "failed", label: "ล้มเหลว", en: "Failed", color: "#dc2626" },
  { key: "skipped", label: "ข้าม", en: "Skipped", color: "#7c3aed" },
];

/**
 * The 5 sync KPI filter cards (Data Flow tab). Each card shows the live count for
 * one status and toggles the table filter — clicking the active card clears back to
 * "all" (Simple POS toggle behavior). Counts come from the fetched job list.
 */
export function SyncKpiCards({
  counts,
  active,
  onToggle,
}: {
  counts: SyncCountsDTO;
  active: SyncFilter;
  onToggle: (key: Exclude<SyncFilter, "all">) => void;
}) {
  return (
    <div className="flex gap-3">
      {CARD_DEFS.map((c) => {
        const isActive = active === c.key;
        return (
          <button
            key={c.key}
            type="button"
            aria-pressed={isActive}
            onClick={() => onToggle(c.key)}
            className="flex-1 rounded-[14px] border px-4 py-[14px] text-left transition"
            style={{ background: "#fff", borderColor: isActive ? c.color : "#e8edf3", borderWidth: 1.5 }}
          >
            <div className="mono text-[28px] font-bold leading-none" style={{ color: c.color }}>
              {counts[c.key]}
            </div>
            <div className="mt-1 text-[13px] font-semibold" style={{ color: "#334155" }}>
              {c.label}
            </div>
            <div className="text-[11px]" style={{ color: "#94a3b8" }}>
              {c.en}
            </div>
          </button>
        );
      })}
    </div>
  );
}

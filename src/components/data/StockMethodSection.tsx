"use client";

import { STOCK_METHOD_DEFS } from "./mappingData";
import type { StockMethod } from "./connectionTypes";

/**
 * Stock-accounting-method section (LATENT). Two radio-style option cards —
 * **perpetual (default)** / periodic. Built from the Simple POS stockMethods +
 * Taste; flips client state + toast in the parent.
 */
export function StockMethodSection({
  value,
  onChange,
}: {
  value: StockMethod;
  onChange: (m: StockMethod) => void;
}) {
  return (
    <div
      className="rounded-2xl border px-5 py-[18px]"
      style={{ background: "#fff", borderColor: "#e8edf3" }}
    >
      <div className="mb-3">
        <div className="text-[14px] font-bold">วิธีลงบัญชีสต็อก · Stock costing</div>
        <div className="text-[11.5px]" style={{ color: "#94a3b8" }}>
          เลือกวิธีลงต้นทุน/มูลค่าสต็อกเข้าบัญชี
        </div>
      </div>
      <div role="radiogroup" aria-label="วิธีลงบัญชีสต็อก" className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {STOCK_METHOD_DEFS.map((m) => {
          const active = value === m.key;
          return (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(m.key)}
              className="flex flex-col gap-1.5 rounded-[14px] border p-4 text-left transition"
              style={{
                borderColor: active ? "#16a34a" : "#e2e8f0",
                background: active ? "#f0fdf4" : "#fff",
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="grid place-items-center rounded-full"
                  style={{
                    width: 18,
                    height: 18,
                    border: `2px solid ${active ? "#16a34a" : "#cbd5e1"}`,
                  }}
                >
                  {active ? (
                    <span style={{ width: 8, height: 8, borderRadius: 99, background: "#16a34a" }} />
                  ) : null}
                </span>
                <span className="text-[13.5px] font-bold" style={{ color: "#0f172a" }}>
                  {m.label}
                </span>
                {m.key === "perpetual" ? (
                  <span
                    className="rounded-[6px] px-1.5 py-0.5 text-[10px] font-semibold"
                    style={{ background: "#eff6ff", color: "#1d4ed8" }}
                  >
                    ค่าเริ่มต้น
                  </span>
                ) : null}
              </div>
              <div className="text-[11px]" style={{ color: "#94a3b8" }}>
                {m.en}
              </div>
              <div className="text-[12px] leading-relaxed" style={{ color: "#64748b" }}>
                {m.desc}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

"use client";

import { ArrowRight, ArrowLeft, ArrowUp, Database, AlertTriangle } from "lucide-react";
import {
  MAP_OUT,
  MAPPING_INCOMPLETE,
} from "./mappingData";
import { ProductImportMappingSection } from "./ProductImportMappingSection";
import { AccountMappingSection } from "./AccountMappingSection";
import { SyncModeSection } from "./SyncModeSection";
import { StockMethodSection } from "./StockMethodSection";
import type { SyncMode, StockMethod } from "./connectionTypes";

/**
 * Field Mapping tab (KRS Data Link). The POS↔KRS flow diagram + the outbound (7-row)
 * static field table, then the REAL, persisted inbound PRODUCT_IMPORT mapping editor
 * (krs-sync inbound import config — source-table + per-field column dropdowns, saved
 * via /api/krs/mappings; the previously-static inbound diagram is replaced by it).
 * A mapping-incomplete warning banner + the LATENT account-mapping / sync-mode /
 * stock-method sections follow. Inbound mapping is now interactive (PRODUCT_IMPORT);
 * the outbound table + latent sections remain static (the real outbound pipeline is
 * a later phase).
 */
export function FieldMappingTab({
  syncMode,
  onSyncMode,
  stockMethod,
  onStockMethod,
}: {
  syncMode: SyncMode;
  onSyncMode: (m: SyncMode) => void;
  stockMethod: StockMethod;
  onStockMethod: (m: StockMethod) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {/* Flow diagram */}
      <div
        className="rounded-2xl border px-6 py-[22px]"
        style={{ background: "#fff", borderColor: "#e8edf3" }}
      >
        <div className="flex items-center gap-[18px]">
          <div style={{ width: 150, flexShrink: 0 }}>
            <div
              className="rounded-[12px] border p-[14px] text-center"
              style={{ borderColor: "#0f172a", borderWidth: 1.5, background: "#f8fafc" }}
            >
              <div className="text-[14px] font-bold" style={{ color: "#0f172a" }}>
                POS System
              </div>
              <div className="mt-0.5 text-[10.5px]" style={{ color: "#94a3b8" }}>
                KRS Simple POS
              </div>
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-[14px]">
            <div className="flex items-center gap-[10px]">
              <div
                className="relative h-[2px] flex-1"
                style={{ background: "linear-gradient(90deg,#bbf7d0,#16a34a)" }}
              >
                <div
                  className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap bg-white px-2 text-[11px] font-semibold"
                  style={{ top: -9, color: "#15803d" }}
                >
                  Map field ให้ตรง → insert กลับ
                </div>
              </div>
              <ArrowRight size={18} strokeWidth={2.4} color="#16a34a" />
            </div>
            <div className="flex items-center gap-[10px]">
              <ArrowLeft size={18} strokeWidth={2.4} color="#2563eb" />
              <div
                className="relative h-[2px] flex-1"
                style={{ background: "linear-gradient(90deg,#2563eb,#bfdbfe)" }}
              >
                <div
                  className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap bg-white px-2 text-[11px] font-semibold"
                  style={{ top: -9, color: "#1d4ed8" }}
                >
                  ดึงฐานข้อมูลมา
                </div>
              </div>
            </div>
          </div>

          <div
            className="flex flex-col items-center"
            style={{ width: 120, flexShrink: 0, color: "#0f766e" }}
          >
            <Database size={56} strokeWidth={1.5} />
            <div className="mt-1.5 text-[15px] font-bold" style={{ color: "#0f172a" }}>
              KRS
            </div>
            <div className="text-[10px]" style={{ color: "#94a3b8" }}>
              ฐานข้อมูลกลาง
            </div>
          </div>
        </div>
      </div>

      {/* Outbound table */}
      <div
        className="rounded-2xl border px-5 py-[18px]"
        style={{ background: "#fff", borderColor: "#e8edf3" }}
      >
        <div className="mb-[13px] flex items-center gap-[9px]">
          <span
            className="grid h-[26px] w-[26px] place-items-center rounded-[7px]"
            style={{ background: "#f0fdf4", color: "#15803d" }}
          >
            <ArrowUp size={15} strokeWidth={2.2} />
          </span>
          <span className="text-[14px] font-bold">ขาออก · POS → KRS</span>
          <span className="text-[11.5px]" style={{ color: "#94a3b8" }}>
            map field ให้ตรง แล้ว insert กลับ
          </span>
        </div>
        <div
          className="grid gap-[10px] border-b py-2 text-[11.5px] font-semibold"
          style={{ gridTemplateColumns: "1.1fr 1.5fr 1.1fr 1fr 110px", borderColor: "#eef2f6", color: "#94a3b8" }}
        >
          <div>POS field</div>
          <div>KRS column</div>
          <div>ชนิดข้อมูล</div>
          <div>ความหมาย</div>
          <div>สถานะ</div>
        </div>
        {MAP_OUT.map((m) => (
          <div
            key={m.pos}
            className="grid items-center gap-[10px] border-b py-[11px]"
            style={{ gridTemplateColumns: "1.1fr 1.5fr 1.1fr 1fr 110px", borderColor: "#f4f7fa" }}
          >
            <div className="mono text-[12px] font-semibold" style={{ color: "#334155" }}>
              {m.pos}
            </div>
            <div className="flex items-center gap-[7px]">
              <ArrowRight size={14} strokeWidth={2} color="#cbd5e1" />
              <span className="mono text-[12px]" style={{ color: m.ok ? "#334155" : "#dc2626" }}>
                {m.krs}
              </span>
            </div>
            <div className="mono text-[11.5px]" style={{ color: "#94a3b8" }}>
              {m.type}
            </div>
            <div className="text-[12px]" style={{ color: "#64748b" }}>
              {m.note}
            </div>
            <div>
              <span
                className="rounded-[7px] px-[9px] py-1 text-[11px] font-semibold"
                style={{
                  background: m.ok ? "#f0fdf4" : "#fef2f2",
                  color: m.ok ? "#15803d" : "#b91c1c",
                }}
              >
                {m.ok ? "จับคู่แล้ว" : "ยังไม่จับคู่"}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Inbound — REAL, persisted PRODUCT_IMPORT mapping editor (replaces the
          previously-static inbound KRS → POS diagram). Source-table + per-field
          column dropdowns saved via /api/krs/mappings; the "ดึงสินค้าจาก KRS" pull
          uses the saved mapping automatically. */}
      <ProductImportMappingSection />

      {/* Mapping-incomplete warning (state-mapping-incomplete) */}
      {MAPPING_INCOMPLETE ? (
        <div
          className="flex items-start gap-[10px] rounded-[12px] border px-[14px] py-[12px]"
          style={{ background: "#fffbeb", borderColor: "#fde68a" }}
        >
          <AlertTriangle size={17} strokeWidth={2} color="#d97706" className="mt-0.5 shrink-0" />
          <div className="text-[12px] leading-relaxed" style={{ color: "#a16207" }}>
            <b>ยังจับคู่ไม่ครบ:</b> ฟิลด์ <span className="mono">vat_code</span> →{" "}
            <span className="mono">KRS.sales.tax_code</span>, สินค้า{" "}
            <span className="mono">DS-001</span> (บราวนี่) ยังไม่ผูกบัญชีรายได้, และ{" "}
            <b>e-Wallet</b> ยังไม่ผูกบัญชีเงิน — รายการที่เกี่ยวข้องจะส่งเข้า KRS ไม่สำเร็จจนกว่าจะจับคู่ครบ
          </div>
        </div>
      ) : null}

      {/* LATENT sections */}
      <AccountMappingSection />
      <SyncModeSection value={syncMode} onChange={onSyncMode} />
      <StockMethodSection value={stockMethod} onChange={onStockMethod} />
    </div>
  );
}

"use client";

import { Database, RefreshCw, Plus, Boxes } from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import type { DbState } from "./connectionTypes";

/**
 * Connection tab (KRS Data Link). Pure CLIENT state (decision B/C) — no server
 * write. testConnection/insertTestRow/SSL/stock-sync are all simulated React-state
 * flips with toasts; the only DB-backed work on /data is the SyncJob CRUD on the
 * other tabs. Ported from the Simple POS source-of-truth into Taste.
 */
export function ConnectionTab({
  db,
  setDb,
  testing,
  onTestConnection,
  onInsertTestRow,
  stockSync,
  onToggleStockSync,
}: {
  db: DbState;
  setDb: (patch: Partial<DbState>) => void;
  testing: boolean;
  onTestConnection: () => void;
  onInsertTestRow: () => void;
  stockSync: boolean;
  onToggleStockSync: () => void;
}) {
  const { showToast } = useToast();

  // Tri-state status card meta (Simple POS dbVals stMeta).
  const stMeta = testing
    ? { label: "กำลังทดสอบ · Testing", color: "#b45309", bg: "#fffbeb", dot: "#d97706" }
    : db.status === "connected"
      ? { label: "เชื่อมต่ออยู่ · Connected", color: "#15803d", bg: "#f0fdf4", dot: "#16a34a" }
      : { label: "ตัดการเชื่อมต่อ · Disconnected", color: "#b91c1c", bg: "#fef2f2", dot: "#dc2626" };

  const connString = `${db.engine.toLowerCase()}://${db.user}@${db.host}:${db.port}/${db.name}${
    db.ssl ? "?ssl=true" : ""
  }`;

  const toggleSsl = () => {
    const next = !db.ssl;
    setDb({ ssl: next });
    showToast(next ? "เปิด SSL/TLS · เข้ารหัสการเชื่อมต่อ" : "ปิด SSL/TLS");
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Dark status card */}
      <div
        className="flex flex-wrap items-center gap-[18px] rounded-2xl px-[22px] py-[18px]"
        style={{ background: "#0f172a" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="grid h-11 w-11 place-items-center rounded-[11px]"
            style={{ background: "#1e293b", color: "#7dd3fc" }}
          >
            <Database size={22} strokeWidth={1.8} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span
                style={{ width: 9, height: 9, borderRadius: 99, background: stMeta.dot }}
              />
              <span className="text-[15px] font-bold text-white">{stMeta.label}</span>
            </div>
            <div className="mono mt-0.5 text-[11.5px]" style={{ color: "#94a3b8" }}>
              KRS · {db.engine} · {db.host}:{db.port}
            </div>
          </div>
        </div>

        <div
          className="flex gap-5 border-l pl-[18px]"
          style={{ borderColor: "#1e293b" }}
        >
          <Stat label="Latency" value={`${db.latency} ms`} valueColor="#a7f3d0" />
          <Stat label="ตรวจล่าสุด" value={db.lastCheck} valueColor="#cbd5e1" />
          <Stat label="INSERT (เซสชัน)" value={String(db.inserted)} valueColor="#cbd5e1" />
        </div>

        <div className="flex-1" />

        <div className="flex gap-[9px]">
          <button
            type="button"
            onClick={onTestConnection}
            disabled={testing}
            className="flex h-[42px] items-center gap-2 rounded-[11px] px-4 text-[13px] font-semibold text-white transition hover:bg-[#334155] disabled:opacity-60"
            style={{ background: "#1e293b" }}
          >
            <RefreshCw size={16} strokeWidth={2} color="#7dd3fc" />
            {testing ? "กำลังทดสอบ..." : "ทดสอบการเชื่อมต่อ"}
          </button>
          <button
            type="button"
            onClick={onInsertTestRow}
            className="flex h-[42px] items-center gap-2 rounded-[11px] px-4 text-[13px] font-semibold text-white transition hover:brightness-110"
            style={{ background: "#16a34a", boxShadow: "0 4px 12px rgba(22,163,74,.3)" }}
          >
            <Plus size={16} strokeWidth={2} />
            ทดลอง INSERT
          </button>
        </div>
      </div>

      {/* Config + connection string */}
      <div className="grid gap-4" style={{ gridTemplateColumns: "1.25fr 1fr" }}>
        <div
          className="rounded-2xl border px-5 py-[18px]"
          style={{ background: "#fff", borderColor: "#e8edf3" }}
        >
          <div className="mb-[14px] text-[14.5px] font-bold">
            ตั้งค่าการเชื่อมต่อ KRS · Connection
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
            <Field
              full
              label="Host / IP Address"
              value={db.host}
              onChange={(v) => setDb({ host: v })}
            />
            <Field label="Port" value={db.port} onChange={(v) => setDb({ port: v })} />
            <div>
              <FieldLabel>Engine</FieldLabel>
              <div
                className="flex h-[42px] items-center rounded-[10px] border px-3 text-[13.5px] font-medium"
                style={{ background: "#f8fafc", borderColor: "#e2e8f0", color: "#334155" }}
              >
                {db.engine}
              </div>
            </div>
            <Field label="Database" value={db.name} onChange={(v) => setDb({ name: v })} />
            <Field label="Username" value={db.user} onChange={(v) => setDb({ user: v })} />

            {/* SSL toggle */}
            <div
              className="col-span-full flex items-center justify-between rounded-[10px] px-3 py-[10px]"
              style={{ background: "#f8fafc" }}
            >
              <div>
                <div className="text-[13px] font-semibold" style={{ color: "#334155" }}>
                  SSL / TLS
                </div>
                <div className="text-[11px]" style={{ color: "#94a3b8" }}>
                  เข้ารหัสการเชื่อมต่อ KRS
                </div>
              </div>
              <Toggle on={db.ssl} onClick={toggleSsl} ariaLabel="SSL/TLS" small />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div
            className="rounded-2xl border px-5 py-[18px]"
            style={{ background: "#fff", borderColor: "#e8edf3" }}
          >
            <div className="mb-[9px] text-[13px] font-bold">Connection string</div>
            <div
              className="mono break-all rounded-[9px] border px-3 py-[11px] text-[11.5px] leading-relaxed"
              style={{ color: "#0f766e", background: "#f0fdfa", borderColor: "#ccfbf1" }}
            >
              {connString}
            </div>
            <div
              className="mt-[11px] flex items-center gap-2 text-[11.5px]"
              style={{ color: "#15803d" }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 99, background: "#16a34a" }} />
              POS backend ↔ KRS · pool 8/20 connections
            </div>
            {db.lastInsert ? (
              <div className="mono mt-2 text-[11px]" style={{ color: "#94a3b8" }}>
                ล่าสุด INSERT: {db.lastInsert}
              </div>
            ) : null}
          </div>

          {/* Realtime stock-sync toggle */}
          <div
            className="flex items-center gap-3 rounded-2xl border px-[18px] py-[14px]"
            style={{ background: "#fff", borderColor: "#e8edf3" }}
          >
            <div
              className="grid h-[38px] w-[38px] place-items-center rounded-[10px]"
              style={{ background: "#eff6ff", color: "#2563eb" }}
            >
              <Boxes size={19} strokeWidth={2} />
            </div>
            <div className="flex-1">
              <div className="text-[13px] font-semibold" style={{ color: "#334155" }}>
                ซิงค์สต็อกเรียลไทม์
              </div>
              <div className="text-[11px]" style={{ color: "#94a3b8" }}>
                ขาย/รับเข้า → ส่งขึ้น KRS ทันที
              </div>
            </div>
            <span
              className="rounded-[7px] px-[10px] py-1 text-[11px] font-semibold"
              style={{
                background: stockSync ? "#f0fdf4" : "#f1f5f9",
                color: stockSync ? "#15803d" : "#94a3b8",
              }}
            >
              {stockSync ? "เปิดใช้งาน · On" : "ปิด · Off"}
            </span>
            <Toggle on={stockSync} onClick={onToggleStockSync} ariaLabel="ซิงค์สต็อกเรียลไทม์" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string;
  valueColor: string;
}) {
  return (
    <div>
      <div className="text-[10.5px]" style={{ color: "#64748b" }}>
        {label}
      </div>
      <div className="mono text-[15px] font-semibold" style={{ color: valueColor }}>
        {value}
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-[5px] text-[11.5px] font-semibold" style={{ color: "#64748b" }}>
      {children}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  full,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  full?: boolean;
}) {
  return (
    <div className={full ? "col-span-full" : undefined}>
      <FieldLabel>{label}</FieldLabel>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mono h-[42px] w-full rounded-[10px] border px-3 text-[13.5px]"
        style={{ borderColor: "#e2e8f0" }}
        aria-label={label}
      />
    </div>
  );
}

function Toggle({
  on,
  onClick,
  ariaLabel,
  small,
}: {
  on: boolean;
  onClick: () => void;
  ariaLabel: string;
  small?: boolean;
}) {
  const w = small ? 42 : 46;
  const h = small ? 24 : 26;
  const knob = small ? 18 : 20;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      onClick={onClick}
      style={{
        width: w,
        height: h,
        borderRadius: 99,
        padding: 3,
        border: 0,
        cursor: "pointer",
        display: "flex",
        transition: "all .15s",
        background: on ? "#16a34a" : "#cbd5e1",
        justifyContent: on ? "flex-end" : "flex-start",
      }}
    >
      <span
        style={{
          width: knob,
          height: knob,
          borderRadius: 99,
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,.2)",
        }}
      />
    </button>
  );
}

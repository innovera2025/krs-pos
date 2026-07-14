"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { PromotionType } from "@/types";
import { money } from "@/lib/money";
import { PROMO_META } from "@/components/promotions/promotionMeta";

/**
 * Report tab for the /promotions screen (promotions program, Phase 9). A read-only
 * date-range promotion sales report backed by GET /api/promotions/report. Owner-only
 * (the whole page is wrapped in <AdminOnly strict>). Money values arrive as 2dp
 * baht STRINGS from the API (integer-satang discipline) and render via lib/money.
 *
 * Promotion accent = the MINT family (var(--brand)/var(--brand-2)); blue stays
 * reserved for manual discounts — consistent with the rest of the promotions UI.
 */

type ReportRow = {
  promotionId: string;
  promotionName: string | null;
  type: PromotionType | null;
  level: "LINE" | "BILL";
  orders: number;
  discount: string;
  sales: string;
};

type ReportData = {
  range: { from: string; to: string };
  ordersTotal: number;
  ordersWithPromo: number;
  promoDiscountTotal: string;
  rows: ReportRow[];
};

type LoadState = "loading" | "ready" | "error";
type Preset = "today" | "last7" | "month" | null;

/** `YYYY-MM-DD` for today in the Asia/Bangkok calendar. */
function bangkokToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Shift a `YYYY-MM-DD` calendar date by `delta` days (UTC math → no DST drift). */
function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** First day of the month for a `YYYY-MM-DD` calendar date. */
function firstOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
}

/** Resolve a preset to its inclusive [from, to] Bangkok calendar range. */
function presetRange(preset: Exclude<Preset, null>): { from: string; to: string } {
  const today = bangkokToday();
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "month":
      return { from: firstOfMonth(today), to: today };
  }
}

const LEVEL_LABEL: Record<ReportRow["level"], string> = {
  LINE: "ต่อสินค้า",
  BILL: "ท้ายบิล",
};

const SALES_TITLE =
  "ต่อสินค้า = ยอดขายของรายการที่ติดโปร, ท้ายบิล = ยอดทั้งบิลที่ใช้โปร";

export function PromotionReportTab() {
  const initial = presetRange("today");
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [preset, setPreset] = useState<Preset>("today");

  const [data, setData] = useState<ReportData | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  // Monotonic request token so a slow earlier fetch can never overwrite a newer one.
  const reqIdRef = useRef(0);

  async function load(fromStr: string, toStr: string) {
    const reqId = ++reqIdRef.current;
    setLoadState("loading");
    try {
      const res = await fetch(
        `/api/promotions/report?from=${encodeURIComponent(fromStr)}&to=${encodeURIComponent(toStr)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as ReportData;
      if (reqId !== reqIdRef.current) return; // superseded by a newer request
      setData(json);
      setLoadState("ready");
    } catch {
      if (reqId !== reqIdRef.current) return;
      setLoadState("error");
    }
  }

  useEffect(() => {
    load(from, to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  function applyPreset(next: Exclude<Preset, null>) {
    const range = presetRange(next);
    setPreset(next);
    setFrom(range.from);
    setTo(range.to);
  }

  function onFromChange(v: string) {
    if (!v) return;
    setPreset(null);
    setFrom(v);
  }
  function onToChange(v: string) {
    if (!v) return;
    setPreset(null);
    setTo(v);
  }

  const shareLabel =
    data && data.ordersTotal > 0
      ? `${Math.round((data.ordersWithPromo / data.ordersTotal) * 100)}%`
      : "0%";

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Range picker: preset pills + native from/to inputs. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <RangePill active={preset === "today"} onClick={() => applyPreset("today")}>
            วันนี้
          </RangePill>
          <RangePill active={preset === "last7"} onClick={() => applyPreset("last7")}>
            7 วันล่าสุด
          </RangePill>
          <RangePill active={preset === "month"} onClick={() => applyPreset("month")}>
            เดือนนี้
          </RangePill>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label
            className="flex h-11 items-center gap-2 rounded-[12px] border bg-white px-3 text-[13px]"
            style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
          >
            <span style={{ color: "var(--muted)" }}>จาก</span>
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => onFromChange(e.target.value)}
              aria-label="วันที่เริ่มต้น"
              className="border-0 bg-transparent text-[13px] font-medium outline-none"
              style={{ color: "var(--ink)" }}
            />
          </label>
          <label
            className="flex h-11 items-center gap-2 rounded-[12px] border bg-white px-3 text-[13px]"
            style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
          >
            <span style={{ color: "var(--muted)" }}>ถึง</span>
            <input
              type="date"
              value={to}
              min={from}
              onChange={(e) => onToChange(e.target.value)}
              aria-label="วันที่สิ้นสุด"
              className="border-0 bg-transparent text-[13px] font-medium outline-none"
              style={{ color: "var(--ink)" }}
            />
          </label>
        </div>
      </div>

      {/* Summary strip — 3 stat tiles (Z-report card style). */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="ส่วนลดโปรรวม · Promo discount"
          value={`−${money(Math.abs(Number(data?.promoDiscountTotal ?? 0)))}`}
          tone="mint"
        />
        <StatTile
          label="บิลที่มีโปร · Bills with promo"
          value={
            data ? `${data.ordersWithPromo} / ${data.ordersTotal} บิล` : "— / — บิล"
          }
        />
        <StatTile
          label="สัดส่วนบิลมีโปร · Promo share"
          value={data ? shareLabel : "0%"}
        />
      </div>

      {/* Report table / states. */}
      <section
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[18px] border bg-white"
        style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
      >
        {loadState === "loading" ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            กำลังโหลดรายงาน…
          </div>
        ) : loadState === "error" ? (
          <div
            className="mx-auto flex max-w-[320px] flex-1 flex-col items-center justify-center gap-3 py-16 text-center"
            style={{ color: "var(--muted)" }}
          >
            <span
              className="grid h-[64px] w-[64px] place-items-center rounded-[22px]"
              style={{ background: "var(--red-soft)", color: "#dc2626" }}
            >
              <AlertTriangle size={28} strokeWidth={2} />
            </span>
            <strong className="text-[14px]" style={{ color: "var(--ink)" }}>
              โหลดรายงานไม่สำเร็จ
            </strong>
            <button
              type="button"
              onClick={() => load(from, to)}
              className="h-10 rounded-[12px] border px-4 text-[13px] font-semibold"
              style={{ borderColor: "var(--line)" }}
            >
              ลองใหม่
            </button>
          </div>
        ) : !data || data.rows.length === 0 ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            ไม่มียอดขายที่ใช้โปรโมชันในช่วงที่เลือก
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr
                  className="sticky top-0 z-10 text-left"
                  style={{ background: "var(--surface-2)", color: "var(--muted)" }}
                >
                  <Th>โปรโมชัน</Th>
                  <Th>ระดับ</Th>
                  <Th className="text-right">จำนวนบิล</Th>
                  <Th className="text-right">ยอดลด</Th>
                  <Th className="text-right">ยอดขายที่ร่วมโปร</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <ReportTableRow key={r.promotionId} row={r} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function ReportTableRow({ row }: { row: ReportRow }) {
  const meta = row.type ? PROMO_META[row.type] : null;
  const Icon = meta?.icon;
  return (
    <tr className="border-t" style={{ borderColor: "var(--line)" }}>
      <Td>
        <div className="flex flex-col gap-1">
          <span className="font-semibold">{row.promotionName ?? "โปรโมชัน"}</span>
          {meta && Icon && (
            <span
              className="inline-flex w-fit items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
              style={{ background: "var(--mint)", color: "var(--brand-2)" }}
            >
              <Icon size={13} strokeWidth={2} />
              {meta.labelTh}
            </span>
          )}
        </div>
      </Td>
      <Td>
        <span style={{ color: "var(--muted)" }}>{LEVEL_LABEL[row.level]}</span>
      </Td>
      <Td className="text-right">
        <span className="mono" style={{ color: "var(--ink)" }}>
          {row.orders}
        </span>
      </Td>
      <Td className="text-right">
        <span className="mono font-semibold" style={{ color: "var(--brand-2)" }}>
          −{money(Math.abs(Number(row.discount)))}
        </span>
      </Td>
      <Td className="text-right">
        <span className="mono" style={{ color: "var(--ink)" }} title={SALES_TITLE}>
          {money(Number(row.sales))}
        </span>
      </Td>
    </tr>
  );
}

function StatTile({
  label,
  value,
  tone = "plain",
}: {
  label: string;
  value: string;
  tone?: "mint" | "plain";
}) {
  const mint = tone === "mint";
  return (
    <div
      className="rounded-[14px] border px-4 py-3.5"
      style={{
        background: mint ? "var(--mint)" : "#fff",
        borderColor: "var(--line)",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        className="text-[12px]"
        style={{ color: mint ? "var(--brand-2)" : "var(--muted)" }}
      >
        {label}
      </div>
      <div
        className="mono mt-[3px] text-[20px] font-bold"
        style={{ color: mint ? "var(--brand-2)" : "var(--ink)" }}
      >
        {value}
      </div>
    </div>
  );
}

function RangePill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-9 rounded-full px-3.5 text-[12.5px] font-semibold transition"
      style={
        active
          ? { background: "var(--brand)", color: "#fff" }
          : { background: "#fff", color: "var(--muted)", border: "1px solid var(--line)" }
      }
    >
      {children}
    </button>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-4 py-2.5 text-[11.5px] font-semibold uppercase tracking-wide ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}

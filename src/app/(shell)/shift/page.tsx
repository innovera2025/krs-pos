"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Clock3 } from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import { KpiCards } from "@/components/shift/KpiCards";
import { PaymentMethodBreakdown } from "@/components/shift/PaymentMethodBreakdown";
import { ShiftSummaryCard } from "@/components/shift/ShiftSummaryCard";
import {
  PromotionSummaryCard,
  type ZReportPromoFields,
} from "@/components/shift/PromotionSummaryCard";
import { CashCountingPanel } from "@/components/shift/CashCountingPanel";
import type { ShiftResponse, ZReportDTO } from "@/types";

type LoadState = "loading" | "ready" | "error";

export default function ShiftPage() {
  const { showToast } = useToast();

  const [data, setData] = useState<ShiftResponse | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");

  // Cash-counting input + close lifecycle.
  const [counted, setCounted] = useState("");
  const [closing, setClosing] = useState(false);
  const [dailySummaryNo, setDailySummaryNo] = useState<string | null>(null);

  // Open-shift affordance (when no shift is open).
  const [openingFloat, setOpeningFloat] = useState("2000");
  const [opening, setOpening] = useState(false);

  async function loadShift() {
    setLoadState("loading");
    try {
      const res = await fetch("/api/shift");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as ShiftResponse;
      setData(payload);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  useEffect(() => {
    loadShift();
  }, []);

  // ---- open a shift ----
  async function openShift() {
    if (opening) return;
    const floatNum = Number(openingFloat);
    if (!Number.isFinite(floatNum) || floatNum < 0) {
      showToast("เงินทอนเปิดรอบไม่ถูกต้อง");
      return;
    }
    setOpening(true);
    try {
      const res = await fetch("/api/shift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "open", openingFloat: floatNum }),
      });
      if (!res.ok) {
        let msg = "เปิดรอบไม่สำเร็จ";
        try {
          const d = await res.json();
          if (d?.error) msg = d.error;
        } catch {
          /* keep default */
        }
        showToast(msg);
        return;
      }
      const payload = (await res.json()) as ShiftResponse;
      setData(payload);
      setDailySummaryNo(null);
      setCounted("");
      showToast("เปิดรอบใหม่แล้ว");
    } catch {
      showToast("เปิดรอบไม่สำเร็จ");
    } finally {
      setOpening(false);
    }
  }

  // ---- close the shift (POST close → daily summary number) ----
  async function closeShift() {
    if (closing) return;
    setClosing(true);
    try {
      const res = await fetch("/api/shift", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "close",
          countedCash: counted.trim() === "" ? null : Number(counted),
        }),
      });
      if (!res.ok) {
        let msg = "ปิดรอบไม่สำเร็จ";
        try {
          const d = await res.json();
          if (d?.error) msg = d.error;
        } catch {
          /* keep default */
        }
        showToast(msg);
        return;
      }
      const payload = (await res.json()) as { dailySummaryNo?: string };
      setDailySummaryNo(payload.dailySummaryNo ?? null);
      showToast(
        `ปิดรอบเรียบร้อย ✓ สร้างสรุปบัญชีรายวัน ${payload.dailySummaryNo ?? ""} แล้ว`
      );
      // Refresh so the now-CLOSED shift re-renders the OpenShiftAffordance branch
      // (offering "เปิดรอบใหม่") instead of dead-ending on the disabled close panel.
      await loadShift();
    } catch {
      showToast("ปิดรอบไม่สำเร็จ");
    } finally {
      setClosing(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-[22px]">
      <header className="mb-4 flex flex-wrap items-center gap-3.5">
        <div className="min-w-[220px] flex-1">
          <h1 className="m-0 text-[24px] font-bold leading-[1.08] tracking-tight">
            ปิดรอบขาย
          </h1>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
            Shift Close · Z-report · นับเงินสด · สรุปบัญชีรายวัน
          </p>
        </div>
      </header>

      {loadState === "loading" ? (
        <div
          className="grid place-items-center py-24 text-center text-[13px]"
          style={{ color: "var(--soft)" }}
        >
          กำลังโหลดข้อมูลรอบขาย…
        </div>
      ) : loadState === "error" ? (
        <div
          className="mx-auto flex max-w-[320px] flex-col items-center justify-center gap-3 py-24 text-center"
          style={{ color: "var(--muted)" }}
        >
          <span
            className="grid h-[64px] w-[64px] place-items-center rounded-[22px]"
            style={{ background: "var(--red-soft)", color: "#dc2626" }}
          >
            <AlertTriangle size={28} strokeWidth={2} />
          </span>
          <strong className="text-[14px]" style={{ color: "var(--ink)" }}>
            โหลดข้อมูลรอบขายไม่สำเร็จ
          </strong>
          <button
            type="button"
            onClick={loadShift}
            className="h-10 rounded-[12px] border px-4 text-[13px] font-semibold"
            style={{ borderColor: "var(--line)" }}
          >
            ลองใหม่
          </button>
        </div>
      ) : !data || !data.shift || !data.zReport || data.shift.status === "CLOSED" ? (
        <OpenShiftAffordance
          openingFloat={openingFloat}
          onOpeningFloatChange={setOpeningFloat}
          opening={opening}
          onOpen={openShift}
          lastClosed={data?.shift?.status === "CLOSED" ? data.shift.shiftNumber : null}
          dailySummaryNo={dailySummaryNo}
        />
      ) : (
        <div
          className="grid max-w-[1100px] gap-[18px]"
          style={{ gridTemplateColumns: "1.3fr 1fr" }}
        >
          {/* Left column: KPI + by-method + summary cards */}
          <div className="flex flex-col gap-4">
            <KpiCards
              grossSales={data.zReport.grossSales}
              shiftNumber={data.shift.shiftNumber}
              openedAt={data.shift.openedAt}
              txnCount={data.zReport.txnCount}
            />
            <PaymentMethodBreakdown methods={data.zReport.byMethod} />
            <ShiftSummaryCard
              refundsTotal={data.zReport.refundsTotal}
              discountsTotal={data.zReport.discountsTotal}
              vatTotal={data.zReport.vatTotal}
            />
            {/* Promotions program (Phase 8): the Z-report payload is extended with
                the promo/manual split + per-promotion breakdown. Cast to the
                locally-defined ZReportPromoFields (the shared ZReportDTO is not
                edited this phase — the POS UI file is changing concurrently). */}
            <PromotionSummaryCard
              zReport={data.zReport as ZReportDTO & ZReportPromoFields}
            />
          </div>

          {/* Right column: cash counting + close */}
          <CashCountingPanel
            openingFloat={data.zReport.openingFloat}
            cashSales={data.zReport.cashSales}
            cashRefunds={data.zReport.cashRefunds}
            expectedCash={data.zReport.expectedCash}
            counted={counted}
            onCountedChange={setCounted}
            closing={closing}
            onClose={closeShift}
            dailySummaryNo={dailySummaryNo}
          />
        </div>
      )}
    </div>
  );
}

function OpenShiftAffordance({
  openingFloat,
  onOpeningFloatChange,
  opening,
  onOpen,
  lastClosed,
  dailySummaryNo,
}: {
  openingFloat: string;
  onOpeningFloatChange: (value: string) => void;
  opening: boolean;
  onOpen: () => void;
  lastClosed: string | null;
  dailySummaryNo: string | null;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-12 text-center">
      {dailySummaryNo ? (
        <div
          className="w-full rounded-[12px] border px-4 py-3 text-left text-[13px] font-semibold"
          style={{ background: "var(--mint)", borderColor: "var(--line)", color: "var(--brand-2)" }}
        >
          ปิดรอบเรียบร้อย ✓ สร้างสรุปบัญชีรายวัน {dailySummaryNo} แล้ว
        </div>
      ) : null}
      <span
        className="grid h-[64px] w-[64px] place-items-center rounded-[22px]"
        style={{ background: "var(--mint)", color: "var(--brand-2)" }}
      >
        <Clock3 size={28} strokeWidth={2} />
      </span>
      <div>
        <strong className="text-[16px]" style={{ color: "var(--ink)" }}>
          ยังไม่มีรอบที่เปิดอยู่
        </strong>
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
          {lastClosed
            ? `รอบล่าสุด ${lastClosed} ปิดแล้ว — เปิดรอบใหม่เพื่อเริ่มขาย`
            : "เปิดรอบใหม่เพื่อเริ่มขายและนับเงินสด"}
        </p>
      </div>
      <div
        className="w-full rounded-[16px] border bg-white p-5 text-left"
        style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
      >
        <div className="mb-1.5 text-[13px]" style={{ color: "var(--soft)" }}>
          เงินทอนเปิดรอบ · Opening float
        </div>
        <div
          className="flex h-[52px] items-center gap-2 rounded-[11px] border px-3.5"
          style={{ borderColor: "var(--line)", borderWidth: 1.5 }}
        >
          <span className="mono text-[18px]" style={{ color: "var(--soft)" }}>
            ฿
          </span>
          <input
            value={openingFloat}
            onChange={(e) => onOpeningFloatChange(e.target.value)}
            type="number"
            inputMode="decimal"
            placeholder="0.00"
            aria-label="เงินทอนเปิดรอบ"
            className="mono min-w-0 flex-1 border-0 bg-transparent text-right text-[22px] font-semibold outline-none"
          />
        </div>
        <button
          type="button"
          onClick={onOpen}
          disabled={opening}
          className="mt-4 flex h-12 w-full items-center justify-center rounded-[13px] text-[14px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
          style={{ background: "var(--brand)", boxShadow: "var(--shadow-sm)" }}
        >
          {opening ? "กำลังเปิดรอบ…" : "เปิดรอบใหม่ · Open shift"}
        </button>
      </div>
    </div>
  );
}

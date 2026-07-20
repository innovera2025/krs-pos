"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, AlertTriangle, ReceiptText, TrendingUp, X } from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import { ReceiptModal } from "@/components/pos/ReceiptModal";
import { SalesTable } from "@/components/sales/SalesTable";
import { FilterChips } from "@/components/sales/FilterChips";
import { SaleDetailDrawer } from "@/components/sales/SaleDetailDrawer";
import { TaxInvoiceDocument } from "@/components/sales/TaxInvoiceDocument";
import { matchesFilter, type SalesFilter } from "@/components/sales/saleMeta";
import { printReceiptWithSize } from "@/lib/receiptPrint";
import { bangkokLocalInputToInstant } from "@/lib/datetime";
import { money } from "@/lib/money";
import type { OrderDTO, SellerConfigDTO, ShopSettingsDTO } from "@/types";

type LoadState = "loading" | "ready" | "error";

/** The range summary the orders API returns (COMPLETED-only, whole range). */
type RangeSummary = { billCount: number; totalSales: string };

/** Quick-pick presets for the date+time range (mirrors the promotions report tab). */
type RangePreset = "today" | "last7" | "month";

/** Current Asia/Bangkok wall-clock calendar date as "YYYY-MM-DD". */
function bangkokTodayDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Current Asia/Bangkok wall-clock as a datetime-local value "YYYY-MM-DDTHH:mm". */
function bangkokNowLocal(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** Shift a "YYYY-MM-DD" calendar date by `delta` days (UTC math → no DST drift). */
function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** First day of the month for a "YYYY-MM-DD" calendar date. */
function firstOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split("-").map(Number);
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/**
 * Resolve a preset to its [from, to] datetime-local bounds. Every preset spans
 * 00:00 of the start day → NOW (Bangkok wall-clock), so the chips fill both the
 * date AND time boundaries the two datetime-local inputs expect.
 */
function presetRange(preset: RangePreset): { from: string; to: string } {
  const today = bangkokTodayDate();
  const now = bangkokNowLocal();
  switch (preset) {
    case "today":
      return { from: `${today}T00:00`, to: now };
    case "last7":
      return { from: `${addDays(today, -6)}T00:00`, to: now };
    case "month":
      return { from: `${firstOfMonth(today)}T00:00`, to: now };
  }
}

export default function SalesPage() {
  const { showToast } = useToast();

  const [orders, setOrders] = useState<OrderDTO[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SalesFilter>("all");

  // Date+time range filter (Sales History range filter). Empty strings = no range
  // (default = today's behavior). `fromLocal`/`toLocal` are Asia/Bangkok wall-clock
  // datetime-local values; the server receives UTC instants (converted on fetch).
  // `preset` highlights the active quick-pick chip (null once a manual edit clears
  // it). `summary` is the server aggregate for the WHOLE range (COMPLETED-only).
  const [fromLocal, setFromLocal] = useState("");
  const [toLocal, setToLocal] = useState("");
  const [preset, setPreset] = useState<RangePreset | null>(null);
  const [summary, setSummary] = useState<RangeSummary | null>(null);

  // A range is "active" once either bound is set — this gates the summary bar and
  // the clear affordance.
  const rangeActive = Boolean(fromLocal || toLocal);

  // Monotonic request token so a slow earlier fetch (e.g. rapid preset switching)
  // can never overwrite a newer one.
  const reqIdRef = useRef(0);

  // Sale-detail drawer + the order it shows.
  const [detail, setDetail] = useState<OrderDTO | null>(null);
  // refund/void request in flight (disables the drawer's action buttons).
  const [actionBusy, setActionBusy] = useState(false);

  // Reprint (action-print-from-history) reuses the thermal ReceiptModal.
  const [receiptOrder, setReceiptOrder] = useState<OrderDTO | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  // Receipt print-size settings (Receipt print-size feature). Fetched once on
  // mount so the reprint path applies the admin-configured size; null until
  // resolved → the thermal reprint falls back to the globals.css 80mm default.
  const [receiptSettings, setReceiptSettings] = useState<ShopSettingsDTO | null>(
    null
  );

  // Tax-invoice A4 document (Phase 4). The seller block is fetched once from
  // /api/seller-config (env-based, D2); null = seller not configured.
  const [taxInvoiceOrder, setTaxInvoiceOrder] = useState<OrderDTO | null>(null);
  const [taxInvoiceOpen, setTaxInvoiceOpen] = useState(false);
  const [seller, setSeller] = useState<SellerConfigDTO | null>(null);

  // Load orders (+ the range summary) for the given Bangkok wall-clock range.
  // Empty bounds = no range (default recent list). Bangkok wall-clock is converted
  // to UTC instants for the API; an unparseable bound is simply dropped (the field
  // guards its own value, and the server also 400s a bad instant defensively).
  // loadOrders OWNS loadState; the reqId token discards a superseded response.
  async function loadOrders(fromLocalVal: string, toLocalVal: string) {
    const reqId = ++reqIdRef.current;
    setLoadState("loading");
    try {
      const params = new URLSearchParams();
      const fromIso = fromLocalVal
        ? bangkokLocalInputToInstant(fromLocalVal)
        : null;
      const toIso = toLocalVal ? bangkokLocalInputToInstant(toLocalVal) : null;
      if (fromIso) params.set("from", fromIso);
      if (toIso) params.set("to", toIso);
      const qs = params.toString();
      const res = await fetch(`/api/orders${qs ? `?${qs}` : ""}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        orders: OrderDTO[];
        summary: RangeSummary;
      };
      if (reqId !== reqIdRef.current) return; // superseded by a newer request
      setOrders(Array.isArray(data.orders) ? data.orders : []);
      setSummary(data.summary ?? null);
      setLoadState("ready");
    } catch {
      if (reqId !== reqIdRef.current) return;
      setLoadState("error");
    }
  }

  // Orders load — refetches whenever the date/time range changes (and on mount
  // with the empty default range, preserving today's behavior). loadOrders owns
  // loadState and swallows its own errors into the "error" state.
  useEffect(() => {
    void loadOrders(fromLocal, toLocal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLocal, toLocal]);

  useEffect(() => {
    // Best-effort mount siblings (seller identity + receipt settings). Their
    // failures must never flip loadState to error nor throw out of the effect —
    // each catches internally and leaves its state null on failure. Orders load
    // is owned by the range-driven effect above, not here.
    void Promise.all([
      // Seller identity for the A4 tax invoice (D2). Best-effort: a failure leaves
      // `seller` null, which the print flow surfaces as a clear toast (it never
      // blocks the rest of Sales History).
      (async () => {
        try {
          const res = await fetch("/api/seller-config");
          if (!res.ok) return;
          const data = (await res.json()) as { seller: SellerConfigDTO | null };
          setSeller(data.seller ?? null);
        } catch {
          /* leave seller null; print-tax-invoice will toast SELLER_NOT_CONFIGURED */
        }
      })(),
      // Receipt print-size settings (Receipt print-size feature). Best-effort: a
      // failure leaves settings null → the thermal reprint uses the 80mm default.
      (async () => {
        try {
          const res = await fetch("/api/settings");
          if (!res.ok) return;
          const data = (await res.json()) as { settings: ShopSettingsDTO };
          setReceiptSettings(data.settings);
        } catch {
          /* leave settings null → globals.css 80mm fallback */
        }
      })(),
    ]);
  }, []);

  // --- range controls (Sales History range filter) ---
  function applyPreset(next: RangePreset) {
    const range = presetRange(next);
    setPreset(next);
    setFromLocal(range.from);
    setToLocal(range.to);
  }
  function onFromChange(v: string) {
    setPreset(null);
    setFromLocal(v);
  }
  function onToChange(v: string) {
    setPreset(null);
    setToLocal(v);
  }
  function clearRange() {
    setPreset(null);
    setFromLocal("");
    setToLocal("");
  }

  // Filter by chip + search (posNo/customer), mirroring Simple POS salesRows.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return orders.filter((o) => {
      const okFilter = matchesFilter(o, filter);
      const okQuery =
        !q ||
        o.orderNumber.toLowerCase().includes(q) ||
        (o.accountingDocNo ?? "").toLowerCase().includes(q);
      return okFilter && okQuery;
    });
  }, [orders, query, filter]);

  // ---- void (PATCH /api/orders/[id] {action:"void"}) ----
  // Refund was removed (krs-void-writeback, 19-07-26). The success toast branches on
  // the response's syncStatus: a SYNCED bill's void ALSO enqueues a KRS cancel, so it
  // reports that the cancellation is being sent to accounting.
  async function voidOrder(order: OrderDTO) {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "void" }),
      });
      if (!res.ok) {
        let msg = "ยกเลิกบิลไม่สำเร็จ";
        try {
          const data = await res.json();
          // Friendly branch for the mid-flight / needs-reconcile case: the SALE is being
          // sent to accounting right now (or is held for review) — ask the cashier to
          // retry shortly rather than surfacing the raw server message.
          if (data?.code === "VOID_SALE_IN_FLIGHT") {
            msg = "บิลกำลังส่งเข้าบัญชี ลองใหม่อีกครั้งในสักครู่ครับ";
          } else if (data?.error) {
            msg = data.error;
          }
        } catch {
          /* keep default */
        }
        showToast(msg);
        return;
      }
      const updated = (await res.json()) as OrderDTO;
      setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
      setDetail(null);
      showToast(
        updated.syncStatus === "SYNCED"
          ? "ยกเลิกบิลแล้ว · กำลังส่งยกเลิกเข้าระบบบัญชี"
          : "ยกเลิกบิลแล้ว (Void)"
      );
    } catch {
      showToast("ยกเลิกบิลไม่สำเร็จ");
    } finally {
      setActionBusy(false);
    }
  }

  // ---- request tax invoice (PATCH /api/orders/[id] {action:"request-tax"}) ----
  async function requestTax(order: OrderDTO) {
    if (actionBusy) return;
    // Defensive client gate (the drawer already disables the button for walk-in /
    // no-tax-customer bills): a tax invoice needs a customer with a taxId.
    const hasTaxCustomer =
      order.customer != null &&
      typeof order.customer.taxId === "string" &&
      order.customer.taxId.trim().length > 0;
    if (!hasTaxCustomer) {
      showToast("บิลนี้เป็นลูกค้าทั่วไป ต้องระบุข้อมูลภาษีก่อน");
      return;
    }
    setActionBusy(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "request-tax" }),
      });
      if (!res.ok) {
        let msg = "ขอใบกำกับภาษีไม่สำเร็จ";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* keep default */
        }
        showToast(msg);
        return;
      }
      const updated = (await res.json()) as OrderDTO;
      setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
      setDetail(null);
      showToast("ส่งคำขอออกใบกำกับภาษีเข้าคิวแล้ว · Tax invoice queued");
    } catch {
      showToast("ขอใบกำกับภาษีไม่สำเร็จ");
    } finally {
      setActionBusy(false);
    }
  }

  // ---- reprint ----
  function reprint(order: OrderDTO) {
    setReceiptOrder(order);
    setReceiptOpen(true);
    setDetail(null);
  }

  function closeReceipt() {
    setReceiptOpen(false);
    setReceiptOrder(null);
  }

  // ---- print/reprint the A4 full tax invoice (Phase 4) ----
  // Renders the §86/4 TaxInvoiceDocument from STORED order/customer fields. Only
  // a bill that already carries a minted accountingDocNo reaches this (the drawer
  // gates the button), and the seller block must be configured (D2).
  function printTaxInvoice(order: OrderDTO) {
    if (!order.accountingDocNo) {
      showToast("ยังไม่ได้ออกใบกำกับภาษีสำหรับบิลนี้");
      return;
    }
    if (!seller) {
      showToast(
        "ยังไม่ได้ตั้งค่าข้อมูลผู้ขายสำหรับออกใบกำกับภาษี · Seller not configured"
      );
      return;
    }
    setTaxInvoiceOrder(order);
    setTaxInvoiceOpen(true);
    setDetail(null);
  }

  function closeTaxInvoice() {
    setTaxInvoiceOpen(false);
    setTaxInvoiceOrder(null);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-[22px]">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3.5">
        <div className="min-w-[220px] flex-1">
          <h1 className="m-0 text-[24px] font-bold leading-[1.08] tracking-tight">
            ประวัติการขาย
          </h1>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
            Sales History · ค้นหา คืนเงิน ยกเลิก พิมพ์ใบเสร็จ
          </p>
        </div>
      </header>

      {/* Search + filter chips */}
      <div className="flex flex-wrap items-center gap-3">
        <label
          className="flex h-[42px] max-w-[380px] flex-1 items-center gap-2.5 rounded-[11px] border bg-white px-3"
          style={{ borderColor: "var(--line)" }}
        >
          <Search size={16} strokeWidth={2} color="var(--soft)" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ค้นหาเลขบิล / เลขเอกสาร · Search receipt or doc no."
            className="min-w-0 flex-1 border-0 bg-transparent text-[13.5px] outline-none"
            style={{ color: "var(--ink)" }}
          />
        </label>
        <div className="flex-1" />
        <FilterChips active={filter} onChange={setFilter} />
      </div>

      {/* Date+time range filter (Sales History range filter). Preset chips fill
          both bounds (00:00 → now); the two datetime-local inputs allow a manual
          range. The clear affordance appears only when a range is active. */}
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
            className="flex h-[42px] items-center gap-2 rounded-[11px] border bg-white px-3 text-[13px]"
            style={{ borderColor: "var(--line)" }}
          >
            <span style={{ color: "var(--muted)" }}>จาก</span>
            <input
              type="datetime-local"
              value={fromLocal}
              max={toLocal || undefined}
              onChange={(e) => onFromChange(e.target.value)}
              aria-label="ช่วงเวลาเริ่มต้น"
              className="border-0 bg-transparent text-[13px] font-medium outline-none"
              style={{ color: "var(--ink)" }}
            />
          </label>
          <label
            className="flex h-[42px] items-center gap-2 rounded-[11px] border bg-white px-3 text-[13px]"
            style={{ borderColor: "var(--line)" }}
          >
            <span style={{ color: "var(--muted)" }}>ถึง</span>
            <input
              type="datetime-local"
              value={toLocal}
              min={fromLocal || undefined}
              onChange={(e) => onToChange(e.target.value)}
              aria-label="ช่วงเวลาสิ้นสุด"
              className="border-0 bg-transparent text-[13px] font-medium outline-none"
              style={{ color: "var(--ink)" }}
            />
          </label>
        </div>

        {rangeActive && (
          <button
            type="button"
            onClick={clearRange}
            className="flex h-[42px] items-center gap-1.5 rounded-[11px] border px-3 text-[12.5px] font-semibold transition"
            style={{ borderColor: "var(--line)", color: "var(--muted)", background: "#fff" }}
          >
            <X size={14} strokeWidth={2.2} />
            ล้างช่วงเวลา
          </button>
        )}
      </div>

      {/* Range summary bar (Sales History range filter). Shown only when a range
          is active. It is the COMPLETED-only total for the WHOLE selected range —
          server-computed, independent of the text search + status chip. */}
      {rangeActive && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[14px] border px-4 py-3"
          style={{ background: "var(--mint)", borderColor: "var(--line)" }}
        >
          <span
            className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-[10px]"
            style={{ background: "#fff", color: "var(--brand-2)" }}
          >
            <TrendingUp size={16} strokeWidth={2.2} />
          </span>
          <span className="text-[13px] font-semibold" style={{ color: "var(--brand-2)" }}>
            ยอดขายรวม (ชำระแล้ว)
          </span>
          <span
            className="mono text-[18px] font-bold"
            style={{ color: "var(--brand-2)" }}
          >
            {money(summary?.totalSales ?? "0")}
          </span>
          <span className="text-[13px] font-semibold" style={{ color: "var(--brand-2)" }}>
            · {summary?.billCount ?? 0} บิล
          </span>
          <span className="text-[11.5px]" style={{ color: "var(--brand-2)", opacity: 0.85 }}>
            ตลอดช่วงเวลาที่เลือก
          </span>
        </div>
      )}

      {/* Table / states */}
      <section
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[18px] border bg-white"
        style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
      >
        {loadState === "loading" ? (
          <div
            className="grid flex-1 place-items-center py-16 text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            กำลังโหลดรายการขาย…
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
              โหลดรายการขายไม่สำเร็จ
            </strong>
            <button
              type="button"
              onClick={() => loadOrders(fromLocal, toLocal)}
              className="h-10 rounded-[12px] border px-4 text-[13px] font-semibold"
              style={{ borderColor: "var(--line)" }}
            >
              ลองใหม่
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div
            className="mx-auto flex max-w-[320px] flex-1 flex-col items-center justify-center gap-3 py-16 text-center"
            style={{ color: "var(--muted)" }}
          >
            <span
              className="grid h-[64px] w-[64px] place-items-center rounded-[22px]"
              style={{ background: "var(--surface-2)", color: "var(--soft)" }}
            >
              <ReceiptText size={28} strokeWidth={2} />
            </span>
            <strong className="text-[14px]" style={{ color: "#64748b" }}>
              ไม่พบรายการ
            </strong>
            <span className="text-[12.5px]" style={{ color: "var(--soft)" }}>
              No sales match this filter
            </span>
          </div>
        ) : (
          <SalesTable orders={filtered} onOpenSale={setDetail} />
        )}
      </section>

      {/* Sale detail drawer */}
      <SaleDetailDrawer
        order={detail}
        busy={actionBusy}
        onClose={() => setDetail(null)}
        onVoid={voidOrder}
        onRequestTax={requestTax}
        onPrint={reprint}
        onPrintTaxInvoice={printTaxInvoice}
      />

      {/* Reprint receipt (action-print-from-history). onNewSale closes the modal.
          Uses the admin-configured receipt size (Receipt print-size feature);
          falls back to the globals.css 80mm default until settings load. */}
      <ReceiptModal
        open={receiptOpen}
        order={receiptOrder}
        onPrint={() => printReceiptWithSize(receiptSettings)}
        onEmail={() => showToast("ส่งลิงก์ใบเสร็จแล้ว")}
        onNewSale={closeReceipt}
      />

      {/* A4 full tax invoice (Phase 4). Reprint-only: renders from stored fields +
          the env seller block. window.print() isolates the .print-tax-invoice
          paper (A4 portrait) via the @media print rules in globals.css. */}
      <TaxInvoiceDocument
        open={taxInvoiceOpen}
        order={taxInvoiceOrder}
        seller={seller}
        onClose={closeTaxInvoice}
        onPrint={() => window.print()}
      />
    </div>
  );
}

/**
 * Quick-pick range chip (Sales History range filter). Active = forest-green fill,
 * idle = white with a hairline border — matching the FilterChips + promotions
 * report tab pill language.
 */
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
      aria-pressed={active}
      className="h-9 flex-shrink-0 whitespace-nowrap rounded-full px-3.5 text-[12.5px] font-semibold transition"
      style={
        active
          ? { background: "var(--brand)", color: "#fff", border: "1px solid var(--brand)" }
          : { background: "#fff", color: "var(--muted)", border: "1px solid var(--line)" }
      }
    >
      {children}
    </button>
  );
}

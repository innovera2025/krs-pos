"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, AlertTriangle, ReceiptText } from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import { ReceiptModal } from "@/components/pos/ReceiptModal";
import { SalesTable } from "@/components/sales/SalesTable";
import { FilterChips } from "@/components/sales/FilterChips";
import { SaleDetailDrawer } from "@/components/sales/SaleDetailDrawer";
import { TaxInvoiceDocument } from "@/components/sales/TaxInvoiceDocument";
import { matchesFilter, type SalesFilter } from "@/components/sales/saleMeta";
import type { OrderDTO, SellerConfigDTO } from "@/types";

type LoadState = "loading" | "ready" | "error";

export default function SalesPage() {
  const { showToast } = useToast();

  const [orders, setOrders] = useState<OrderDTO[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SalesFilter>("all");

  // Sale-detail drawer + the order it shows.
  const [detail, setDetail] = useState<OrderDTO | null>(null);
  // refund/void request in flight (disables the drawer's action buttons).
  const [actionBusy, setActionBusy] = useState(false);

  // Reprint (action-print-from-history) reuses the 80mm ReceiptModal.
  const [receiptOrder, setReceiptOrder] = useState<OrderDTO | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  // Tax-invoice A4 document (Phase 4). The seller block is fetched once from
  // /api/seller-config (env-based, D2); null = seller not configured.
  const [taxInvoiceOrder, setTaxInvoiceOrder] = useState<OrderDTO | null>(null);
  const [taxInvoiceOpen, setTaxInvoiceOpen] = useState(false);
  const [seller, setSeller] = useState<SellerConfigDTO | null>(null);

  async function loadOrders() {
    setLoadState("loading");
    try {
      const res = await fetch("/api/orders");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as OrderDTO[];
      setOrders(Array.isArray(data) ? data : []);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  useEffect(() => {
    loadOrders();
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
    })();
  }, []);

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

  // ---- refund / void (PATCH /api/orders/[id]) ----
  async function patchOrder(order: OrderDTO, action: "refund" | "void") {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      const res = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        let msg = action === "refund" ? "คืนเงินไม่สำเร็จ" : "ยกเลิกบิลไม่สำเร็จ";
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
      showToast(
        action === "refund"
          ? "สร้างรายการคืนเงิน + ใบลดหนี้แล้ว"
          : "ยกเลิกบิลแล้ว (Void)"
      );
    } catch {
      showToast(action === "refund" ? "คืนเงินไม่สำเร็จ" : "ยกเลิกบิลไม่สำเร็จ");
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
              onClick={loadOrders}
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
        onRefund={(o) => patchOrder(o, "refund")}
        onVoid={(o) => patchOrder(o, "void")}
        onRequestTax={requestTax}
        onPrint={reprint}
        onPrintTaxInvoice={printTaxInvoice}
      />

      {/* Reprint receipt (action-print-from-history). onNewSale closes the modal. */}
      <ReceiptModal
        open={receiptOpen}
        order={receiptOrder}
        onPrint={() => window.print()}
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

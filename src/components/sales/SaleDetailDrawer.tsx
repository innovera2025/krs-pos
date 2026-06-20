"use client";

import { useEffect, useRef } from "react";
import { X, Printer } from "lucide-react";
import type { OrderDTO } from "@/types";
import { money } from "@/lib/money";
import { methodLabel } from "@/components/pos/paymentMeta";
import {
  statusMeta,
  syncMeta,
  formatSaleTime,
  WALK_IN_LABEL,
} from "./saleMeta";

type SaleDetailDrawerProps = {
  order: OrderDTO | null;
  /** Disable action buttons while a refund/void/request-tax request is in flight. */
  busy: boolean;
  onClose: () => void;
  onRefund: (order: OrderDTO) => void;
  onVoid: (order: OrderDTO) => void;
  /** Request a tax invoice (action-request-tax-invoice). Phase 6a. */
  onRequestTax: (order: OrderDTO) => void;
  onPrint: (order: OrderDTO) => void;
};

/**
 * Sale Detail right drawer (overlay-sale-detail-drawer), ported from the Simple
 * POS source-of-truth into Taste. 440px panel, slideIn .2s, backdrop fadeIn .12s.
 * Closes on backdrop click (action-close-sale-detail), the X, or Escape; the
 * panel stops click propagation so inner clicks never reach the backdrop.
 *
 * Contextual actions (Simple POS gating):
 *  - คืนเงิน · Refund — only when status COMPLETED (canRefund)
 *  - ยกเลิก · Void   — only when COMPLETED AND syncStatus !== SYNCED (canVoid)
 *  - พิมพ์ · Print   — always
 *  - ขอใบกำกับ      — enabled only when the bill has a customer with a taxId
 *    (canTax); a walk-in / no-tax-customer bill keeps it disabled with a note
 *    (Phase 6a: domain-tax-invoice-requires-tax-customer).
 */
export function SaleDetailDrawer({
  order,
  busy,
  onClose,
  onRefund,
  onVoid,
  onRequestTax,
  onPrint,
}: SaleDetailDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const open = order !== null;

  // Focus capture/restore + body-scroll lock + Tab focus-trap (depends on [open]
  // only so a fresh onClose closure never re-runs it / steals focus — mirrors the
  // Modal pattern). The trap keeps Tab within the panel so focus never escapes to
  // the Sales table behind the backdrop.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])'
        ) ?? []
      );

    // Move focus into the dialog.
    (focusables()[0] ?? panelRef.current)?.focus();

    const onTabKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onTabKey);
    return () => {
      document.removeEventListener("keydown", onTabKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Escape closes (separate effect, deps [open, onClose]).
  useEffect(() => {
    if (!open) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [open, onClose]);

  if (!order) return null;

  const st = statusMeta(order.status);
  const sy = syncMeta(order.syncStatus);
  const acctNo = order.accountingDocNo ?? "— ยังไม่ออกเอกสาร —";
  const acctColor = order.accountingDocNo ? "#15803d" : "var(--soft)";
  const canRefund = order.status === "COMPLETED";
  const canVoid = order.status === "COMPLETED" && order.syncStatus !== "SYNCED";
  // Phase 6a: a tax invoice can only be requested when the bill is COMPLETED AND
  // has a customer with a non-empty taxId (domain-tax-invoice-requires-tax-
  // customer). Walk-in / no-tax-customer / non-COMPLETED bills keep the button
  // disabled (mirrors the route's 409 INVALID_STATE + 422 gates).
  const customerName = order.customer?.name ?? WALK_IN_LABEL;
  const canTax =
    order.status === "COMPLETED" &&
    order.customer != null &&
    typeof order.customer.taxId === "string" &&
    order.customer.taxId.trim().length > 0;

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex justify-end"
      style={{ background: "rgba(15,23,42,.4)", animation: "fadeIn .12s" }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`รายละเอียดบิล ${order.orderNumber}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-[440px] max-w-[94vw] flex-col bg-white"
        style={{ boxShadow: "-10px 0 40px rgba(0,0,0,.2)", animation: "slideIn .2s" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-[22px] py-[18px]"
          style={{ borderColor: "#f1f5f9" }}
        >
          <div className="min-w-0">
            <div className="mono text-[16px] font-bold" style={{ color: "var(--ink)" }}>
              {order.orderNumber}
            </div>
            <div className="text-[12px]" style={{ color: "var(--soft)" }}>
              {formatSaleTime(order.createdAt)} · {customerName}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="grid h-[34px] w-[34px] place-items-center rounded-[9px] transition hover:bg-[#f1f5f9]"
            style={{ color: "var(--soft)" }}
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-5">
          <div className="mb-[18px] flex gap-2">
            <span
              className="rounded-lg px-3 py-1.5 text-[12px] font-semibold"
              style={{ background: st.bg, color: st.fg }}
            >
              {st.label} · {st.en}
            </span>
            <span
              className="rounded-lg px-3 py-1.5 text-[12px] font-semibold"
              style={{ background: sy.bg, color: sy.fg }}
            >
              {sy.label} · {sy.en}
            </span>
          </div>

          <div className="flex flex-col gap-[11px] text-[13px]">
            <Row label="ยอดสุทธิ · Total">
              <span className="mono text-[16px] font-bold" style={{ color: "var(--ink)" }}>
                {money(Number(order.total))}
              </span>
            </Row>
            <Row label="VAT 7%">
              <span className="mono">{money(Number(order.tax))}</span>
            </Row>
            <Row label="วิธีชำระ · Payment">
              <span className="font-medium">{methodLabel(order.paymentType.toLowerCase())}</span>
            </Row>
            <div
              className="flex items-center justify-between border-t pt-[11px]"
              style={{ borderColor: "#f1f5f9" }}
            >
              <span style={{ color: "var(--soft)" }}>เลขเอกสารบัญชี</span>
              <span className="mono font-semibold" style={{ color: acctColor }}>
                {acctNo}
              </span>
            </div>
          </div>

          {!canTax ? (
            <div
              className="mt-4 rounded-[11px] border px-[13px] py-[11px] text-[12px]"
              style={{ background: "#fffbeb", borderColor: "#fde68a", color: "#a16207" }}
            >
              บิลนี้เป็นลูกค้าทั่วไป — ต้องเพิ่มข้อมูลผู้เสียภาษีก่อนจึงจะขอใบกำกับภาษีได้
            </div>
          ) : null}
        </div>

        {/* Actions */}
        <div
          className="flex flex-col gap-[9px] border-t px-[22px] py-4"
          style={{ borderColor: "#f1f5f9" }}
        >
          {/* ขอใบกำกับภาษี — enabled only when the bill has a tax customer
              (canTax). Walk-in / no-tax-customer bills keep it disabled with the
              warning note shown above. */}
          <button
            type="button"
            onClick={() => onRequestTax(order)}
            disabled={!canTax || busy}
            title={
              canTax
                ? "ขอใบกำกับภาษี"
                : "ลูกค้าทั่วไป — ต้องระบุข้อมูลภาษีก่อน"
            }
            className="flex h-[46px] items-center justify-center gap-2 rounded-[11px] text-[13.5px] font-bold text-white transition hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: "#2563eb" }}
          >
            ขอใบกำกับภาษี · Request tax invoice
          </button>

          {(canRefund || canVoid) && (
            <div className="flex gap-[9px]">
              {canRefund && (
                <button
                  type="button"
                  onClick={() => onRefund(order)}
                  disabled={busy}
                  className="flex h-[46px] flex-1 items-center justify-center rounded-[11px] border text-[13px] font-semibold transition hover:bg-[#fff7ed] disabled:opacity-50"
                  style={{ borderColor: "#fed7aa", color: "#c2410c" }}
                >
                  คืนเงิน · Refund
                </button>
              )}
              {canVoid && (
                <button
                  type="button"
                  onClick={() => onVoid(order)}
                  disabled={busy}
                  className="flex h-[46px] flex-1 items-center justify-center rounded-[11px] border text-[13px] font-semibold transition hover:bg-[#fef2f2] disabled:opacity-50"
                  style={{ borderColor: "#fecaca", color: "#dc2626" }}
                >
                  ยกเลิก · Void
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => onPrint(order)}
            className="flex h-11 items-center justify-center gap-[7px] rounded-[11px] border text-[13px] font-semibold transition hover:bg-[var(--surface-2)]"
            style={{ borderColor: "var(--line)", color: "#475569" }}
          >
            <Printer size={16} strokeWidth={2} />
            พิมพ์ใบเสร็จ · Print
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: "var(--soft)" }}>{label}</span>
      {children}
    </div>
  );
}

"use client";

import { useEffect, useRef } from "react";
import { X, Trash2, Check, AlertTriangle } from "lucide-react";
import { Modal } from "@/components/Modal";
import type { CustomerDTO, PayLine, PayMethod } from "@/types";
import { formatSatang } from "@/lib/money";
import { bahtToSatang, sumPaySatang } from "@/lib/pricing";
import { PAY_METHODS, methodIcon, methodLabel } from "./paymentMeta";

type PaymentModalProps = {
  open: boolean;
  /** Total due in integer satang (authoritative, from the cart). */
  totalSatang: number;
  /** Inclusive VAT in satang (display only). */
  vatSatang: number;
  /** Number of physical items in the cart (display only). */
  itemCount: number;
  /**
   * Total promotion savings on this bill in satang (Σ line promos + bill promo) —
   * promotions program, Phase 7. Informational only; shown as a mint line under the
   * total due when > 0. Omitted/0 → the line is hidden.
   */
  promoSavingsSatang?: number;

  /** Selected customer (null = walk-in / ลูกค้าทั่วไป). Phase 6a. */
  customer: CustomerDTO | null;
  /** Whether a tax invoice was requested (tax toggle state). Phase 6a. */
  taxRequested: boolean;

  payLines: PayLine[];
  /** Cash received (baht text mirror). */
  cashReceived: string;
  /** Optional payment reference no (slip/QR/card). */
  reference: string;
  /** Validation banner message (empty = none). */
  payError: string;
  /** True while the confirm POST is in flight. */
  submitting: boolean;

  onSetMethod: (key: PayMethod) => void;
  onSetAmount: (index: number, value: string) => void;
  onAddLine: () => void;
  onRemoveLine: (id: string) => void;
  onCashReceived: (value: string) => void;
  onSetReference: (value: string) => void;
  /** Toggle the tax-invoice request (action-tax-toggle). Phase 6a. */
  onToggleTax: () => void;
  onConfirm: () => void;
  /** Close (X) — PRESERVES payLines per the source-of-truth behavior. */
  onClose: () => void;
};

/**
 * Payment modal (overlay-payment-modal) — 6 methods, split payment, cash panel
 * with quick-cash + change-due, reference, and a validation banner. Reuses the
 * shared Modal primitive for backdrop/Escape/focus-trap.
 *
 * Money is integer-satang authoritative: the split sum and remaining are computed
 * via lib/pricing helpers; the cash panel change-due is max(received − cashDue, 0).
 */
export function PaymentModal({
  open,
  totalSatang,
  vatSatang,
  itemCount,
  promoSavingsSatang,
  customer,
  taxRequested,
  payLines,
  cashReceived,
  reference,
  payError,
  submitting,
  onSetMethod,
  onSetAmount,
  onAddLine,
  onRemoveLine,
  onCashReceived,
  onSetReference,
  onToggleTax,
  onConfirm,
  onClose,
}: PaymentModalProps) {
  // Customer summary + tax eligibility (state-customer-has-tax).
  const customerLabel = customer?.name ?? "ลูกค้าทั่วไป";
  const customerHasTax =
    customer != null &&
    typeof customer.taxId === "string" &&
    customer.taxId.trim().length > 0;
  // Warn (mirrors Simple POS taxWarn): tax requested but the selected customer
  // has no tax id (or is walk-in).
  const taxWarn = taxRequested && !customerHasTax;
  // Which methods are currently in use across the split lines (drives tile state).
  const activeMethods = new Set(payLines.map((l) => l.method));

  // Cash panel: the cash due is the SUM of ALL cash lines' amounts (a split may
  // carry more than one cash line); change is received minus that, floored at 0
  // (state-cash-change-display).
  const showCash = payLines.some((l) => l.method === "cash");
  const cashDueSatang = sumPaySatang(
    payLines.filter((l) => l.method === "cash").map((l) => l.amount)
  );
  const receivedSatang = bahtToSatang(cashReceived);
  const changeSatang = Math.max(receivedSatang - cashDueSatang, 0);

  // Cash-drawer convention (owner request): whenever the cash panel becomes
  // relevant — the modal opens with เงินสด preselected (the default seed) or the
  // cashier switches the active method to เงินสด — auto-focus the "รับเงินสด"
  // input and select its contents so the next keystroke overwrites the amount
  // instead of appending. Keyed on [open, showCash] so it fires exactly on those
  // transitions (including switch-away-then-back), never mid-edit while a cash
  // line already exists in a split (deps unchanged → no re-run). rAF defers the
  // focus until after the portal has painted the input (the shared Modal mounts
  // its overlay a commit late) and after the Modal's own focus-move, so this
  // focus wins — matching the requestAnimationFrame(focus) refocus pattern used
  // on the POS page.
  const cashReceivedRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open || !showCash) return;
    const raf = requestAnimationFrame(() => {
      const el = cashReceivedRef.current;
      if (!el) return;
      el.focus();
      el.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, showCash]);

  // Single-line invariant (single-line-amount-is-total): whenever exactly ONE
  // payment method is in play, its amount MUST equal the bill total. The cashier
  // can no longer edit it (it renders read-only below), so this guards the two
  // remaining ways it could go stale: an amount that was edited before this became
  // read-only, or a split trimmed back down to a single line (which keeps its old
  // partial amount). Force-sync through the existing amount setter whenever the
  // lone line drifts from the total — compared in exact satang so "58.5" vs
  // "58.50" isn't a false drift. No loop: after the sync the amount equals the
  // total and the satang guard short-circuits.
  useEffect(() => {
    if (payLines.length !== 1) return;
    if (bahtToSatang(payLines[0].amount) === totalSatang) return;
    onSetAmount(0, (totalSatang / 100).toFixed(2));
  }, [payLines, totalSatang, onSetAmount]);

  // Split sum vs total (satang-exact) → confirm enablement.
  const paidSatang = sumPaySatang(payLines.map((l) => l.amount));
  const sumMatches = Math.abs(paidSatang - totalSatang) <= 1; // ≤ 0.01 baht
  const cashOk = !showCash || receivedSatang + 1 >= cashDueSatang;
  const canConfirm = !submitting && sumMatches && cashOk && payLines.length > 0;

  // Quick-cash presets: exact total, ฿100, ฿500, ฿1,000.
  const quickCash: { label: string; satang: number }[] = [
    { label: "พอดี", satang: totalSatang },
    { label: "฿100", satang: 10000 },
    { label: "฿500", satang: 50000 },
    { label: "฿1,000", satang: 100000 },
  ];

  // Keyboard checkout (owner request): Enter anywhere inside the payment modal
  // confirms the sale, so scan → amount → Enter never touches the mouse. Scoped
  // to THIS modal only — a page-level listener would collide with the barcode
  // scanner's trailing Enter in the search box. Focused buttons/links keep
  // their native Enter (so Enter on ยกเลิก doesn't pay), and an in-progress IME
  // composition (Thai keyboard) is ignored. canConfirm already guards
  // double-submit (submitting=true disables it).
  const handleEnterConfirm = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || !canConfirm) return;
    if (e.nativeEvent.isComposing) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "BUTTON" || tag === "A" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    onConfirm();
  };

  return (
    <Modal open={open} onClose={onClose} label="วิธีชำระเงิน">
      <div
        className="flex max-h-[92vh] w-[760px] max-w-[94vw] overflow-hidden rounded-[18px] bg-white"
        style={{ boxShadow: "0 30px 70px rgba(0,0,0,.35)" }}
        onKeyDown={handleEnterConfirm}
      >
        {/* Left: dark summary panel */}
        <div
          className="flex w-[280px] flex-shrink-0 flex-col p-[22px_22px] text-white"
          style={{ background: "#0f172a", padding: "24px 22px" }}
        >
          <div className="text-[13px]" style={{ color: "#94a3b8" }}>
            ยอดที่ต้องชำระ · Total due
          </div>
          <div className="mono mt-1 text-[38px] font-bold leading-none">
            {formatSatang(totalSatang)}
          </div>
          {/* Promotion savings on this bill (promotions program, Phase 7) — mint,
              informational; the total due above is already net of every discount. */}
          {promoSavingsSatang != null && promoSavingsSatang > 0 && (
            <div
              className="mt-1.5 flex items-center justify-between text-[12px] font-semibold"
              style={{ color: "#6ee7b7" }}
            >
              <span>รวมส่วนลดโปรโมชัน</span>
              <span className="mono">-{formatSatang(promoSavingsSatang)}</span>
            </div>
          )}
          <div
            className="mt-[18px] flex flex-col gap-[7px] border-t pt-4 text-[12.5px]"
            style={{ borderColor: "#1e293b", color: "#94a3b8" }}
          >
            <div className="flex justify-between">
              <span>รายการ</span>
              <span className="mono" style={{ color: "#cbd5e1" }}>
                {itemCount} ชิ้น
              </span>
            </div>
            <div className="flex justify-between">
              <span>VAT 7%</span>
              <span className="mono" style={{ color: "#cbd5e1" }}>
                {formatSatang(vatSatang)}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="flex-shrink-0">ลูกค้า</span>
              <span
                className="max-w-[140px] truncate text-right"
                style={{ color: "#cbd5e1" }}
              >
                {customerLabel}
              </span>
            </div>
          </div>

          <div className="flex-1" />

          {/* Tax-invoice toggle (action-tax-toggle). */}
          <label
            className="flex cursor-pointer items-center gap-2.5 rounded-[11px] p-3"
            style={{
              background: taxRequested ? "#1e3a5f" : "#1e293b",
              border: `1px solid ${taxRequested ? "#2563eb" : "#334155"}`,
            }}
          >
            <input
              type="checkbox"
              checked={taxRequested}
              onChange={onToggleTax}
              aria-label="ขอใบกำกับภาษี"
              className="h-[18px] w-[18px]"
              style={{ accentColor: "#2563eb" }}
            />
            <span>
              <span className="block text-[12.5px] font-semibold text-white">
                ขอใบกำกับภาษี
              </span>
              <span className="block text-[10.5px]" style={{ color: "#94a3b8" }}>
                Request tax invoice
              </span>
            </span>
          </label>
          {taxWarn && (
            <div
              className="mt-2 flex items-start gap-[7px] text-[11px]"
              style={{ color: "#fca5a5" }}
            >
              <AlertTriangle
                size={14}
                strokeWidth={1.8}
                className="mt-px flex-shrink-0"
              />
              <span>
                ลูกค้านี้ยังไม่มีข้อมูลภาษี ต้องเลือกลูกค้าที่มีเลขผู้เสียภาษีก่อน
              </span>
            </div>
          )}
        </div>

        {/* Right: methods + split + cash + reference + confirm */}
        <div className="flex min-w-0 flex-1 flex-col p-[22px]">
          <div className="mb-3.5 flex items-center justify-between">
            <h2 className="m-0 text-[16px] font-bold">วิธีชำระเงิน · Payment</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="ปิดหน้าต่างชำระเงิน"
              className="grid h-[34px] w-[34px] place-items-center rounded-[9px]"
              style={{ color: "#94a3b8" }}
            >
              <X size={18} strokeWidth={2} />
            </button>
          </div>

          {/* 6 method tiles */}
          <div
            className="mb-4 grid grid-cols-3 gap-2"
            role="group"
            aria-label="วิธีชำระเงิน"
          >
            {PAY_METHODS.map((m) => {
              const on = activeMethods.has(m.key);
              const Icon = m.icon;
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => onSetMethod(m.key)}
                  aria-pressed={on}
                  className="flex h-16 flex-col items-center justify-center gap-1.5 rounded-[12px] text-[12px] font-semibold transition"
                  style={
                    on
                      ? {
                          background: "#ecfdf5",
                          border: "1.5px solid #16a34a",
                          color: "#15803d",
                          boxShadow: "0 2px 8px rgba(22,163,74,.12)",
                        }
                      : {
                          background: "#fff",
                          border: "1px solid #e6ebf1",
                          color: "#475569",
                        }
                  }
                >
                  <Icon size={22} strokeWidth={1.8} />
                  <span>{m.label}</span>
                </button>
              );
            })}
          </div>

          {/* Split lines — keyed by stable id (index-independent) */}
          <div className="mb-1.5 flex flex-col gap-2">
            {payLines.map((line, i) => {
              const Icon = methodIcon(line.method);
              return (
                <div
                  key={line.id}
                  className="flex items-center gap-2.5 rounded-[10px] border px-[11px] py-[9px]"
                  style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}
                >
                  <Icon size={18} strokeWidth={1.8} color="#64748b" />
                  <div className="flex-1 text-[13px] font-semibold">
                    {methodLabel(line.method)}
                  </div>
                  <span className="mono text-[13px]" style={{ color: "var(--soft)" }}>
                    ฿
                  </span>
                  {payLines.length === 1 ? (
                    // Single-line mode: the amount always equals the bill total
                    // (force-synced above), so editing it is pure foot-gun. Render
                    // it as read-only display text — same footprint / mono / right-
                    // aligned / weight as the input it replaces, but with no input
                    // chrome so it doesn't invite typing. The เงินสด received panel
                    // stays the (editable) place to enter tendered cash.
                    <div
                      aria-label={`จำนวนเงิน ${methodLabel(line.method)}`}
                      className="mono flex h-9 w-[104px] items-center justify-end px-2.5 text-right text-[14px]"
                      style={{ color: "#0f172a" }}
                    >
                      {line.amount}
                    </div>
                  ) : (
                    <input
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(e) => onSetAmount(i, e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      aria-label={`จำนวนเงิน ${methodLabel(line.method)}`}
                      className="mono h-9 w-[104px] rounded-lg border px-2.5 text-right text-[14px]"
                      style={{ borderColor: "#e2e8f0" }}
                    />
                  )}
                  {payLines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onRemoveLine(line.id)}
                      aria-label={`ลบรายการชำระ ${methodLabel(line.method)}`}
                      className="grid place-items-center p-1"
                      style={{ color: "#cbd5e1" }}
                    >
                      <Trash2 size={16} strokeWidth={2} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Split mismatch explainer (split-mismatch-explainer): in split mode
              (≥2 lines) the per-method amounts stay editable, so their sum can drift
              from the bill total — which silently disables Confirm with no on-screen
              reason. Surface WHY directly under the lines whenever the sum doesn't
              match: short → how much more the methods still owe; over → how much they
              exceed the bill. Hidden in single-line mode (its amount is force-synced
              to the total, so it can never mismatch) and hidden once the split
              balances. Amber/red to match this modal's error-text voice. */}
          {payLines.length >= 2 && !sumMatches && (
            <div
              className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium"
              style={{ color: "#dc2626" }}
            >
              <AlertTriangle
                size={14}
                strokeWidth={1.8}
                className="flex-shrink-0"
              />
              {totalSatang - paidSatang > 0 ? (
                <span>
                  ยอดวิธีจ่ายยังขาดอีก{" "}
                  <span className="mono font-semibold">
                    {formatSatang(totalSatang - paidSatang)}
                  </span>
                </span>
              ) : (
                <span>
                  ยอดวิธีจ่ายเกินยอดบิลอยู่{" "}
                  <span className="mono font-semibold">
                    {formatSatang(paidSatang - totalSatang)}
                  </span>
                </span>
              )}
            </div>
          )}
          <button
            type="button"
            onClick={onAddLine}
            className="mb-3.5 inline-flex items-center gap-1.5 self-start text-[12.5px] font-semibold"
            style={{ color: "#2563eb" }}
          >
            + แบ่งจ่ายหลายวิธี · Split payment
          </button>

          {/* Cash panel */}
          {showCash && (
            <div
              className="mb-3.5 rounded-[12px] border p-[13px]"
              style={{ background: "#f0fdf4", borderColor: "#bbf7d0" }}
            >
              <div className="mb-[9px] flex items-center justify-between">
                <span className="text-[13px] font-semibold" style={{ color: "#15803d" }}>
                  รับเงินสด · Cash received
                </span>
                <input
                  ref={cashReceivedRef}
                  inputMode="decimal"
                  value={cashReceived}
                  onChange={(e) => onCashReceived(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="จำนวนเงินสดที่รับ"
                  className="mono h-10 w-[130px] rounded-[9px] border px-3 text-right text-[16px] font-semibold"
                  style={{ borderColor: "#86efac" }}
                />
              </div>
              <div className="mb-[9px] flex gap-1.5">
                {quickCash.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => onCashReceived((q.satang / 100).toFixed(2))}
                    className="mono h-[34px] flex-1 rounded-lg border text-[12.5px] font-semibold"
                    style={{
                      background: "#fff",
                      borderColor: "#bbf7d0",
                      color: "#15803d",
                    }}
                  >
                    {q.label}
                  </button>
                ))}
              </div>
              <div
                className="flex items-center justify-between border-t border-dashed pt-[9px]"
                style={{ borderColor: "#bbf7d0" }}
              >
                <span className="text-[13.5px] font-semibold" style={{ color: "#15803d" }}>
                  เงินทอน · Change
                </span>
                <span className="mono text-[22px] font-bold" style={{ color: "#15803d" }}>
                  {formatSatang(changeSatang)}
                </span>
              </div>
            </div>
          )}

          {/* Reference */}
          <input
            value={reference}
            onChange={(e) => onSetReference(e.target.value)}
            placeholder="เลขอ้างอิง (สลิป/QR/บัตร) · Reference no. (optional)"
            aria-label="เลขอ้างอิงการชำระเงิน"
            className="mb-3 h-[42px] w-full rounded-[10px] border px-[13px] text-[13px]"
            style={{ borderColor: "#e2e8f0" }}
          />

          {/* Validation banner */}
          {payError && (
            <div
              role="alert"
              aria-atomic="true"
              className="mb-3 flex items-start gap-2 rounded-[10px] border px-[13px] py-2.5 text-[12.5px] font-medium"
              style={{ background: "#fef2f2", borderColor: "#fecaca", color: "#dc2626" }}
            >
              <AlertTriangle size={15} strokeWidth={1.8} className="mt-px flex-shrink-0" />
              <span>{payError}</span>
            </div>
          )}

          <div className="flex-1" />
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className="flex h-[54px] items-center justify-center gap-2.5 rounded-[13px] text-[16px] font-bold text-white disabled:cursor-not-allowed"
            style={{
              border: 0,
              background: canConfirm
                ? "linear-gradient(180deg,#16a34a,#15803d)"
                : "#cbd5e1",
              boxShadow: canConfirm ? "0 6px 16px rgba(22,163,74,.3)" : "none",
            }}
          >
            <Check size={20} strokeWidth={2.4} />
            <span>{submitting ? "กำลังบันทึก…" : "ยืนยันการชำระเงิน · Confirm"}</span>
            {!submitting && canConfirm && (
              <span
                className="rounded-[6px] border px-1.5 py-0.5 text-[11px] font-semibold"
                style={{ borderColor: "rgba(255,255,255,.45)", opacity: 0.85 }}
              >
                Enter ↵
              </span>
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
}

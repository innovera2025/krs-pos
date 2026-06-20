"use client";

import { X, Trash2, Check, AlertTriangle } from "lucide-react";
import { Modal } from "@/components/Modal";
import type { PayLine, PayMethod } from "@/types";
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
  onRemoveLine: (index: number) => void;
  onCashReceived: (value: string) => void;
  onSetReference: (value: string) => void;
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
  onConfirm,
  onClose,
}: PaymentModalProps) {
  // Which methods are currently in use across the split lines (drives tile state).
  const activeMethods = new Set(payLines.map((l) => l.method));

  // Cash panel: the cash due is the first cash line's amount; change is the
  // received minus that, floored at 0 (state-cash-change-display).
  const cashLine = payLines.find((l) => l.method === "cash");
  const showCash = cashLine !== undefined;
  const cashDueSatang = cashLine ? bahtToSatang(cashLine.amount) : 0;
  const receivedSatang = bahtToSatang(cashReceived);
  const changeSatang = Math.max(receivedSatang - cashDueSatang, 0);

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

  return (
    <Modal open={open} onClose={onClose} label="วิธีชำระเงิน">
      <div
        className="flex max-h-[92vh] w-[760px] max-w-[94vw] overflow-hidden rounded-[18px] bg-white"
        style={{ boxShadow: "0 30px 70px rgba(0,0,0,.35)" }}
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
            <div className="flex justify-between">
              <span>ลูกค้า</span>
              <span style={{ color: "#cbd5e1" }}>ลูกค้าทั่วไป</span>
            </div>
          </div>
        </div>

        {/* Right: methods + split + cash + reference + confirm */}
        <div className="flex min-w-0 flex-1 flex-col p-[22px]">
          <div className="mb-3.5 flex items-center justify-between">
            <div className="text-[16px] font-bold">วิธีชำระเงิน · Payment</div>
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
          <div className="mb-4 grid grid-cols-3 gap-2">
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

          {/* Split lines */}
          <div className="mb-1.5 flex flex-col gap-2">
            {payLines.map((line, i) => {
              const Icon = methodIcon(line.method);
              return (
                <div
                  key={i}
                  className="flex items-center gap-2.5 rounded-[10px] border px-[11px] py-[9px]"
                  style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}
                >
                  <Icon size={18} strokeWidth={1.8} color="#64748b" />
                  <div className="flex-1 text-[13px] font-semibold">
                    {methodLabel(line.method)}
                  </div>
                  <span className="mono text-[13px]" style={{ color: "#94a3b8" }}>
                    ฿
                  </span>
                  <input
                    inputMode="decimal"
                    value={line.amount}
                    onChange={(e) => onSetAmount(i, e.target.value)}
                    aria-label={`จำนวนเงิน ${methodLabel(line.method)}`}
                    className="mono h-9 w-[104px] rounded-lg border px-2.5 text-right text-[14px]"
                    style={{ borderColor: "#e2e8f0" }}
                  />
                  {payLines.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onRemoveLine(i)}
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
                  inputMode="decimal"
                  value={cashReceived}
                  onChange={(e) => onCashReceived(e.target.value)}
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
          </button>
        </div>
      </div>
    </Modal>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Check, Printer, Mail } from "lucide-react";
import { Modal } from "@/components/Modal";
import type { OrderDTO, ShopSettingsDTO } from "@/types";
import { money } from "@/lib/money";
import { methodLabel } from "./paymentMeta";
import { FauxQR } from "./FauxQR";
// Dynamic sync badge (GAP 2): the same {label/en/bg/fg/dot} metadata Sales
// History uses, so the receipt reflects the bill's REAL syncStatus instead of a
// hardcoded "Queued" state.
import { syncMeta } from "@/components/sales/saleMeta";

type ReceiptModalProps = {
  open: boolean;
  order: OrderDTO | null;
  /** Manual actions (Sales-History reprint path). Omitted in auto-print mode,
   *  where the whole overlay is screen-hidden and these buttons are unreachable. */
  onPrint?: () => void;
  onEmail?: () => void;
  /** Start a new sale — the ONLY way to dismiss the visible reprint receipt. */
  onNewSale?: () => void;
  /**
   * Auto-print mode (pos-autoprint-receipt): render the receipt SCREEN-HIDDEN
   * (via Modal `printSource`) so the POS confirm path can print it automatically
   * without ever showing a receipt page. The parent triggers the actual print
   * (once the `.print-receipt` paper is mounted) and resets to a new sale on
   * `afterprint`. The visible Sales-History reprint path leaves this false.
   */
  autoPrint?: boolean;
  /**
   * Pre-loaded seller identity (pos-autoprint-receipt). The POS page passes its
   * mount-fetched settings so the printed header (name/branch/phone/POS id) is
   * populated on FIRST paint — eliminating the race where an auto-print fires
   * before the modal's own `/api/settings` fetch resolves and prints the "KRS"
   * fallback header. When omitted (reprint path) the modal fetches on open.
   */
  seller?: Partial<ShopSettingsDTO> | null;
};

/** Fallback branch line when no seller branch label is configured (DB or ENV). */
const BRANCH_FALLBACK = "สำนักงานใหญ่ · Head Office";

/** Format an ISO string to a compact Thai-ish datetime for the receipt. */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("th-TH", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const time = d.toLocaleTimeString("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} ${time}`;
}

/**
 * Receipt modal (overlay-receipt) — 80mm thermal receipt + success/sync/QR side.
 *
 * Dismissal is New-Sale-only (action-close-receipt-newsale-only): there is no X
 * and the backdrop does not close. The shared Modal's onClose is wired to a
 * no-op; only "เริ่มบิลใหม่" calls onNewSale.
 */
export function ReceiptModal({
  open,
  order,
  onPrint,
  onEmail,
  onNewSale,
  autoPrint = false,
  seller,
}: ReceiptModalProps) {
  // Seller identity for the receipt header (seller-company-settings). Fetched
  // once when the modal opens; fire-and-catch so a failed fetch just leaves the
  // header on its safe fallbacks ("KRS", default branch, no phone/POS). Hooks must
  // run before the early `return null` below to satisfy the rules of hooks.
  //
  // When the parent supplies `seller` (pos-autoprint-receipt) the fetch is
  // skipped and the header renders from the pre-loaded settings on first paint,
  // so the auto-print never races the network and prints the fallback header.
  const [fetchedSeller, setFetchedSeller] = useState<Partial<ShopSettingsDTO>>({});
  useEffect(() => {
    if (!open || seller) return;
    let cancelled = false;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.settings) setFetchedSeller(data.settings);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, seller]);

  // Prefer the pre-loaded seller (auto-print) over the on-open fetch (reprint).
  const sellerInfo: Partial<ShopSettingsDTO> = seller ?? fetchedSeller;

  if (!open || !order) return null;

  // Resolved header values (DB-sourced via /api/settings; safe fallbacks).
  const sellerName = sellerInfo.sellerName?.trim() || "KRS";
  const branchLine = sellerInfo.sellerBranchLabel?.trim() || BRANCH_FALLBACK;
  const sellerPhone = sellerInfo.sellerPhone?.trim() || "";
  const sellerPosId = sellerInfo.sellerPosId?.trim() || "";

  const posNo = order.orderNumber;
  const shortId = posNo.slice(-6); // domain-receipt-shortid
  const totalNum = Number(order.total);
  const changeNum = Number(order.change);
  const hasChange = changeNum > 0.01;
  const cashierName = order.cashier?.name ?? "นิดา ส.";
  // Reprint-from-history bills may already carry a real accounting doc number;
  // fresh P3 receipts have accountingDocNo === null → keep the placeholder.
  const acctNo = order.accountingDocNo ?? "— รอออกเอกสาร —";
  const acctColor = order.accountingDocNo ? "#0f172a" : "var(--soft)";
  // Dynamic sync badge (GAP 2): reflect the bill's real syncStatus (PENDING /
  // DAILY / SYNCED / FAILED / SKIPPED) instead of a hardcoded "Queued" state. A
  // fresh sale is PENDING (the badge then reads "รอส่ง · Pending").
  const sy = syncMeta(order.syncStatus);

  // display-receipt-payment-fallback: reprinted/seeded bills may arrive without
  // persisted payment lines. Fall back to a single line derived from the order's
  // primary method + total so the receipt still renders a payment row.
  const payLines =
    order.payments && order.payments.length > 0
      ? order.payments.map((p) => ({
          id: p.id,
          method: p.method,
          amount: p.amount,
        }))
      : [
          {
            id: "fallback-pay",
            method: order.paymentType,
            amount: order.total,
          },
        ];

  return (
    // onClose is a no-op: receipt closes ONLY via New Sale (no X, no backdrop).
    // printSource (auto-print): render screen-hidden but still printable so the
    // POS confirm path prints without ever showing a receipt page.
    <Modal open={open} onClose={() => {}} label="ใบเสร็จ" printSource={autoPrint}>
      <div
        className="flex max-h-[92vh] w-[720px] max-w-[94vw] overflow-hidden rounded-[18px]"
        style={{ background: "#f1f5f9", boxShadow: "0 30px 70px rgba(0,0,0,.35)" }}
      >
        {/* Receipt paper (80mm) — this is what @media print isolates */}
        <div
          className="print-receipt w-[330px] flex-shrink-0 overflow-y-auto bg-white"
          style={{ padding: "26px 24px", fontFamily: "var(--font-mono), monospace" }}
        >
          {/* Header */}
          <div
            className="border-b border-dashed pb-3.5 text-center"
            style={{ borderColor: "#cbd5e1" }}
          >
            <div
              className="text-[18px] font-bold"
              style={{ fontFamily: "var(--font-sans)", letterSpacing: ".04em" }}
            >
              {sellerName}
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: "#64748b" }}>
              {branchLine}
            </div>
            {/* Phone + POS ID render only when configured (KRS reference receipt
                parity) — never show an empty/placeholder line. */}
            {sellerPhone && (
              <div className="text-[11px]" style={{ color: "#64748b" }}>
                โทร {sellerPhone}
              </div>
            )}
            {sellerPosId && (
              <div className="text-[11px]" style={{ color: "#64748b" }}>
                POS: {sellerPosId}
              </div>
            )}
          </div>

          {/* Meta */}
          <div
            className="border-b border-dashed py-3 text-[11.5px] leading-[1.8]"
            style={{ borderColor: "#cbd5e1", color: "#475569" }}
          >
            <div className="flex justify-between">
              <span>เลขที่ POS</span>
              <span className="font-semibold" style={{ color: "#0f172a" }}>
                {posNo}
              </span>
            </div>
            <div className="flex justify-between">
              <span>เลขเอกสารบัญชี</span>
              <span className="font-semibold" style={{ color: acctColor }}>
                {acctNo}
              </span>
            </div>
            <div className="flex justify-between">
              <span>วันที่</span>
              <span>{formatDateTime(order.createdAt)}</span>
            </div>
            <div className="flex justify-between">
              <span>แคชเชียร์</span>
              <span>{cashierName}</span>
            </div>
          </div>

          {/* Line items (display-receipt-line-detail: name, qty × unitPrice, lineTotal) */}
          {order.items.map((it) => (
            <div key={it.id} className="pt-[9px] text-[11.5px]" style={{ color: "#334155" }}>
              <div className="flex justify-between font-semibold" style={{ color: "#0f172a" }}>
                <span style={{ fontFamily: "var(--font-sans)" }}>{it.product.name}</span>
                <span>{money(Number(it.lineTotal))}</span>
              </div>
              <div style={{ color: "var(--soft)" }}>
                {it.quantity} × {money(Number(it.unitPrice))}
              </div>
            </div>
          ))}

          {/* Totals */}
          <div
            className="mt-3 border-t border-dashed pt-2.5 text-[11.5px] leading-[1.9]"
            style={{ borderColor: "#cbd5e1", color: "#475569" }}
          >
            <div
              className="flex justify-between text-[15px] font-bold"
              style={{ fontFamily: "var(--font-sans)", color: "#0f172a" }}
            >
              <span>รวมสุทธิ</span>
              <span>{money(totalNum)}</span>
            </div>
          </div>

          {/* Payment lines + change */}
          <div
            className="mt-2.5 border-t border-dashed pt-2.5 text-[11.5px] leading-[1.8]"
            style={{ borderColor: "#cbd5e1", color: "#475569" }}
          >
            {payLines.map((p) => (
              <div key={p.id} className="flex justify-between">
                <span style={{ fontFamily: "var(--font-sans)" }}>
                  {methodLabel(p.method.toLowerCase())}
                </span>
                <span>{money(Number(p.amount))}</span>
              </div>
            ))}
            {hasChange && (
              <div className="flex justify-between font-semibold" style={{ color: "#15803d" }}>
                <span style={{ fontFamily: "var(--font-sans)" }}>เงินทอน</span>
                <span>{money(changeNum)}</span>
              </div>
            )}
          </div>

          {/* Tax-payer block (display-receipt-taxpayer) — printed only when a tax
              invoice was requested for a customer with a TIN (Simple POS parity). */}
          {order.taxRequested && order.customer?.taxId && (
            <div
              className="mt-2.5 border-t border-dashed pt-2.5 text-[11.5px] leading-[1.8]"
              style={{ borderColor: "#cbd5e1", color: "#475569" }}
            >
              <div className="font-semibold" style={{ color: "#0f172a" }}>
                ข้อมูลผู้เสียภาษี
              </div>
              <div style={{ fontFamily: "var(--font-sans)" }}>{order.customer.name}</div>
              {/* Customer address (GAP 1) — the billing/tax address ("ที่อยู่ออก
                  ใบกำกับ") from the Simple POS IA; rendered when the customer has
                  one (older/walk-in members may not). */}
              {order.customer.address && (
                <div style={{ fontFamily: "var(--font-sans)" }}>
                  {order.customer.address}
                </div>
              )}
              <div>TIN {order.customer.taxId}</div>
            </div>
          )}

          {/* VAT-inclusive note — the 80mm receipt omits the VAT breakdown; state
              that the shown prices already include 7% VAT (the full A4 tax invoice
              still itemizes VAT for a legal §86/4 claim). */}
          <div
            className="mt-3 text-center text-[11px] font-semibold"
            style={{ color: "#475569", fontFamily: "var(--font-sans)" }}
          >
            ราคานี้รวมภาษีมูลค่าเพิ่ม 7% แล้ว
          </div>
          <div
            className="mt-2 text-center text-[11px]"
            style={{ color: "var(--soft)", fontFamily: "var(--font-sans)" }}
          >
            ขอบคุณที่ใช้บริการ · Thank you
          </div>
        </div>

        {/* Action side (hidden when printing via .no-print) */}
        <div className="no-print flex min-w-0 flex-1 flex-col" style={{ padding: "26px 24px" }}>
          <div className="flex items-center gap-[11px]">
            <div
              className="grid h-[46px] w-[46px] place-items-center rounded-full"
              style={{ background: "#dcfce7" }}
            >
              <Check size={24} strokeWidth={2.4} color="#16a34a" />
            </div>
            <div>
              <h2 className="m-0 text-[18px] font-bold">ชำระเงินสำเร็จ</h2>
              <div className="text-[12.5px]" style={{ color: "var(--soft)" }}>
                Payment complete
              </div>
            </div>
          </div>

          {/* Sync badge (display-receipt-sync-badge) — DYNAMIC (GAP 2): driven by
              order.syncStatus via the shared syncMeta, matching Sales History. */}
          <div
            className="mt-[18px] flex items-center gap-2.5 rounded-[12px] border px-3.5 py-3"
            style={{ background: sy.bg, borderColor: sy.fg + "33" }}
          >
            <span
              className="h-[9px] w-[9px] flex-shrink-0 rounded-full"
              style={{ background: sy.dot }}
            />
            <div className="flex-1">
              <div className="text-[13px] font-semibold" style={{ color: sy.fg }}>
                {sy.label}
              </div>
              <div className="text-[11px]" style={{ color: sy.fg, opacity: 0.75 }}>
                {sy.en}
              </div>
            </div>
          </div>

          {/* Faux QR → digital receipt link */}
          <div className="mt-[18px] flex items-center gap-4">
            <div
              className="flex-shrink-0 rounded-[12px] border bg-white p-[7px]"
              style={{ width: 104, height: 104, borderColor: "#e2e8f0" }}
            >
              <FauxQR size={90} />
            </div>
            <div className="text-[12px] leading-[1.5]" style={{ color: "#64748b" }}>
              สแกนเพื่อดูใบเสร็จดิจิทัล
              <br />
              และดาวน์โหลด PDF
              <br />
              <span className="font-semibold" style={{ color: "#2563eb" }}>
                rcpt.krspos.co/{shortId}
              </span>
            </div>
          </div>

          <div className="flex-1" />

          {/* Print / email */}
          <div className="mt-[18px] grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={onPrint}
              className="flex h-[46px] items-center justify-center gap-[7px] rounded-[11px] border bg-white text-[13px] font-semibold"
              style={{ borderColor: "#e2e8f0", color: "#334155" }}
            >
              <Printer size={17} strokeWidth={2} />
              พิมพ์ใบเสร็จ
            </button>
            <button
              type="button"
              onClick={onEmail}
              className="flex h-[46px] items-center justify-center gap-[7px] rounded-[11px] border bg-white text-[13px] font-semibold"
              style={{ borderColor: "#e2e8f0", color: "#334155" }}
            >
              <Mail size={17} strokeWidth={2} />
              ส่งอีเมล/ลิงก์
            </button>
          </div>

          {/* New sale — the only dismissal */}
          <button
            type="button"
            onClick={onNewSale}
            className="mt-[9px] flex h-[50px] items-center justify-center gap-2 rounded-[12px] text-[15px] font-bold text-white"
            style={{ background: "#0f172a" }}
          >
            เริ่มบิลใหม่ · New sale
          </button>
        </div>
      </div>
    </Modal>
  );
}

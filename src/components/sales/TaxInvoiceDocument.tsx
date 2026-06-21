"use client";

import { useEffect } from "react";
import { X, Printer } from "lucide-react";
import { Modal } from "@/components/Modal";
import type { OrderDTO, SellerConfigDTO } from "@/types";
import { money } from "@/lib/money";
import { bangkokDateParts } from "@/lib/datetime";

type TaxInvoiceDocumentProps = {
  open: boolean;
  order: OrderDTO | null;
  /**
   * Seller identity (§86/4 mandatory: name/address/TIN/branch). Read from env via
   * GET /api/seller-config (D2). When null the document cannot be issued — the
   * caller must not open this modal; this component renders nothing as a guard.
   */
  seller: SellerConfigDTO | null;
  onClose: () => void;
  onPrint: () => void;
};

/**
 * Format an ISO instant as the §86/4 "วันที่ออกใบกำกับภาษี" (issue date) in the
 * Asia/Bangkok calendar. Uses bangkokDateParts (the shared TZ-correct helper) so
 * an early-morning Thai issue lands on the right Thai date — never a UTC slip.
 *
 * The year is rendered in the Buddhist Era (พ.ศ. = Gregorian + 543, FIX 3) per
 * Thai tax-document convention — e.g. Gregorian 2026 prints as 2569. This is the
 * DISPLAYED year only; the internal TAX-YYYY- document-number prefix stays
 * Gregorian (it is a system id minted by Postgres).
 */
function formatIssueDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const { y, m, d: day } = bangkokDateParts(d);
  // Thai month abbreviations (Buddhist-era year shown per Thai tax convention).
  const THAI_MONTHS = [
    "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
    "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
  ];
  const monthLabel = THAI_MONTHS[m - 1] ?? String(m);
  const buddhistYear = y + 543;
  return `${day} ${monthLabel} ${buddhistYear}`;
}

/**
 * A4 full tax invoice (ใบกำกับภาษีแบบเต็มรูป, Revenue Code §86/4) — Phase 4,
 * owner decision D4 (a SEPARATE A4 document; the 80mm thermal ReceiptModal is
 * untouched for normal receipts). Rendered ONLY for a bill that already carries a
 * minted `accountingDocNo` (a tax invoice was issued at request-tax time).
 *
 * ALL money/identifiers come from STORED order/customer fields + the env seller
 * block — nothing is recomputed and the sequential number is never re-minted
 * here (reprint = render-only). The VAT is broken out per §86/4(6): the pre-VAT
 * base is DERIVED as total − tax from the stored Decimals (the existing
 * VAT-inclusive math is legally correct; this only DISPLAYS it broken out).
 *
 * The §86/4 mandatory particulars rendered here:
 *   1. The heading "ใบกำกับภาษี"
 *   2. Seller: name + registered address + 13-digit TIN + branch designation
 *   3. Buyer: name + address + TIN + branch designation
 *   4. The sequential serial number (accountingDocNo)
 *   5. Line detail: description, quantity, unit price, amount
 *   6. VAT broken out: pre-VAT base + 7% VAT + grand total (inclusive)
 *   7. Date of issuance (Asia/Bangkok)
 *
 * Print isolation: the `.print-tax-invoice` paper + `@page { size: A4 portrait }`
 * rules live in globals.css; everything else is hidden via the shared @media print
 * block. Visual language follows the Taste redesign (forest/mint headings, blue
 * accounting tint for the doc number, IBM Plex Sans Thai/Mono, restrained
 * hairline borders).
 */
export function TaxInvoiceDocument({
  open,
  order,
  seller,
  onClose,
  onPrint,
}: TaxInvoiceDocumentProps) {
  // Toggle the body class that switches @media print to A4 portrait + isolates
  // the .print-tax-invoice paper (see globals.css). Cleanup removes it so a
  // subsequent receipt print falls back to the default 80mm rules. Runs as an
  // effect (not in render) so it never mutates the DOM during render; depends on
  // [open] only.
  useEffect(() => {
    if (!open) return;
    document.body.classList.add("printing-tax-invoice");
    return () => {
      document.body.classList.remove("printing-tax-invoice");
    };
  }, [open]);

  // Guard: never render without an order, a minted number, or a seller block — the
  // document would be a non-compliant §86/4 invoice. The caller already gates on
  // these; this is defense-in-depth.
  if (!open || !order || !seller) return null;
  if (!order.accountingDocNo || order.accountingDocNo.trim().length === 0)
    return null;

  // STORED money (Decimal → string|number on the wire). The base is total − tax
  // (the VAT-inclusive total already contains the 7% VAT; §86/4(6) wants it shown
  // broken out, NOT recomputed). Number() here is DISPLAY-only formatting via
  // money(), never re-storing a value.
  const totalNum = Number(order.total);
  const vatNum = Number(order.tax);
  const baseNum = totalNum - vatNum;
  const discountNum = Number(order.discount);
  const hasDiscount = discountNum > 0.005;
  // STORED Order.subtotal = Σ per-line lineTotal (before the bill discount), FIX 4.
  // Surfaced as the "รวมเป็นเงิน" reconciliation row so the document chain is
  // visibly closable: subtotal − discount = total(incl VAT); base = total − VAT.
  const subtotalNum = Number(order.subtotal);

  const buyer = order.customer;
  // A tax invoice is only ever issued for a tax customer (the route gates on a
  // taxId), so buyer should be present with a taxId — fall back defensively.
  const buyerName = buyer?.name ?? "—";
  const buyerAddress = buyer?.address ?? "—";
  const buyerTaxId = buyer?.taxId ?? "—";
  const buyerBranchCode = buyer?.buyerBranchCode ?? "00000";
  const buyerBranchLabel =
    buyerBranchCode === "00000"
      ? "สำนักงานใหญ่"
      : `สาขาที่ ${buyerBranchCode}`;

  return (
    // onClose closes the modal (X / backdrop / Esc handled by Modal). Printing is
    // an explicit button; closing does not print.
    <Modal open={open} onClose={onClose} label="ใบกำกับภาษี">
      <div
        className="flex max-h-[92vh] w-[860px] max-w-[96vw] flex-col overflow-hidden rounded-[18px] bg-[#f1f5f9]"
        style={{ boxShadow: "0 30px 70px rgba(0,0,0,.35)" }}
      >
        {/* Toolbar (hidden when printing) */}
        <div
          className="no-print flex items-center justify-between border-b bg-white px-5 py-3.5"
          style={{ borderColor: "var(--line)" }}
        >
          <div className="flex items-center gap-2.5">
            <span
              className="grid h-[34px] w-[34px] place-items-center rounded-[10px]"
              style={{ background: "var(--mint)", color: "var(--brand-2)" }}
            >
              <Printer size={18} strokeWidth={2} />
            </span>
            <div>
              <div className="text-[14px] font-bold" style={{ color: "var(--ink)" }}>
                ใบกำกับภาษีแบบเต็มรูป
              </div>
              <div className="text-[11.5px]" style={{ color: "var(--soft)" }}>
                Full tax invoice · {order.accountingDocNo}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onPrint}
              className="flex h-[40px] items-center gap-2 rounded-[11px] px-4 text-[13px] font-bold text-white transition"
              style={{ background: "var(--forest)" }}
            >
              <Printer size={16} strokeWidth={2} />
              พิมพ์ · Print
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="ปิด"
              className="grid h-[40px] w-[40px] place-items-center rounded-[11px] border transition hover:bg-[var(--surface-2)]"
              style={{ borderColor: "var(--line)", color: "var(--soft)" }}
            >
              <X size={18} strokeWidth={2} />
            </button>
          </div>
        </div>

        {/* A4 document paper — this is what @media print isolates */}
        <div className="overflow-y-auto p-6">
          <div
            className="print-tax-invoice mx-auto bg-white"
            style={{
              width: "210mm",
              maxWidth: "100%",
              padding: "16mm 14mm",
              fontFamily: "var(--font-sans), sans-serif",
              color: "var(--ink)",
            }}
          >
            {/* §86/4(1) — heading + seller identity */}
            <div
              className="flex items-start justify-between gap-6 border-b pb-5"
              style={{ borderColor: "var(--line-strong)" }}
            >
              <div className="min-w-0">
                <div className="text-[19px] font-bold" style={{ color: "var(--forest)" }}>
                  {seller.name}
                </div>
                <div className="mt-1 text-[12.5px] leading-[1.6]" style={{ color: "#475569" }}>
                  {seller.address}
                </div>
                <div className="mt-1.5 text-[12.5px]" style={{ color: "#475569" }}>
                  เลขประจำตัวผู้เสียภาษี{" "}
                  <span className="mono font-semibold" style={{ color: "var(--ink)" }}>
                    {seller.taxId}
                  </span>
                </div>
                <div className="text-[12.5px]" style={{ color: "#475569" }}>
                  {seller.branchLabel} (รหัสสาขา{" "}
                  <span className="mono">{seller.branchCode}</span>)
                </div>
              </div>
              <div className="flex-shrink-0 text-right">
                <div className="text-[22px] font-bold leading-tight" style={{ color: "var(--ink)" }}>
                  ใบกำกับภาษี
                </div>
                <div className="text-[12px]" style={{ color: "var(--soft)" }}>
                  TAX INVOICE
                </div>
                <div
                  className="mt-3 inline-block rounded-[8px] px-3 py-1.5 text-left"
                  style={{ background: "var(--blue-soft)" }}
                >
                  <div className="text-[10.5px]" style={{ color: "#1e40af", opacity: 0.8 }}>
                    เลขที่ · No.
                  </div>
                  <div className="mono text-[14px] font-bold" style={{ color: "#1e40af" }}>
                    {order.accountingDocNo}
                  </div>
                </div>
                <div className="mt-2 text-[11.5px]" style={{ color: "#475569" }}>
                  วันที่ออก ·{" "}
                  <span className="font-semibold" style={{ color: "var(--ink)" }}>
                    {/* §86/4(7) ISSUE date (FIX 1): the date the tax invoice was
                       ISSUED at request-tax, NOT the sale date. A post-sale
                       request-tax (days later) must print the issue date. Fall
                       back to createdAt only for legacy rows minted before
                       taxIssuedAt existed. */}
                    {formatIssueDate(order.taxIssuedAt ?? order.createdAt)}
                  </span>
                </div>
                <div className="text-[11px]" style={{ color: "var(--soft)" }}>
                  อ้างอิงบิล {order.orderNumber}
                </div>
              </div>
            </div>

            {/* §86/4(3) — buyer identity */}
            <div
              className="mt-5 rounded-[12px] border p-4"
              style={{ borderColor: "var(--line)", background: "var(--surface-2)" }}
            >
              <div className="text-[11px] font-semibold" style={{ color: "var(--soft)" }}>
                ลูกค้า · Customer
              </div>
              <div className="mt-1 text-[14px] font-bold" style={{ color: "var(--ink)" }}>
                {buyerName}
              </div>
              <div className="mt-0.5 text-[12.5px] leading-[1.6]" style={{ color: "#475569" }}>
                {buyerAddress}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-0.5 text-[12.5px]" style={{ color: "#475569" }}>
                <span>
                  เลขประจำตัวผู้เสียภาษี{" "}
                  <span className="mono font-semibold" style={{ color: "var(--ink)" }}>
                    {buyerTaxId}
                  </span>
                </span>
                <span>
                  {buyerBranchLabel} (รหัสสาขา{" "}
                  <span className="mono">{buyerBranchCode}</span>)
                </span>
              </div>
            </div>

            {/* §86/4(5) — line detail: description / qty / unit price / amount */}
            <table className="mt-5 w-full border-collapse text-[12.5px]">
              <thead>
                <tr style={{ color: "var(--soft)" }}>
                  <th
                    className="border-b px-2 py-2 text-left font-semibold"
                    style={{ borderColor: "var(--line-strong)" }}
                  >
                    รายการ · Description
                  </th>
                  <th
                    className="border-b px-2 py-2 text-right font-semibold"
                    style={{ borderColor: "var(--line-strong)", width: "12%" }}
                  >
                    จำนวน
                  </th>
                  <th
                    className="border-b px-2 py-2 text-right font-semibold"
                    style={{ borderColor: "var(--line-strong)", width: "20%" }}
                  >
                    ราคา/หน่วย
                  </th>
                  <th
                    className="border-b px-2 py-2 text-right font-semibold"
                    style={{ borderColor: "var(--line-strong)", width: "22%" }}
                  >
                    จำนวนเงิน
                  </th>
                </tr>
              </thead>
              <tbody>
                {order.items.map((it) => (
                  <tr key={it.id} style={{ color: "#334155" }}>
                    <td
                      className="border-b px-2 py-2.5"
                      style={{ borderColor: "var(--line)" }}
                    >
                      {it.product.name}
                    </td>
                    <td
                      className="border-b px-2 py-2.5 text-right mono"
                      style={{ borderColor: "var(--line)" }}
                    >
                      {it.quantity}
                    </td>
                    <td
                      className="border-b px-2 py-2.5 text-right mono"
                      style={{ borderColor: "var(--line)" }}
                    >
                      {money(Number(it.unitPrice))}
                    </td>
                    <td
                      className="border-b px-2 py-2.5 text-right mono"
                      style={{ borderColor: "var(--line)" }}
                    >
                      {money(Number(it.lineTotal))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* §86/4(6) — VAT broken out (base + 7% VAT + inclusive total) */}
            <div className="mt-5 flex justify-end">
              <div className="w-[300px] max-w-full text-[13px]">
                {/* Reconciliation anchor (FIX 4): Σ lineTotal = STORED
                    Order.subtotal — the same value the line-items table sums to.
                    Renders the visible chain subtotal − discount = total(incl
                    VAT) so a reader can close the document arithmetic even when a
                    bill discount exists. */}
                <div className="flex justify-between py-1" style={{ color: "#475569" }}>
                  <span>รวมเป็นเงิน · Subtotal</span>
                  <span className="mono">{money(subtotalNum)}</span>
                </div>
                {hasDiscount && (
                  <div className="flex justify-between py-1" style={{ color: "#475569" }}>
                    <span>ส่วนลด · Discount</span>
                    <span className="mono">-{money(discountNum)}</span>
                  </div>
                )}
                <div className="flex justify-between py-1" style={{ color: "#475569" }}>
                  <span>มูลค่าก่อนภาษี · Pre-VAT</span>
                  <span className="mono">{money(baseNum)}</span>
                </div>
                <div className="flex justify-between py-1" style={{ color: "#475569" }}>
                  <span>ภาษีมูลค่าเพิ่ม 7% · VAT</span>
                  <span className="mono">{money(vatNum)}</span>
                </div>
                <div
                  className="mt-1.5 flex justify-between border-t pt-2 text-[15px] font-bold"
                  style={{ borderColor: "var(--line-strong)", color: "var(--ink)" }}
                >
                  <span>ยอดรวมทั้งสิ้น · Total</span>
                  <span className="mono">{money(totalNum)}</span>
                </div>
                <div className="mt-1 text-right text-[10.5px]" style={{ color: "var(--soft)" }}>
                  ราคารวมภาษีมูลค่าเพิ่มแล้ว · VAT included
                </div>
              </div>
            </div>

            {/* Footer — signature lines + legal note */}
            <div
              className="mt-10 flex items-end justify-between gap-10 border-t pt-6 text-[11.5px]"
              style={{ borderColor: "var(--line)", color: "var(--soft)" }}
            >
              <div className="flex-1">
                เอกสารออกเป็นชุด — ต้นฉบับ (ลูกค้า) / สำเนา (ผู้ขาย)
              </div>
              <div className="text-center">
                <div className="mb-1 h-[1px] w-[180px]" style={{ background: "var(--line-strong)" }} />
                ผู้รับเงิน · Authorized signature
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

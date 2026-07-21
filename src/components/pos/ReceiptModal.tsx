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
   * Capture mode (pos-receipt-image): render the receipt OFF-SCREEN but fully
   * laid out (via Modal `captureSource`) so the POS agent path can rasterize the
   * `.print-receipt` DOM to a PNG with html2canvas — the browser draws Thai with
   * its own font, so the printed raster has correct glyphs. Distinct from
   * `autoPrint` (which renders display:none for `window.print()`): capture mode
   * needs the paper VISIBLE-to-the-renderer and at FULL natural height (no
   * scroll clip), so the paper drops its `max-h`/`overflow` and the on-screen
   * action chrome is omitted. Mutually exclusive with `autoPrint`.
   */
  captureMode?: boolean;
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
  captureMode = false,
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
  const sellerAddress = sellerInfo.sellerAddress?.trim() || "";
  const sellerTaxId = sellerInfo.sellerTaxId?.trim() || "";

  const posNo = order.orderNumber;
  const shortId = posNo.slice(-6); // domain-receipt-shortid
  const totalNum = Number(order.total);
  const changeNum = Number(order.change);
  const hasChange = changeNum > 0.01;

  // Promotions program (Phase 7): receipt discount lines. All money is read from the
  // 2dp-string order contract via a defensive Number(). `grossNum` is the pre-discount
  // line sum (Σ unitPrice × qty); the total the customer saved is gross − total.
  const subtotalNum = Number(order.subtotal);
  const discountNum = Number(order.discount);
  const promoBillDiscountNum = Number(order.promoBillDiscount ?? 0);
  // Loyalty redemption (loyalty program, Phase 2): the points-redemption slice of
  // `discount` + the points spent. `discount` is the COMBINED bill discount (promo +
  // manual + redemption), so the manual slice must subtract BOTH the promo AND the
  // redemption — otherwise the "ส่วนลดท้ายบิล" (manual) row would double-count the
  // redemption. This keeps the totals block footing subtotal − promo − manual −
  // redemption = total, with redemption shown as its OWN row below.
  const pointsRedemptionDiscountNum = Number(order.pointsRedemptionDiscount ?? 0);
  const pointsRedeemedNum = Number(order.pointsRedeemed ?? 0);
  // Manual bill discount = the non-promo, non-redemption slice of `discount`.
  const manualBillDiscountNum = Math.max(
    discountNum - promoBillDiscountNum - pointsRedemptionDiscountNum,
    0
  );
  const grossNum = order.items.reduce(
    (sum, it) => sum + Number(it.unitPrice) * it.quantity,
    0
  );
  const savingsNum = grossNum - totalNum;
  // Loyalty EARN (loyalty program, Phase 1B): whole points accrued on this sale. A
  // plain Int on the order contract (0 / absent for a walk-in / non-member / loyalty-
  // off bill, and for legacy pre-loyalty reprints). The member's balance-AFTER is not
  // carried on the order DTO, so the receipt shows only the earned line (on both the
  // fresh print and a reprint), keeping the raster bill height controlled.
  const pointsEarnedNum = Number(order.pointsEarned ?? 0);
  // Any discount at all (line-level and/or bill-level) → show the ยอดรวม (subtotal)
  // line so the totals block foots subtotal − promoBill − manual = total.
  const anyDiscount = savingsNum > 0.005;
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
    <Modal
      open={open}
      onClose={() => {}}
      label="ใบเสร็จ"
      printSource={autoPrint && !captureMode}
      captureSource={captureMode}
    >
      <div
        className={
          captureMode
            ? "flex bg-white"
            : "flex max-h-[92vh] w-[720px] max-w-[94vw] overflow-hidden rounded-[18px]"
        }
        style={
          captureMode
            ? { background: "#ffffff" }
            : { background: "#f1f5f9", boxShadow: "0 30px 70px rgba(0,0,0,.35)" }
        }
      >
        {/* Receipt paper (80mm) — @media print isolates it; capture mode drops the
            overflow/scroll clip so html2canvas rasterizes the FULL height. */}
        <div
          className={
            "print-receipt w-[330px] flex-shrink-0 bg-white" +
            (captureMode ? "" : " overflow-y-auto")
          }
          style={{ padding: "4px 10px", fontFamily: "var(--font-mono), monospace" }}
        >
          {/* Header */}
          <div
            className="border-b border-dashed pb-2 text-center"
            style={{ borderColor: "#cbd5e1" }}
          >
            {/* Company name — single line at 72mm: no letter-spacing, tight
                leading, smaller size so a long registered name fits one row. */}
            <div
              className="text-[14px] font-bold leading-tight"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              {sellerName}
            </div>
            <div className="mt-0.5 text-[10.5px]" style={{ color: "#64748b" }}>
              {branchLine}
            </div>
            {/* Phone + POS ID render only when configured (KRS reference receipt
                parity) — never show an empty/placeholder line. */}
            {sellerPhone && (
              <div className="text-[10.5px]" style={{ color: "#64748b" }}>
                โทร {sellerPhone}
              </div>
            )}
            {sellerPosId && (
              <div className="text-[10.5px]" style={{ color: "#64748b" }}>
                POS: {sellerPosId}
              </div>
            )}
            {/* Registered address + seller TIN (seller-company-settings) — render
                only when set in Settings, mirroring the phone/POS conditional. */}
            {sellerAddress && (
              <div
                className="mt-0.5 text-[10.5px]"
                style={{ color: "#64748b", fontFamily: "var(--font-sans)" }}
              >
                {sellerAddress}
              </div>
            )}
            {sellerTaxId && (
              <div className="text-[10.5px]" style={{ color: "#64748b" }}>
                เลขประจำตัวผู้เสียภาษี {sellerTaxId}
              </div>
            )}
            {/* Document title — the receipt's legal heading, sits at the bottom of
                the header block just above the dashed rule / meta section. */}
            <div
              className="mt-1.5 text-[12.5px] font-bold"
              style={{ color: "#0f172a", fontFamily: "var(--font-sans)" }}
            >
              ใบเสร็จรับเงินสด
            </div>
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
              {/* Per-line promotion (promotions program, Phase 7) — monochrome text. */}
              {it.promotionName && (
                <div
                  className="flex justify-between text-[10.5px]"
                  style={{ color: "var(--soft)", fontFamily: "var(--font-sans)" }}
                >
                  <span>โปร: {it.promotionName}</span>
                  <span>-{money(Number(it.promoDiscount ?? 0))}</span>
                </div>
              )}
              {/* Redeemed reward (loyalty program, Phase 3B) — the free-unit value folded
                  into lineTotal, shown as its own "แลกของรางวัล" line so the customer sees
                  what the points bought. Gold-neutral: the 1-bit thermal raster prints
                  monochrome (color never survives), so this rides the same soft neutral as
                  the promo line to keep the raster height/legibility controlled. */}
              {it.rewardName && Number(it.rewardDiscount ?? 0) > 0 && (
                <div
                  className="flex justify-between text-[10.5px]"
                  style={{ color: "var(--soft)", fontFamily: "var(--font-sans)" }}
                >
                  <span>แลกของรางวัล: {it.rewardName}</span>
                  <span>-{money(Number(it.rewardDiscount ?? 0))}</span>
                </div>
              )}
            </div>
          ))}

          {/* Totals — subtotal + discount breakdown (promotions program, Phase 7) then
              the net. The subtotal + discount rows appear only when a discount exists;
              a plain no-discount bill still shows just รวมสุทธิ (unchanged). */}
          <div
            className="mt-3 border-t border-dashed pt-2.5 text-[11.5px] leading-[1.9]"
            style={{ borderColor: "#cbd5e1", color: "#475569" }}
          >
            {anyDiscount && (
              <div
                className="flex justify-between"
                style={{ fontFamily: "var(--font-sans)" }}
              >
                <span>ยอดรวม</span>
                <span>{money(subtotalNum)}</span>
              </div>
            )}
            {promoBillDiscountNum > 0 && (
              <div
                className="flex justify-between"
                style={{ fontFamily: "var(--font-sans)" }}
              >
                <span>
                  ส่วนลดโปรโมชันท้ายบิล
                  {order.billPromotionName ? ` · ${order.billPromotionName}` : ""}
                </span>
                <span>-{money(promoBillDiscountNum)}</span>
              </div>
            )}
            {manualBillDiscountNum > 0 && (
              <div
                className="flex justify-between"
                style={{ fontFamily: "var(--font-sans)" }}
              >
                <span>ส่วนลดท้ายบิล</span>
                <span>-{money(manualBillDiscountNum)}</span>
              </div>
            )}
            {/* Points redemption (loyalty program, Phase 2) — its OWN row, SEPARATE from
                the manual + promo discount rows so a redeem is never silently absorbed
                into "ส่วนลดท้ายบิล". One concise Thai line (points suffix inline) to
                keep the 1-bit thermal raster height controlled. */}
            {pointsRedemptionDiscountNum > 0 && (
              <div
                className="flex justify-between"
                style={{ fontFamily: "var(--font-sans)" }}
              >
                <span>
                  ใช้แต้มแลกส่วนลด
                  {pointsRedeemedNum > 0 ? ` (-${pointsRedeemedNum} แต้ม)` : ""}
                </span>
                <span>-{money(pointsRedemptionDiscountNum)}</span>
              </div>
            )}
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

          {/* Total savings (promotions program, Phase 7) — the sum of every line- and
              bill-level discount (gross − net). Centered, just above the VAT note. */}
          {savingsNum > 0.005 && (
            <div
              className="mt-2.5 text-center text-[11.5px] font-bold"
              style={{ color: "#0f172a", fontFamily: "var(--font-sans)" }}
            >
              คุณประหยัดไป {money(savingsNum)}
            </div>
          )}

          {/* Loyalty points earned (loyalty program, Phase 1B) — one concise Thai line
              so the raster bill height stays controlled. Monochrome (the thermal raster
              is 1-bit, so color never prints); the member's balance-after is omitted (it
              is not carried on the order DTO, and would be stale on a reprint). Shown on
              ALL three render paths, since they all rasterize/print this same DOM. */}
          {pointsEarnedNum > 0 && (
            <div
              className="mt-2.5 text-center text-[11.5px] font-semibold"
              style={{ color: "#0f172a", fontFamily: "var(--font-sans)" }}
            >
              แต้มที่ได้รับ +{pointsEarnedNum}
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

        {/* Action side (hidden when printing via .no-print). Omitted entirely in
            capture mode — only the receipt paper is rasterized (pos-receipt-image). */}
        {!captureMode && (
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
        )}
      </div>
    </Modal>
  );
}

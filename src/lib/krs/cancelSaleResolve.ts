// Pure doc-resolution decision logic for the KRS VOID cancel (krs-void-writeback).
// SPLIT OUT of cancelSale.ts on purpose: this file imports NO mssql driver and NO
// Prisma singleton, so it is unit-testable in isolation (mirrors how salePayload.ts
// keeps salePayloadHasDiscount pure and importable without the node-only driver graph).
// cancelSale.ts feeds it the two PosBillNo-lookup results (or undefined when the lookup
// missed) and the stored saleRef fallback; this returns the resolved SC/OSL VoucherNos —
// or an `ok:false` reason the caller turns into a KrsWriteError.

import { type VoidSaleRef } from "./voidPayload";

export type CancelVoucherResolution =
  | {
      ok: true;
      /** SalesInvoiceHdr / TheJournal / SalePurchaseTax VoucherNo (SC-{YYMM}-{NNNN}). */
      saleVoucherNo: string;
      /** InventoryFlowHdr VoucherNo (OSL-{YYMM}-{NNNN}). */
      flowVoucherNo: string;
      /** true when the value came from the live PosBillNo lookup (vs the saleRef fallback). */
      saleFromLookup: boolean;
      flowFromLookup: boolean;
      /** true when BOTH a live-lookup voucher AND a stored saleRef voucher were present
       *  but disagreed — the live lookup WINS; the caller logs the mismatch. */
      saleVoucherMismatch: boolean;
      flowVoucherMismatch: boolean;
    }
  | { ok: false; reason: string };

/**
 * Decide the SC (SalesInvoiceHdr) and OSL (InventoryFlowHdr) VoucherNos to cancel.
 *
 * PRIMARY: the VoucherNo from the live PosBillNo lookup (works for any bill sold after
 * the 16/17-07-26 PosBillNo columns landed: writeback.ts:633,767). FALLBACK:
 * payload.saleRef.{saleVoucherNo,flowVoucherNo} (recovered from the original SALE job's
 * stored response) for a pre-16-07 bill with no PosBillNo in KRS. If EITHER voucher
 * resolves to neither a lookup value nor a saleRef fallback → `ok:false` (the caller
 * throws a KrsWriteError, naming the bill — an operator/manual case, never a silent no-op).
 *
 * A live-lookup value ALWAYS wins over a stored saleRef; when both are present and
 * disagree, the mismatch flags let the caller log it (the live doc is authoritative).
 *
 * Pure: no I/O.
 */
export function resolveCancelVouchers(
  hdrVoucherFromLookup: string | undefined,
  flowVoucherFromLookup: string | undefined,
  saleRef: VoidSaleRef,
  orderNumber: string
): CancelVoucherResolution {
  const saleVoucherNo = hdrVoucherFromLookup ?? saleRef.saleVoucherNo;
  const flowVoucherNo = flowVoucherFromLookup ?? saleRef.flowVoucherNo;
  if (!saleVoucherNo || !flowVoucherNo) {
    const missing = [
      saleVoucherNo ? null : "SalesInvoiceHdr(SC)",
      flowVoucherNo ? null : "InventoryFlowHdr(OSL)",
    ]
      .filter(Boolean)
      .join(" + ");
    return {
      ok: false,
      reason: `Cannot resolve KRS documents for ${orderNumber} — no PosBillNo match and no saleRef fallback for ${missing}`,
    };
  }
  return {
    ok: true,
    saleVoucherNo,
    flowVoucherNo,
    saleFromLookup: hdrVoucherFromLookup != null,
    flowFromLookup: flowVoucherFromLookup != null,
    saleVoucherMismatch:
      hdrVoucherFromLookup != null &&
      saleRef.saleVoucherNo != null &&
      hdrVoucherFromLookup !== saleRef.saleVoucherNo,
    flowVoucherMismatch:
      flowVoucherFromLookup != null &&
      saleRef.flowVoucherNo != null &&
      flowVoucherFromLookup !== saleRef.flowVoucherNo,
  };
}

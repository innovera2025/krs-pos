// PURE unit tests for the VOID doc-resolution decision logic (krs-void-writeback).
// resolveCancelVouchers decides which SC/OSL VoucherNos to soft-close: PosBillNo lookup
// is primary, the stored saleRef is the fallback, and an unresolvable case must fail
// LOUDLY (never a silent no-op). No DB, no mssql — the decision is pinned here.

import { describe, it, expect } from "vitest";
import { resolveCancelVouchers } from "./cancelSaleResolve";
import type { VoidSaleRef } from "./voidPayload";

const ORDER = "POS-20260719-0001";
const emptyRef: VoidSaleRef = {};

describe("resolveCancelVouchers — live PosBillNo lookup (primary)", () => {
  it("uses both lookup vouchers when present; marks them fromLookup with no mismatch", () => {
    const r = resolveCancelVouchers("SC-2607-0023", "OSL-2607-0023", emptyRef, ORDER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saleVoucherNo).toBe("SC-2607-0023");
    expect(r.flowVoucherNo).toBe("OSL-2607-0023");
    expect(r.saleFromLookup).toBe(true);
    expect(r.flowFromLookup).toBe(true);
    expect(r.saleVoucherMismatch).toBe(false);
    expect(r.flowVoucherMismatch).toBe(false);
  });

  it("prefers the live lookup over a disagreeing saleRef and flags the mismatch", () => {
    const ref: VoidSaleRef = { saleVoucherNo: "SC-OLD-0001", flowVoucherNo: "OSL-OLD-0001" };
    const r = resolveCancelVouchers("SC-2607-0023", "OSL-2607-0023", ref, ORDER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saleVoucherNo).toBe("SC-2607-0023"); // live lookup wins
    expect(r.flowVoucherNo).toBe("OSL-2607-0023");
    expect(r.saleVoucherMismatch).toBe(true);
    expect(r.flowVoucherMismatch).toBe(true);
  });

  it("does not flag a mismatch when the lookup and saleRef agree", () => {
    const ref: VoidSaleRef = { saleVoucherNo: "SC-2607-0023", flowVoucherNo: "OSL-2607-0023" };
    const r = resolveCancelVouchers("SC-2607-0023", "OSL-2607-0023", ref, ORDER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saleVoucherMismatch).toBe(false);
    expect(r.flowVoucherMismatch).toBe(false);
  });
});

describe("resolveCancelVouchers — saleRef fallback (pre-16-07 bills)", () => {
  it("falls back to saleRef when the PosBillNo lookup missed", () => {
    const ref: VoidSaleRef = { saleVoucherNo: "SC-2605-0007", flowVoucherNo: "OSL-2605-0007" };
    const r = resolveCancelVouchers(undefined, undefined, ref, ORDER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saleVoucherNo).toBe("SC-2605-0007");
    expect(r.flowVoucherNo).toBe("OSL-2605-0007");
    expect(r.saleFromLookup).toBe(false);
    expect(r.flowFromLookup).toBe(false);
    // No live lookup value → never a mismatch (nothing to disagree with).
    expect(r.saleVoucherMismatch).toBe(false);
    expect(r.flowVoucherMismatch).toBe(false);
  });

  it("mixes a live hdr lookup with a saleRef flow fallback", () => {
    const ref: VoidSaleRef = { flowVoucherNo: "OSL-2605-0007" };
    const r = resolveCancelVouchers("SC-2607-0023", undefined, ref, ORDER);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.saleVoucherNo).toBe("SC-2607-0023");
    expect(r.flowVoucherNo).toBe("OSL-2605-0007");
    expect(r.saleFromLookup).toBe(true);
    expect(r.flowFromLookup).toBe(false);
  });
});

describe("resolveCancelVouchers — unresolvable → ok:false (loud, names the bill)", () => {
  it("fails when neither lookup nor saleRef resolves either voucher", () => {
    const r = resolveCancelVouchers(undefined, undefined, emptyRef, ORDER);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain(ORDER);
    expect(r.reason).toContain("SalesInvoiceHdr(SC)");
    expect(r.reason).toContain("InventoryFlowHdr(OSL)");
  });

  it("fails naming only the missing document when just the flow voucher is unresolvable", () => {
    const ref: VoidSaleRef = { saleVoucherNo: "SC-2607-0023" };
    const r = resolveCancelVouchers(undefined, undefined, ref, ORDER);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("InventoryFlowHdr(OSL)");
    expect(r.reason).not.toContain("SalesInvoiceHdr(SC)");
  });

  it("treats an empty-string voucher as unresolvable (never soft-closes on a blank)", () => {
    const r = resolveCancelVouchers("", "OSL-2607-0023", emptyRef, ORDER);
    expect(r.ok).toBe(false);
  });
});

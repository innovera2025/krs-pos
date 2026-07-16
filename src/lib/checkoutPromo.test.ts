import { describe, it, expect } from "vitest";
import {
  applyPromotions,
  type ActivePromotion,
} from "@/lib/promotionEngine";
import {
  computeOrderTotals,
  type OrderProductRow,
  type OrderRequestLine,
} from "@/lib/pricing";
import {
  salePayloadHasDiscount,
  type SalePayload,
  type SalePayloadItem,
} from "@/lib/krs/salePayload";

// ---------------------------------------------------------------------------
// Checkout promotion integration (Phase 6) — pure-level verification of the exact
// server recompute wiring in src/app/api/orders/route.ts. These tests replicate the
// route's promo → pricing → persistence flow WITHOUT a DB, then assert the Money
// Contract invariants the route relies on (and the drift-guard equality that fails
// closed to 500 when violated). Also covers salePayloadHasDiscount classification of
// a pure line-promo bill, which the KRS discount-write gate depends on.
// ---------------------------------------------------------------------------

function satang(satangValue: number): string {
  return (satangValue / 100).toFixed(2);
}

/**
 * Replicate the route's server-authoritative recompute EXACTLY (route.ts:645-712):
 *   applyPromotions → build requestedLines with combinedLineDiscountSatang →
 *   computeOrderTotals(products, requestedLines, application.combinedBill).
 * Then assert every Money Contract invariant + the route's drift-guard equality.
 */
function runCheckoutRecompute(
  products: OrderProductRow[],
  items: Array<{
    productId: string;
    quantity: number;
    lineDiscountSatang?: number;
  }>,
  promotions: ActivePromotion[],
  discount: { type: "amount" | "percent"; value: number }
) {
  const priceById = new Map(
    products.map((p) => [
      p.id,
      Math.round(Number(typeof p.price === "object" ? p.price.toString() : p.price) * 100),
    ])
  );
  const promoLines = items.map((i) => ({
    productId: i.productId,
    priceSatang: priceById.get(i.productId) ?? 0,
    quantity: i.quantity,
    manualLineDiscountSatang: i.lineDiscountSatang,
  }));
  const application = applyPromotions(promoLines, promotions, discount);

  const requestedLines: OrderRequestLine[] = items.map((i, idx) => ({
    productId: i.productId,
    quantity: i.quantity,
    lineDiscountSatang: application.lines[idx].combinedLineDiscountSatang,
  }));
  const totals = computeOrderTotals(products, requestedLines, application.combinedBill);

  // --- Route drift-guard equality (route.ts:687-691) — MUST pass for a real sale. ---
  expect(totals.subtotalSatang).toBe(application.subtotalSatang);
  expect(totals.billDiscountSatang).toBe(
    application.promoBillDiscountSatang + application.manualBillDiscountSatang
  );

  // --- Invariant 1: subtotal − discount === total (satang-exact). ---
  expect(totals.subtotalSatang - totals.billDiscountSatang).toBe(totals.totalSatang);

  // --- Invariant 2: Σ lineTotal === subtotal; per-line never negative; combined ≤ gross. ---
  const sumLineTotal = totals.lines.reduce((s, l) => s + l.lineTotalSatang, 0);
  expect(sumLineTotal).toBe(totals.subtotalSatang);
  for (let i = 0; i < totals.lines.length; i++) {
    const l = totals.lines[i];
    const gross = l.priceSatang * l.quantity;
    const promo = application.lines[i].promoDiscountSatang;
    const combined = l.lineDiscountSatang; // manual + promo, clamped to gross
    expect(l.lineTotalSatang).toBeGreaterThanOrEqual(0);
    expect(promo).toBeGreaterThanOrEqual(0);
    expect(combined).toBeLessThanOrEqual(gross); // promo + manual ≤ unitPrice×qty
    expect(promo).toBeLessThanOrEqual(combined); // manual portion (combined−promo) ≥ 0
  }

  // --- Invariant 3: promoBillDiscount ≤ discount ≤ subtotal. ---
  expect(application.promoBillDiscountSatang).toBeLessThanOrEqual(totals.billDiscountSatang);
  expect(totals.billDiscountSatang).toBeLessThanOrEqual(totals.subtotalSatang);

  // --- Invariant 8: Σ lineNet === total (KRS net-out wire amount per line). ---
  const sumLineNet = totals.lines.reduce((s, l) => s + l.lineNetSatang, 0);
  expect(sumLineNet).toBe(totals.totalSatang);

  return { application, totals };
}

/** Build a full, valid SalePayload from a checkout recompute (mirrors route.ts:909-960). */
function buildSalePayload(
  application: ReturnType<typeof applyPromotions>,
  totals: ReturnType<typeof computeOrderTotals>
): SalePayload {
  const items: SalePayloadItem[] = totals.lines.map((l, i) => ({
    itemCode: `SKU-${i}`,
    description: `item ${i}`,
    quantity: l.quantity,
    unitPrice: satang(l.priceSatang),
    lineTotal: satang(l.lineTotalSatang),
    lineDiscount: satang(l.lineDiscountSatang),
    lineNet: satang(l.lineNetSatang),
    linePromoDiscount: satang(application.lines[i].promoDiscountSatang),
    promotionName: application.lines[i].promo?.promotionName ?? null,
  }));
  return {
    orderNumber: "POS-20260714-0001",
    createdAt: new Date().toISOString(),
    paymentType: "CASH",
    total: satang(totals.totalSatang),
    subtotal: satang(totals.subtotalSatang),
    tax: satang(totals.vatSatang),
    discount: satang(totals.billDiscountSatang),
    promoBillDiscount: satang(application.promoBillDiscountSatang),
    billPromotionName: application.billPromo?.promotionName ?? null,
    amountPaid: satang(totals.totalSatang),
    cashierId: "c1",
    cashierName: "Cashier",
    customerId: null,
    customerCode: null,
    customerName: null,
    customerAddress: null,
    branchCode: "00000",
    branchName: "HQ",
    warehouseCode: "WH01",
    items,
  };
}

function productPercent(id: string, percentOff: number, productIds: string[]): ActivePromotion {
  return { id, name: id, type: "PRODUCT_DISCOUNT", percentOff, productIds };
}
function thresholdPercent(id: string, percentOff: number, minSubtotalSatang: number): ActivePromotion {
  return { id, name: id, type: "BILL_THRESHOLD", percentOff, minSubtotalSatang };
}

// ---------------------------------------------------------------------------
// Invariant 10 — rounding: percent promo + manual-bill-percent at odd prices
// cannot produce Σ drift. The route's drift guard must PASS (not 500) for these.
// ---------------------------------------------------------------------------

describe("checkout recompute — combined line-promo % + manual-bill % at odd prices", () => {
  it("฿33.33 × 3, 12.5% product promo, 15% manual bill — satang-exact, no drift", () => {
    const { application, totals } = runCheckoutRecompute(
      [{ id: "a", price: "33.33" }],
      [{ productId: "a", quantity: 3 }],
      [productPercent("pa", 12.5, ["a"])],
      { type: "percent", value: 15 }
    );
    // gross 9999; 12.5% → round(1249.875)=1250 line promo; subtotal 8749;
    // 15% manual bill on 8749 → round(1312.35)=1312; total 7437.
    expect(totals.subtotalSatang).toBe(8749);
    expect(application.lines[0].promoDiscountSatang).toBe(1250);
    expect(totals.billDiscountSatang).toBe(1312);
    expect(totals.totalSatang).toBe(7437);
    expect(application.promoBillDiscountSatang).toBe(0); // manual-only bill discount
  });

  it("multi-line odd prices with a line promo + threshold promo + manual bill %", () => {
    // Two odd-priced lines force the largest-remainder bill allocation to split a
    // leftover satang; combined with a line promo and a threshold promo this is the
    // worst case for Σ drift. All invariants are asserted inside runCheckoutRecompute.
    const { application, totals } = runCheckoutRecompute(
      [
        { id: "a", price: "33.33" },
        { id: "b", price: "12.34" },
      ],
      [
        { productId: "a", quantity: 3 },
        { productId: "b", quantity: 7, lineDiscountSatang: 111 },
      ],
      [productPercent("pa", 12.5, ["a"]), thresholdPercent("tb", 10, 5000)],
      { type: "percent", value: 7.5 }
    );
    // The exact numbers are asserted by the invariant checks; here we only confirm a
    // discount really was applied (guards against a vacuous all-zero pass).
    expect(totals.billDiscountSatang).toBeGreaterThan(0);
    expect(application.lines[0].promoDiscountSatang).toBeGreaterThan(0);
    expect(application.promoBillDiscountSatang).toBeGreaterThan(0);
  });

  it("BUY_X_GET_Y can NEVER zero a full bill — the 'buy' units are always paid", () => {
    // buy1-get1-free across qty 2 → floor(2/2)=1 free unit = 5000 discount, NOT the
    // full 10000 gross. Half the bill is still owed. This is why invariant 9's
    // literal 'BXGY 100% → total 0' is unreachable via BUY_X_GET_Y alone.
    const { application, totals } = runCheckoutRecompute(
      [{ id: "a", price: "50.00" }],
      [{ productId: "a", quantity: 2 }],
      [{ id: "g", name: "g", type: "BUY_X_GET_Y", buyQty: 1, getQty: 1, getDiscountPercent: 100, productIds: ["a"] }],
      { type: "amount", value: 0 }
    );
    expect(application.lines[0].promoDiscountSatang).toBe(5000);
    expect(totals.subtotalSatang).toBe(5000);
    expect(totals.totalSatang).toBe(5000); // still payable — half free, half owed
  });

  it("a 100% PRODUCT_DISCOUNT zeroes a full single-line bill (the real free-item edge)", () => {
    // total 0 IS reachable via a 100% line promo (or FIXED_PRICE 0, or 100% threshold).
    const { application, totals } = runCheckoutRecompute(
      [{ id: "a", price: "50.00" }],
      [{ productId: "a", quantity: 2 }],
      [productPercent("full", 100, ["a"])],
      { type: "amount", value: 0 }
    );
    expect(application.lines[0].promoDiscountSatang).toBe(10000);
    expect(totals.subtotalSatang).toBe(0);
    expect(totals.totalSatang).toBe(0);
    // NOTE: the route BLOCKS this at checkout — every payment line must be > 0 satang
    // (route.ts:503-512) and amountPaid must === total (0) (PAYMENT_MISMATCH,
    // route.ts:720-728), so a total-0 sale can never be persisted. The writeback's
    // `total > 0` assert is therefore never reached.
  });
});

// ---------------------------------------------------------------------------
// Invariant 8 — salePayloadHasDiscount must catch EVERY promo case, including a
// pure line-promo bill where discount="0.00" AND promoBillDiscount="0.00" but the
// only signal is unitPrice×qty ≠ lineTotal. This gates the KRS discount-safe write.
// ---------------------------------------------------------------------------

describe("salePayloadHasDiscount — promo classification", () => {
  it("TRUE for a pure line-promo bill (discount 0.00, promoBillDiscount 0.00, folded lineTotal)", () => {
    const { application, totals } = runCheckoutRecompute(
      [{ id: "a", price: "59.00" }],
      [{ productId: "a", quantity: 2 }],
      [productPercent("pa", 10, ["a"])],
      { type: "amount", value: 0 }
    );
    const payload = buildSalePayload(application, totals);
    // The critical shape: NO bill discount anywhere, discount signal is line-only.
    expect(payload.discount).toBe("0.00");
    expect(payload.promoBillDiscount).toBe("0.00");
    expect(payload.items[0].unitPrice).toBe("59.00");
    expect(payload.items[0].lineTotal).not.toBe("118.00"); // gross ≠ lineTotal
    expect(salePayloadHasDiscount(payload)).toBe(true);
  });

  it("TRUE for a bill-only threshold-promo case", () => {
    const { application, totals } = runCheckoutRecompute(
      [{ id: "a", price: "100.00" }],
      [{ productId: "a", quantity: 1 }],
      [thresholdPercent("t", 10, 5000)],
      { type: "amount", value: 0 }
    );
    const payload = buildSalePayload(application, totals);
    expect(payload.promoBillDiscount).not.toBe("0.00");
    expect(salePayloadHasDiscount(payload)).toBe(true);
  });

  it("FALSE for a truly discount-free bill (no promo, no manual, gross === lineTotal)", () => {
    const { application, totals } = runCheckoutRecompute(
      [{ id: "a", price: "59.00" }],
      [{ productId: "a", quantity: 2 }],
      [],
      { type: "amount", value: 0 }
    );
    const payload = buildSalePayload(application, totals);
    expect(payload.discount).toBe("0.00");
    expect(payload.promoBillDiscount).toBe("0.00");
    expect(payload.items[0].lineTotal).toBe("118.00");
    expect(salePayloadHasDiscount(payload)).toBe(false);
  });
});

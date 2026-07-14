import { describe, it, expect } from "vitest";
import {
  applyPromotions,
  linePromoCandidateSatang,
  type ActivePromotion,
  type PromoCartLine,
} from "@/lib/promotionEngine";
import {
  computeTotals,
  computeOrderTotals,
  bahtToSatang,
  type BillDiscount,
  type PricingItem,
  type OrderProductRow,
  type OrderRequestLine,
} from "@/lib/pricing";

// ---------------------------------------------------------------------------
// Promotion engine — golden tables + properties. Everything is satang-exact and
// clock-free (time/isActive filtering happens at the fetch boundary, not here).
// The critical test is the parity property (§7): applyPromotions feeds ./pricing
// unchanged, so the engine subtotal and the pricing subtotal must match exactly,
// on both the client (computeTotals) and server (computeOrderTotals) paths.
// ---------------------------------------------------------------------------

// --- small factories to keep the golden tables readable -------------------

function productPercent(
  id: string,
  percentOff: number,
  productIds: string[]
): ActivePromotion {
  return { id, name: id, type: "PRODUCT_DISCOUNT", percentOff, productIds };
}
function productAmount(
  id: string,
  amountOffSatang: number,
  productIds: string[]
): ActivePromotion {
  return { id, name: id, type: "PRODUCT_DISCOUNT", amountOffSatang, productIds };
}
function fixedPrice(
  id: string,
  fixedPriceSatang: number,
  productIds: string[]
): ActivePromotion {
  return { id, name: id, type: "FIXED_PRICE", fixedPriceSatang, productIds };
}
function buyXGetY(
  id: string,
  buyQty: number,
  getQty: number,
  getDiscountPercent: number,
  productIds: string[]
): ActivePromotion {
  return {
    id,
    name: id,
    type: "BUY_X_GET_Y",
    buyQty,
    getQty,
    getDiscountPercent,
    productIds,
  };
}
function thresholdAmount(
  id: string,
  amountOffSatang: number,
  minSubtotalSatang: number
): ActivePromotion {
  return { id, name: id, type: "BILL_THRESHOLD", amountOffSatang, minSubtotalSatang };
}
function thresholdPercent(
  id: string,
  percentOff: number,
  minSubtotalSatang: number
): ActivePromotion {
  return { id, name: id, type: "BILL_THRESHOLD", percentOff, minSubtotalSatang };
}

const NO_BILL: BillDiscount = { type: "amount", value: 0 };

// A single-line cart helper (product "a" unless overridden).
function cart(
  priceSatang: number,
  quantity: number,
  extra: Partial<PromoCartLine> = {}
): PromoCartLine[] {
  return [{ productId: "a", priceSatang, quantity, ...extra }];
}

// ---------------------------------------------------------------------------
// §1 PRODUCT_DISCOUNT
// ---------------------------------------------------------------------------

describe("linePromoCandidateSatang — PRODUCT_DISCOUNT", () => {
  it("percent off the line gross (one line-level rounding)", () => {
    // gross 11800, 10% → 1180
    expect(
      linePromoCandidateSatang(productPercent("x", 10, ["a"]), 5900, 2)
    ).toBe(1180);
  });

  it("supports a 2dp percent like 12.5% with half-up rounding", () => {
    // gross 3333, 12.5% → 416.625 → 417 (half-up, once at line level)
    expect(
      linePromoCandidateSatang(productPercent("x", 12.5, ["a"]), 3333, 1)
    ).toBe(417);
  });

  it("amount is per UNIT × qty", () => {
    // 5 baht/unit (500 satang) × 3 = 1500, gross 6000
    expect(
      linePromoCandidateSatang(productAmount("x", 500, ["a"]), 2000, 3)
    ).toBe(1500);
  });

  it("clamps an amount that exceeds the line gross", () => {
    // 50 baht/unit × 1 = 5000, but gross is 3000 → clamp to 3000
    expect(
      linePromoCandidateSatang(productAmount("x", 5000, ["a"]), 3000, 1)
    ).toBe(3000);
  });
});

describe("applyPromotions — PRODUCT_DISCOUNT scoping", () => {
  it("does NOT apply a promo not scoped to the line's product", () => {
    const app = applyPromotions(
      cart(5900, 2),
      [productPercent("x", 10, ["other"])],
      NO_BILL
    );
    expect(app.lines[0].promo).toBeNull();
    expect(app.lines[0].promoDiscountSatang).toBe(0);
    expect(app.subtotalSatang).toBe(11800);
  });

  it("applies a scoped promo and reports the snapshot", () => {
    const app = applyPromotions(
      cart(5900, 2),
      [productPercent("x", 10, ["a"])],
      NO_BILL
    );
    expect(app.lines[0].promo).toEqual({
      promotionId: "x",
      promotionName: "x",
      discountSatang: 1180,
    });
    expect(app.lines[0].combinedLineDiscountSatang).toBe(1180);
    expect(app.subtotalSatang).toBe(11800 - 1180);
  });
});

// ---------------------------------------------------------------------------
// §2 FIXED_PRICE
// ---------------------------------------------------------------------------

describe("linePromoCandidateSatang — FIXED_PRICE", () => {
  it("charges the fixed price per unit (never markup)", () => {
    // price 100, fixed 80 → 20/unit × 2 = 4000
    expect(
      linePromoCandidateSatang(fixedPrice("x", 8000, ["a"]), 10000, 2)
    ).toBe(4000);
  });

  it("yields 0 when the fixed price equals the catalog price", () => {
    expect(
      linePromoCandidateSatang(fixedPrice("x", 10000, ["a"]), 10000, 1)
    ).toBe(0);
  });

  it("yields 0 when the fixed price is above catalog (KRS price drop) — never markup", () => {
    expect(
      linePromoCandidateSatang(fixedPrice("x", 12000, ["a"]), 10000, 3)
    ).toBe(0);
    // and it is therefore not applied by applyPromotions
    const app = applyPromotions(cart(10000, 3), [fixedPrice("x", 12000, ["a"])], NO_BILL);
    expect(app.lines[0].promo).toBeNull();
    expect(app.subtotalSatang).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// §3 BUY_X_GET_Y (same product only)
// ---------------------------------------------------------------------------

describe("linePromoCandidateSatang — BUY_X_GET_Y", () => {
  it("buy-2-get-1-free: free units follow floor(qty / 3)", () => {
    const promo = buyXGetY("x", 2, 1, 100, ["a"]);
    const price = 5000;
    const cases: Array<[number, number]> = [
      [1, 0],
      [2, 0],
      [3, 1],
      [5, 1],
      [6, 2],
      [7, 2],
    ];
    for (const [qty, freeUnits] of cases) {
      expect(linePromoCandidateSatang(promo, price, qty)).toBe(freeUnits * price);
    }
  });

  it('"ชิ้นที่ 2 ลด 50%" = buy1 get1 @ 50% across qty 1..4', () => {
    const promo = buyXGetY("x", 1, 1, 50, ["a"]);
    const price = 4000;
    expect(linePromoCandidateSatang(promo, price, 1)).toBe(0); // 0 free
    expect(linePromoCandidateSatang(promo, price, 2)).toBe(2000); // 1 free × 50%
    expect(linePromoCandidateSatang(promo, price, 3)).toBe(2000); // 1 free
    expect(linePromoCandidateSatang(promo, price, 4)).toBe(4000); // 2 free × 50%
  });

  it("100% is exact (no rounding) even on an odd price", () => {
    // buy1 get1 free, price 33.33 (3333 satang), qty 2 → 1 free → 3333 exact
    expect(
      linePromoCandidateSatang(buyXGetY("x", 1, 1, 100, ["a"]), 3333, 2)
    ).toBe(3333);
  });

  it("rounds a partial-percent free unit half-up on an odd price", () => {
    // 50% of a 3333-satang free unit = 1666.5 → 1667 half-up
    expect(
      linePromoCandidateSatang(buyXGetY("x", 1, 1, 50, ["a"]), 3333, 2)
    ).toBe(1667);
  });
});

// ---------------------------------------------------------------------------
// §4 BILL_THRESHOLD
// ---------------------------------------------------------------------------

describe("applyPromotions — BILL_THRESHOLD", () => {
  it("applies when subtotal == min", () => {
    const app = applyPromotions(cart(10000, 1), [thresholdAmount("t", 1000, 10000)], NO_BILL);
    expect(app.promoBillDiscountSatang).toBe(1000);
    expect(app.billPromo).toEqual({ promotionId: "t", promotionName: "t", discountSatang: 1000 });
  });

  it("does NOT apply at min − 1 satang", () => {
    const app = applyPromotions(cart(9999, 1), [thresholdAmount("t", 1000, 10000)], NO_BILL);
    expect(app.promoBillDiscountSatang).toBe(0);
    expect(app.billPromo).toBeNull();
  });

  it("percent mode is a percentage of the subtotal", () => {
    const app = applyPromotions(cart(20000, 1), [thresholdPercent("t", 10, 10000)], NO_BILL);
    expect(app.promoBillDiscountSatang).toBe(2000);
  });

  it("clamps an amount discount larger than the subtotal", () => {
    const app = applyPromotions(cart(5000, 1), [thresholdAmount("t", 999999, 1000)], NO_BILL);
    expect(app.promoBillDiscountSatang).toBe(5000);
  });

  it("a manual line discount can push the subtotal below the threshold (eligibility shifts)", () => {
    // gross 10000, manual line 100 → subtotal 9900 < 10000 → threshold no longer applies
    const app = applyPromotions(
      cart(10000, 1, { manualLineDiscountSatang: 100 }),
      [thresholdAmount("t", 1000, 10000)],
      NO_BILL
    );
    expect(app.subtotalSatang).toBe(9900);
    expect(app.promoBillDiscountSatang).toBe(0);
    // same cart without the manual line discount would qualify
    const app2 = applyPromotions(cart(10000, 1), [thresholdAmount("t", 1000, 10000)], NO_BILL);
    expect(app2.promoBillDiscountSatang).toBe(1000);
  });

  it("picks the larger of two eligible thresholds", () => {
    const app = applyPromotions(
      cart(10000, 1),
      [thresholdAmount("t1", 1000, 5000), thresholdAmount("t2", 1500, 5000)],
      NO_BILL
    );
    expect(app.promoBillDiscountSatang).toBe(1500);
    expect(app.billPromo?.promotionId).toBe("t2");
  });

  it("breaks a threshold tie by the smaller id", () => {
    const app = applyPromotions(
      cart(10000, 1),
      [thresholdAmount("t-b", 1000, 5000), thresholdAmount("t-a", 1000, 5000)],
      NO_BILL
    );
    expect(app.billPromo?.promotionId).toBe("t-a");
  });
});

// ---------------------------------------------------------------------------
// §5 Best-per-line selection + tie-break + order-independence
// ---------------------------------------------------------------------------

describe("applyPromotions — best-per-line & determinism", () => {
  it("largest line discount wins", () => {
    const app = applyPromotions(
      cart(10000, 1),
      [productPercent("p10", 10, ["a"]), productPercent("p25", 25, ["a"])],
      NO_BILL
    );
    expect(app.lines[0].promoDiscountSatang).toBe(2500);
    expect(app.lines[0].promo?.promotionId).toBe("p25");
  });

  it("breaks a line-promo tie by the smaller id", () => {
    const app = applyPromotions(
      cart(10000, 1),
      [productPercent("p-b", 10, ["a"]), productPercent("p-a", 10, ["a"])],
      NO_BILL
    );
    expect(app.lines[0].promo?.promotionId).toBe("p-a");
  });

  it("is independent of the input promotions order", () => {
    const promos = [
      productPercent("p-b", 10, ["a"]),
      productPercent("p-a", 10, ["a"]),
      thresholdAmount("t-b", 1000, 5000),
      thresholdAmount("t-a", 1000, 5000),
    ];
    const forward = applyPromotions(cart(10000, 2), promos, NO_BILL);
    const reversed = applyPromotions(cart(10000, 2), [...promos].reverse(), NO_BILL);
    expect(reversed).toEqual(forward);
  });
});

// ---------------------------------------------------------------------------
// §6 Stacking (promo + manual line/bill discounts)
// ---------------------------------------------------------------------------

describe("applyPromotions — stacking with manual discounts", () => {
  it("clamps promo + manual line discount at the line gross", () => {
    // gross 5000, promo amount 40/unit (4000) + manual 2000 = 6000 → clamp to 5000
    const app = applyPromotions(
      cart(5000, 1, { manualLineDiscountSatang: 2000 }),
      [productAmount("x", 4000, ["a"])],
      NO_BILL
    );
    expect(app.lines[0].promoDiscountSatang).toBe(4000);
    expect(app.lines[0].combinedLineDiscountSatang).toBe(5000);
    expect(app.subtotalSatang).toBe(0);
  });

  it("computes a manual bill percent on the post-line-promo subtotal", () => {
    // price 100 × 1, PRODUCT_DISCOUNT 50% → line promo 5000 → subtotal 5000
    // manual bill 10% → 500 satang on the reduced subtotal
    const app = applyPromotions(
      cart(10000, 1),
      [productPercent("x", 50, ["a"])],
      { type: "percent", value: 10 }
    );
    expect(app.subtotalSatang).toBe(5000);
    expect(app.manualBillDiscountSatang).toBe(500);
    expect(app.combinedBill).toEqual({ type: "amount", value: 5 });
  });

  it("clamps the manual bill to (subtotal − promoBill)", () => {
    // subtotal 10000, threshold promo bill 1000, manual bill 999.99 baht → clamp to 9000
    const app = applyPromotions(
      cart(10000, 1),
      [thresholdAmount("t", 1000, 5000)],
      { type: "amount", value: 99999 }
    );
    expect(app.promoBillDiscountSatang).toBe(1000);
    expect(app.manualBillDiscountSatang).toBe(9000);
    expect(app.combinedBill).toEqual({ type: "amount", value: 100 });
  });
});

// ---------------------------------------------------------------------------
// §7 Parity property — the critical one. applyPromotions must feed ./pricing so
// that the engine subtotal equals both computeTotals (client) and
// computeOrderTotals (server), the bill discount equals promoBill + manualBill,
// and Σ lineNet === total on both paths.
// ---------------------------------------------------------------------------

/** satang → a fixed 2dp baht string so bahtToSatang round-trips exactly. */
function toBaht(satang: number): string {
  return (satang / 100).toFixed(2);
}

function assertParity(
  lines: PromoCartLine[],
  promotions: ActivePromotion[],
  manualBill: BillDiscount
) {
  const app = applyPromotions(lines, promotions, manualBill);
  const billTarget = app.promoBillDiscountSatang + app.manualBillDiscountSatang;

  // Client path: computeTotals with the engine's combined line + bill discounts.
  const pricingItems: PricingItem[] = lines.map((l, i) => ({
    priceSatang: l.priceSatang,
    qty: l.quantity,
    lineDiscountSatang: app.lines[i].combinedLineDiscountSatang,
  }));
  const client = computeTotals(pricingItems, app.combinedBill);

  // Server path: computeOrderTotals from DB-shaped product rows + requested lines.
  const products: OrderProductRow[] = Array.from(
    new Map(lines.map((l) => [l.productId, { id: l.productId, price: toBaht(l.priceSatang) }])).values()
  );
  const requested: OrderRequestLine[] = lines.map((l, i) => ({
    productId: l.productId,
    quantity: l.quantity,
    lineDiscountSatang: app.lines[i].combinedLineDiscountSatang,
  }));
  const server = computeOrderTotals(products, requested, app.combinedBill);

  // subtotal parity (engine === client === server)
  expect(app.subtotalSatang).toBe(client.subtotalSatang);
  expect(app.subtotalSatang).toBe(server.subtotalSatang);

  // invariant: subtotal − billDiscount === total, on both paths
  expect(client.subtotalSatang - client.billDiscountSatang).toBe(client.totalSatang);
  expect(server.subtotalSatang - server.billDiscountSatang).toBe(server.totalSatang);

  // billDiscount === promoBill + manualBill (round-trip via combinedBill is exact)
  expect(client.billDiscountSatang).toBe(billTarget);
  expect(server.billDiscountSatang).toBe(billTarget);

  // Σ lineNet === total, on both paths
  const clientNet = client.lines.reduce((s, l) => s + l.netSatang, 0);
  const serverNet = server.lines.reduce((s, l) => s + l.lineNetSatang, 0);
  expect(clientNet).toBe(client.totalSatang);
  expect(serverNet).toBe(server.totalSatang);
}

describe("applyPromotions — client/server parity property", () => {
  // Carts use product ids a/b/c with odd satang prices (55.50, 33.33, 100.00, …).
  const carts: PromoCartLine[][] = [
    [{ productId: "a", priceSatang: 5550, quantity: 1 }],
    [
      { productId: "a", priceSatang: 5550, quantity: 2 },
      { productId: "b", priceSatang: 3333, quantity: 3 },
    ],
    [
      { productId: "a", priceSatang: 12345, quantity: 1 },
      { productId: "b", priceSatang: 5000, quantity: 2 },
      { productId: "c", priceSatang: 9999, quantity: 1 },
    ],
    [
      { productId: "a", priceSatang: 5550, quantity: 3 },
      { productId: "b", priceSatang: 3333, quantity: 7 },
      { productId: "c", priceSatang: 10000, quantity: 1 },
    ],
    // carts carrying manual per-line discounts (exercise step 2 in parity)
    [
      { productId: "a", priceSatang: 5550, quantity: 2, manualLineDiscountSatang: 300 },
      { productId: "b", priceSatang: 3333, quantity: 4, manualLineDiscountSatang: 1000 },
    ],
  ];

  const promoSets: ActivePromotion[][] = [
    [],
    [productPercent("pa", 12.5, ["a"])],
    [productAmount("pb", 500, ["b"])],
    [fixedPrice("fa", 5000, ["a"])],
    [buyXGetY("gb", 2, 1, 100, ["b"])],
    [thresholdAmount("t-amt", 1500, 5000)],
    [thresholdPercent("t-pct", 10, 5000)],
    [productPercent("pa", 12.5, ["a"]), thresholdAmount("t-amt", 1500, 5000)],
    [
      productAmount("pb", 500, ["b"]),
      buyXGetY("gb", 2, 1, 100, ["b"]),
      thresholdPercent("t-pct", 10, 5000),
    ],
  ];

  const manualBills: BillDiscount[] = [
    { type: "amount", value: 0 },
    { type: "amount", value: 20 },
    { type: "percent", value: 15 },
    { type: "amount", value: 99999 },
  ];

  it("engine subtotal == pricing subtotal and the money invariants hold across the matrix", () => {
    for (const c of carts) {
      for (const promos of promoSets) {
        for (const mb of manualBills) {
          assertParity(c, promos, mb);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §8 Degenerate / defensive inputs — no crash, zero discounts.
// ---------------------------------------------------------------------------

describe("applyPromotions — degenerate inputs", () => {
  it("empty cart → no lines, zero everything", () => {
    const app = applyPromotions([], [productPercent("x", 10, ["a"])], NO_BILL);
    expect(app.lines).toEqual([]);
    expect(app.subtotalSatang).toBe(0);
    expect(app.billPromo).toBeNull();
    expect(app.promoBillDiscountSatang).toBe(0);
    expect(app.manualBillDiscountSatang).toBe(0);
    expect(app.combinedBill).toEqual({ type: "amount", value: 0 });
  });

  it("empty promotions → every line promo is null", () => {
    const app = applyPromotions(
      [
        { productId: "a", priceSatang: 5000, quantity: 2 },
        { productId: "b", priceSatang: 2500, quantity: 1 },
      ],
      [],
      NO_BILL
    );
    expect(app.subtotalSatang).toBe(12500);
    for (const l of app.lines) {
      expect(l.promo).toBeNull();
      expect(l.promoDiscountSatang).toBe(0);
    }
  });

  it("a qty-0 line contributes nothing and applies no promo", () => {
    const app = applyPromotions(
      cart(5000, 0),
      [productPercent("x", 50, ["a"])],
      NO_BILL
    );
    expect(app.subtotalSatang).toBe(0);
    expect(app.lines[0].promo).toBeNull();
    expect(app.lines[0].combinedLineDiscountSatang).toBe(0);
  });

  it("malformed promos (missing required fields) yield zero discounts, never a crash", () => {
    const malformed: ActivePromotion[] = [
      { id: "m1", name: "no percent/amount", type: "PRODUCT_DISCOUNT", productIds: ["a"] },
      { id: "m2", name: "no fixed price", type: "FIXED_PRICE", productIds: ["a"] },
      { id: "m3", name: "no buy/get", type: "BUY_X_GET_Y", productIds: ["a"] },
      { id: "m4", name: "no min subtotal", type: "BILL_THRESHOLD", amountOffSatang: 1000 },
    ];
    const app = applyPromotions(cart(5000, 2), malformed, { type: "amount", value: 0 });
    expect(app.lines[0].promo).toBeNull();
    expect(app.lines[0].promoDiscountSatang).toBe(0);
    expect(app.subtotalSatang).toBe(10000);
    expect(app.promoBillDiscountSatang).toBe(0);
    expect(app.billPromo).toBeNull();
  });

  it("treats a non-finite / negative manual bill value as 0", () => {
    const app = applyPromotions(cart(5000, 1), [], {
      type: "amount",
      value: Number.NaN,
    });
    expect(app.manualBillDiscountSatang).toBe(0);
    const app2 = applyPromotions(cart(5000, 1), [], { type: "percent", value: -5 });
    expect(app2.manualBillDiscountSatang).toBe(0);
  });

  it("BILL_THRESHOLD candidate helper returns 0 for a line call and vice versa", () => {
    // a bill promo is not a line candidate
    expect(linePromoCandidateSatang(thresholdAmount("t", 1000, 0), 5000, 1)).toBe(0);
    // a line promo does not become a bill discount
    const app = applyPromotions(cart(5000, 1), [productPercent("x", 10, ["a"])], NO_BILL);
    expect(app.promoBillDiscountSatang).toBe(0);
  });
});

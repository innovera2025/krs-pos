import { describe, it, expect } from "vitest";
import {
  computeTotals,
  computeOrderTotals,
  bahtToSatang,
  sumPaySatang,
  remainingPaySatang,
  OrderProductMissingError,
  type PricingItem,
  type OrderProductRow,
  type OrderRequestLine,
} from "@/lib/pricing";

// ---------------------------------------------------------------------------
// Pin existing behavior: computeTotals / VAT / proportional discount rounding.
// These lock the CURRENT correct behavior so the Sub-phase A additions cannot
// regress the cart engine the client already relies on.
// ---------------------------------------------------------------------------

describe("bahtToSatang", () => {
  it("converts a number to integer satang", () => {
    expect(bahtToSatang(59)).toBe(5900);
    expect(bahtToSatang(0.07)).toBe(7);
  });
  it("converts a numeric string and strips thousands separators", () => {
    expect(bahtToSatang("1,250.00")).toBe(125000);
    expect(bahtToSatang(" 59.00 ")).toBe(5900);
  });
  it("returns 0 for non-finite/blank input", () => {
    expect(bahtToSatang("")).toBe(0);
    expect(bahtToSatang("abc")).toBe(0);
    expect(bahtToSatang(Number.NaN)).toBe(0);
  });
  it("rounds half-up at the satang boundary", () => {
    expect(bahtToSatang(0.005)).toBe(1); // 0.5 satang rounds to 1
  });
});

describe("computeTotals — no discount", () => {
  it("subtotal = Σ line gross; total = subtotal; invariant holds", () => {
    const items: PricingItem[] = [
      { priceSatang: 5900, qty: 2 }, // 118.00
      { priceSatang: 2500, qty: 1 }, // 25.00
    ];
    const t = computeTotals(items, { type: "amount", value: 0 });
    expect(t.subtotalSatang).toBe(14300);
    expect(t.billDiscountSatang).toBe(0);
    expect(t.totalSatang).toBe(14300);
    expect(t.subtotalSatang - t.billDiscountSatang).toBe(t.totalSatang);
  });

  it("extracts inclusive 7% VAT as amount*7/107", () => {
    // 107.00 baht inclusive → VAT = 10700 * 7 / 107 = 700 satang exactly.
    const t = computeTotals([{ priceSatang: 10700, qty: 1 }], {
      type: "amount",
      value: 0,
    });
    expect(t.vatSatang).toBe(700);
  });
});

describe("computeTotals — per-line discount", () => {
  it("subtracts the per-line discount from the line gross, floored at 0", () => {
    const t = computeTotals(
      [{ priceSatang: 5900, qty: 2, lineDiscountSatang: 1000 }],
      { type: "amount", value: 0 }
    );
    // gross 11800 - 1000 = 10800
    expect(t.subtotalSatang).toBe(10800);
    expect(t.totalSatang).toBe(10800);
  });
  it("never lets a per-line discount push a line below 0", () => {
    const t = computeTotals(
      [{ priceSatang: 5900, qty: 1, lineDiscountSatang: 999999 }],
      { type: "amount", value: 0 }
    );
    expect(t.subtotalSatang).toBe(0);
  });
});

describe("computeTotals — bill discount (amount)", () => {
  it("applies a flat baht discount and keeps the invariant", () => {
    const t = computeTotals(
      [
        { priceSatang: 10000, qty: 1 },
        { priceSatang: 5000, qty: 1 },
      ],
      { type: "amount", value: 30 } // 3000 satang
    );
    expect(t.subtotalSatang).toBe(15000);
    expect(t.billDiscountSatang).toBe(3000);
    expect(t.totalSatang).toBe(12000);
  });
  it("clamps an over-large amount discount to the subtotal (total = 0)", () => {
    const t = computeTotals([{ priceSatang: 5000, qty: 1 }], {
      type: "amount",
      value: 9999,
    });
    expect(t.billDiscountSatang).toBe(5000);
    expect(t.totalSatang).toBe(0);
  });
});

describe("computeTotals — bill discount (percent)", () => {
  it("applies a percentage of the subtotal", () => {
    const t = computeTotals([{ priceSatang: 10000, qty: 1 }], {
      type: "percent",
      value: 10,
    });
    expect(t.billDiscountSatang).toBe(1000);
    expect(t.totalSatang).toBe(9000);
  });
  it("clamps percent to [0,100]", () => {
    const t = computeTotals([{ priceSatang: 10000, qty: 1 }], {
      type: "percent",
      value: 150,
    });
    expect(t.billDiscountSatang).toBe(10000);
    expect(t.totalSatang).toBe(0);
  });
});

describe("computeTotals — proportional allocation invariants", () => {
  it("Σ alloc === billDiscount; per-line VAT sums coherently (remainder to largest)", () => {
    // Three uneven lines + an odd discount that forces rounding remainder.
    const items: PricingItem[] = [
      { priceSatang: 3333, qty: 1 },
      { priceSatang: 3333, qty: 1 },
      { priceSatang: 3334, qty: 1 },
    ];
    const t = computeTotals(items, { type: "amount", value: 10 }); // 1000 satang
    expect(t.subtotalSatang).toBe(10000);
    expect(t.billDiscountSatang).toBe(1000);
    expect(t.totalSatang).toBe(9000);
    // The proportional allocation must reduce the per-line nets so they sum to
    // total, and VAT is extracted from those reduced nets.
    const sumLineNets = t.lines.reduce((s, l) => s + l.netSatang, 0);
    expect(sumLineNets).toBe(9000);
    // VAT of the whole bill ≈ total * 7 / 107 (within 1 satang of the per-line sum).
    const billVat = Math.round((9000 * 7) / 107);
    expect(Math.abs(t.vatSatang - billVat)).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// FIX 2 — largest-remainder allocation regression. The OLD "push remainder onto
// the largest line then clamp(...,0,net)" broke Σ alloc === billDiscount for
// N EQUAL-net lines + a small-satang bill discount: the negative remainder
// exceeded the largest line's rounded share, the clamp snapped it to 0, and the
// discount under-allocated → extracted VAT overstated by 1-3 satang. These pin
// the previously-FAILING cases: 5×500+3sat, 8×500+4sat, 4×500+2sat.
// ---------------------------------------------------------------------------

describe("computeTotals — FIX 2 equal-net small-discount allocation", () => {
  // Reconstruct the per-line bill-discount allocation from the engine output:
  // alloc[i] = lineNet[i] - lineFinal[i]. (lineNet here = price*qty since there is
  // no per-line discount in these cases.)
  function allocFor(
    nLines: number,
    perLineSatang: number,
    discountSatang: number
  ) {
    const items: PricingItem[] = Array.from({ length: nLines }, () => ({
      priceSatang: perLineSatang,
      qty: 1,
    }));
    const t = computeTotals(items, {
      type: "amount",
      value: discountSatang / 100, // baht
    });
    const allocs = t.lines.map((l) => perLineSatang - l.netSatang);
    const sumAlloc = allocs.reduce((s, a) => s + a, 0);
    const sumLineNet = t.lines.reduce((s, l) => s + l.netSatang, 0);
    const reconciledVat = t.lines.reduce(
      (s, l) => s + Math.round((l.netSatang * 7) / 107),
      0
    );
    return { t, allocs, sumAlloc, sumLineNet, reconciledVat, perLineSatang };
  }

  it("5 lines × 500sat + 3sat discount: Σ alloc === billDiscount exactly", () => {
    const r = allocFor(5, 500, 3);
    expect(r.t.subtotalSatang).toBe(2500);
    expect(r.t.billDiscountSatang).toBe(3);
    expect(r.sumAlloc).toBe(3); // <- the bug made this 0
    expect(r.sumLineNet).toBe(r.t.totalSatang); // 2497
    // every alloc within [0, lineNet]
    r.allocs.forEach((a) => {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(r.perLineSatang);
    });
    // tax reconciles to sum(round(lineNet*7/107))
    expect(r.t.vatSatang).toBe(r.reconciledVat);
  });

  it("8 lines × 500sat + 4sat discount: Σ alloc === billDiscount exactly", () => {
    const r = allocFor(8, 500, 4);
    expect(r.t.subtotalSatang).toBe(4000);
    expect(r.t.billDiscountSatang).toBe(4);
    expect(r.sumAlloc).toBe(4);
    expect(r.sumLineNet).toBe(r.t.totalSatang); // 3996
    r.allocs.forEach((a) => {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(r.perLineSatang);
    });
    expect(r.t.vatSatang).toBe(r.reconciledVat);
  });

  it("4 lines × 500sat + 2sat discount: Σ alloc === billDiscount exactly", () => {
    const r = allocFor(4, 500, 2);
    expect(r.t.subtotalSatang).toBe(2000);
    expect(r.t.billDiscountSatang).toBe(2);
    expect(r.sumAlloc).toBe(2);
    expect(r.sumLineNet).toBe(r.t.totalSatang); // 1998
    r.allocs.forEach((a) => {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(r.perLineSatang);
    });
    expect(r.t.vatSatang).toBe(r.reconciledVat);
  });

  it("property: Σ alloc === billDiscount across many equal-net N/discount combos", () => {
    for (let n = 1; n <= 12; n++) {
      for (let d = 0; d <= n + 3; d++) {
        const items: PricingItem[] = Array.from({ length: n }, () => ({
          priceSatang: 500,
          qty: 1,
        }));
        const t = computeTotals(items, { type: "amount", value: d / 100 });
        const sumAlloc = t.lines.reduce(
          (s, l) => s + (500 - l.netSatang),
          0
        );
        // discount is clamped to subtotal (n*500), but for these small d it equals d.
        expect(sumAlloc).toBe(t.billDiscountSatang);
        expect(t.subtotalSatang - t.billDiscountSatang).toBe(t.totalSatang);
        // every per-line alloc within [0, 500]
        t.lines.forEach((l) => {
          const a = 500 - l.netSatang;
          expect(a).toBeGreaterThanOrEqual(0);
          expect(a).toBeLessThanOrEqual(500);
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// computeOrderTotals — server-authoritative recompute (the new function).
// ---------------------------------------------------------------------------

const PRODUCTS: OrderProductRow[] = [
  { id: "p1", price: "59.00" }, // Decimal-string shape (Prisma wire form)
  { id: "p2", price: 25 }, // number
  { id: "p3", price: { toString: () => "100.00" } }, // Decimal-like object
];

describe("computeOrderTotals — DB price authority", () => {
  it("uses DB product prices (string/number/Decimal-like) — never a client price", () => {
    const req: OrderRequestLine[] = [
      { productId: "p1", quantity: 2 }, // 59 * 2 = 118.00
      { productId: "p2", quantity: 1 }, // 25.00
    ];
    const t = computeOrderTotals(PRODUCTS, req, { type: "amount", value: 0 });
    expect(t.subtotalSatang).toBe(14300);
    expect(t.totalSatang).toBe(14300);
    expect(t.lines).toEqual([
      { productId: "p1", quantity: 2, priceSatang: 5900, lineTotalSatang: 11800 },
      { productId: "p2", quantity: 1, priceSatang: 2500, lineTotalSatang: 2500 },
    ]);
  });

  it("reads a Decimal-like object price via toString()", () => {
    const t = computeOrderTotals(
      PRODUCTS,
      [{ productId: "p3", quantity: 1 }],
      { type: "amount", value: 0 }
    );
    expect(t.lines[0].priceSatang).toBe(10000);
    expect(t.totalSatang).toBe(10000);
  });

  it("Σ lineTotalSatang === subtotalSatang", () => {
    const req: OrderRequestLine[] = [
      { productId: "p1", quantity: 3 },
      { productId: "p3", quantity: 2 },
    ];
    const t = computeOrderTotals(PRODUCTS, req, { type: "percent", value: 10 });
    const sumLines = t.lines.reduce((s, l) => s + l.lineTotalSatang, 0);
    expect(sumLines).toBe(t.subtotalSatang);
  });
});

describe("computeOrderTotals — discount recompute", () => {
  it("applies an amount bill discount in satang", () => {
    const t = computeOrderTotals(
      PRODUCTS,
      [{ productId: "p3", quantity: 1 }],
      { type: "amount", value: 30 }
    );
    expect(t.subtotalSatang).toBe(10000);
    expect(t.billDiscountSatang).toBe(3000);
    expect(t.totalSatang).toBe(7000);
  });

  it("applies a percent bill discount and keeps total >= 0", () => {
    const t = computeOrderTotals(
      PRODUCTS,
      [{ productId: "p3", quantity: 1 }],
      { type: "percent", value: 100 }
    );
    expect(t.billDiscountSatang).toBe(10000);
    expect(t.totalSatang).toBe(0);
  });

  it("honors a per-line discount (ส่วนลดรายการ) and stays consistent", () => {
    const t = computeOrderTotals(
      PRODUCTS,
      [{ productId: "p3", quantity: 2, lineDiscountSatang: 5000 }], // 20000 - 5000
      { type: "amount", value: 0 }
    );
    expect(t.subtotalSatang).toBe(15000);
    expect(t.lines[0].lineTotalSatang).toBe(15000);
  });

  it("clamps a per-line discount to the line gross", () => {
    const t = computeOrderTotals(
      PRODUCTS,
      [{ productId: "p2", quantity: 1, lineDiscountSatang: 999999 }],
      { type: "amount", value: 0 }
    );
    expect(t.subtotalSatang).toBe(0);
    expect(t.lines[0].lineTotalSatang).toBe(0);
  });

  it("matches computeTotals exactly for the same inputs (client/server parity)", () => {
    const req: OrderRequestLine[] = [
      { productId: "p1", quantity: 2, lineDiscountSatang: 300 },
      { productId: "p3", quantity: 1 },
    ];
    const bill = { type: "percent", value: 15 } as const;
    const server = computeOrderTotals(PRODUCTS, req, bill);
    const client = computeTotals(
      [
        { priceSatang: 5900, qty: 2, lineDiscountSatang: 300 },
        { priceSatang: 10000, qty: 1 },
      ],
      bill
    );
    expect(server.subtotalSatang).toBe(client.subtotalSatang);
    expect(server.billDiscountSatang).toBe(client.billDiscountSatang);
    expect(server.totalSatang).toBe(client.totalSatang);
    expect(server.vatSatang).toBe(client.vatSatang);
  });
});

describe("computeOrderTotals — validation & error boundaries", () => {
  it("throws OrderProductMissingError for an unknown productId", () => {
    expect(() =>
      computeOrderTotals(PRODUCTS, [{ productId: "nope", quantity: 1 }], {
        type: "amount",
        value: 0,
      })
    ).toThrow(OrderProductMissingError);
  });

  it("rejects a negative discountValue", () => {
    expect(() =>
      computeOrderTotals(PRODUCTS, [{ productId: "p1", quantity: 1 }], {
        type: "amount",
        value: -1,
      })
    ).toThrow(RangeError);
  });

  it("rejects a percent discountValue > 100", () => {
    expect(() =>
      computeOrderTotals(PRODUCTS, [{ productId: "p1", quantity: 1 }], {
        type: "percent",
        value: 101,
      })
    ).toThrow(RangeError);
  });

  it("rejects a non-finite discountValue", () => {
    expect(() =>
      computeOrderTotals(PRODUCTS, [{ productId: "p1", quantity: 1 }], {
        type: "amount",
        value: Number.NaN,
      })
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Split-payment helpers (already used by the client + server payment-sum check).
// ---------------------------------------------------------------------------

describe("sumPaySatang / remainingPaySatang", () => {
  it("sums payment lines in satang", () => {
    expect(sumPaySatang([50, "59.00", "1,000"])).toBe(110900);
  });
  it("floors remaining at 0", () => {
    expect(remainingPaySatang(10000, [50, 60])).toBe(0);
    expect(remainingPaySatang(10000, [50])).toBe(5000);
  });
});

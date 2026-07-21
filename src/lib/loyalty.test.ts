import { describe, it, expect } from "vitest";
import { pointsEarned, redemptionValueSatang, clamp } from "@/lib/loyalty";

// ---------------------------------------------------------------------------
// Loyalty engine — golden tables + defensive guards. Everything is satang-exact
// (integer satang money) and points are whole non-negative integers. The engine is
// clock-free: whether loyalty is enabled / the customer is a member is decided at
// the API fetch boundary, never here — these tests only exercise the arithmetic.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §1 pointsEarned — floor(netBaht / rate), with rate boundaries
// ---------------------------------------------------------------------------

describe("pointsEarned — earn rate boundaries", () => {
  it("earns exactly 1 point AT the rate boundary (฿25 @ ฿25/point)", () => {
    expect(pointsEarned(2500, 25)).toBe(1);
  });

  it("earns 0 just BELOW the rate boundary (฿24.99 @ ฿25/point)", () => {
    expect(pointsEarned(2499, 25)).toBe(0);
  });

  it("floors a fractional multiple ABOVE the boundary (฿62.50 @ ฿25 → 2, not 2.5)", () => {
    expect(pointsEarned(6250, 25)).toBe(2);
  });

  it("earns the whole multiple (฿125 @ ฿25/point → 5)", () => {
    expect(pointsEarned(12500, 25)).toBe(5);
  });

  it("supports a ฿1/point rate at/below its boundary", () => {
    expect(pointsEarned(100, 1)).toBe(1); // ฿1 → 1
    expect(pointsEarned(99, 1)).toBe(0); // ฿0.99 → 0
    expect(pointsEarned(12345, 1)).toBe(123); // floor(123.45) = 123
  });
});

describe("pointsEarned — guards (never crash, never negative)", () => {
  it("rate 0 disables earning (divide-by-zero guard)", () => {
    expect(pointsEarned(100000, 0)).toBe(0);
  });

  it("a negative rate yields 0", () => {
    expect(pointsEarned(100000, -25)).toBe(0);
  });

  it("a non-finite rate yields 0", () => {
    expect(pointsEarned(100000, Number.NaN)).toBe(0);
    expect(pointsEarned(100000, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("a zero / negative net total earns nothing (a refund/void never earns here)", () => {
    expect(pointsEarned(0, 25)).toBe(0);
    expect(pointsEarned(-5000, 25)).toBe(0);
  });

  it("a non-finite net total yields 0", () => {
    expect(pointsEarned(Number.NaN, 25)).toBe(0);
    expect(pointsEarned(Number.POSITIVE_INFINITY, 25)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §2 redemptionValueSatang — clamp(points * value, 0, subtotal)
// ---------------------------------------------------------------------------

describe("redemptionValueSatang — value + subtotal clamp", () => {
  it("computes points × per-point value in satang (well under the subtotal cap)", () => {
    // 10 points × ฿0.10 (10 satang) = 100 satang, subtotal 100000 → 100
    expect(redemptionValueSatang(10, 10, 100000)).toBe(100);
  });

  it("returns the exact value when it equals the subtotal", () => {
    // 500 points × 10 satang = 5000 satang, subtotal 5000 → 5000
    expect(redemptionValueSatang(500, 10, 5000)).toBe(5000);
  });

  it("CLAMPS the redemption to the subtotal (never redeem more than the bill)", () => {
    // 100000 points × 10 satang = 1,000,000 satang, but subtotal is only 5000 → 5000
    expect(redemptionValueSatang(100000, 10, 5000)).toBe(5000);
  });
});

describe("redemptionValueSatang — guards (never negative)", () => {
  it("zero points redeems nothing", () => {
    expect(redemptionValueSatang(0, 10, 100000)).toBe(0);
  });

  it("negative points / value / subtotal all clamp to 0", () => {
    expect(redemptionValueSatang(-10, 10, 100000)).toBe(0);
    expect(redemptionValueSatang(10, -10, 100000)).toBe(0);
    expect(redemptionValueSatang(10, 10, -100000)).toBe(0);
  });

  it("a zero subtotal leaves nothing to discount", () => {
    expect(redemptionValueSatang(10, 10, 0)).toBe(0);
  });

  it("non-finite inputs yield 0", () => {
    expect(redemptionValueSatang(Number.NaN, 10, 100000)).toBe(0);
    expect(redemptionValueSatang(10, Number.NaN, 100000)).toBe(0);
    expect(redemptionValueSatang(10, 10, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §3 clamp — the shared inclusive-range helper
// ---------------------------------------------------------------------------

describe("clamp", () => {
  it("passes a value already inside the range through unchanged", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps below the minimum up to the minimum", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it("clamps above the maximum down to the maximum", () => {
    expect(clamp(20, 0, 10)).toBe(10);
  });
});

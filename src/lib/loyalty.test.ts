import { describe, it, expect } from "vitest";
import {
  pointsEarned,
  redemptionValueSatang,
  computeRedemption,
  clamp,
} from "@/lib/loyalty";

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
// §3 computeRedemption — effective points + redemption satang (Phase 2)
//   effective = min(requested, balance, floor(remaining / perPoint))
//   satang    = effective × perPoint (≤ remaining by construction)
// The floor cap is the crux of "points map EXACTLY to value": a redeemed point is
// always worth the full perPoint, never a fractional point for a partial remainder.
// ---------------------------------------------------------------------------

describe("computeRedemption — the happy path (redeem exactly what was asked)", () => {
  it("EXACT: request fits balance and bill → spend all requested points", () => {
    // 10 pts × 10 satang = 100 off; balance 100, remaining ฿1000 (100000 satang).
    const r = computeRedemption(10, 100, 100000, 10, 0);
    expect(r.effectiveRedeemPoints).toBe(10);
    expect(r.redemptionSatang).toBe(100);
    expect(r.maxByBillPoints).toBe(9999); // floor((100000 − 1) / 10) — never-zero cap
    expect(r.exceedsBalance).toBe(false);
    expect(r.belowMin).toBe(false);
  });

  it("caps a full-bill redeem so it NEVER zeroes the bill (leaves ≥1 satang payable)", () => {
    // remaining 10000 satang, perPoint 10 → maxByBill floor((10000 − 1) / 10) = 999 (NOT
    // 1000); request 1000 → spend 999 = 9990 off, leaving 10 satang payable. A full 1000/
    // 10000 would zero the bill and dead-end the checkout payment guard, so it is capped.
    const r = computeRedemption(1000, 5000, 10000, 10, 0);
    expect(r.effectiveRedeemPoints).toBe(999);
    expect(r.redemptionSatang).toBe(9990);
    expect(r.maxByBillPoints).toBe(999);
    // The never-zero-the-bill invariant: the redemption is always STRICTLY less than the
    // remaining bill, so the total after redemption is always ≥ 1 satang.
    expect(r.redemptionSatang).toBeLessThan(10000);
  });

  it("leaves EXACTLY 1 satang at a ฿0.01/point value (perPoint 1)", () => {
    // remaining 10000 satang, perPoint 1 → maxByBill floor((10000 − 1) / 1) = 9999; request
    // 100000 → spend 9999 = 9999 off, leaving exactly 1 satang payable (the tightest cap).
    const r = computeRedemption(100000, 100000, 10000, 1, 0);
    expect(r.effectiveRedeemPoints).toBe(9999);
    expect(r.redemptionSatang).toBe(9999);
    expect(r.redemptionSatang).toBe(10000 - 1);
  });

  it("never-zero invariant: redemptionSatang < remaining across a range of bills", () => {
    // The cap must keep the bill payable for ANY remaining/perPoint combination, even when
    // the requested points and balance are effectively unbounded.
    for (const remaining of [1, 2, 9, 10, 11, 99, 100, 101, 505, 9990, 100000]) {
      for (const perPoint of [1, 5, 10, 25, 100]) {
        const r = computeRedemption(1_000_000, 1_000_000, remaining, perPoint, 0);
        expect(r.redemptionSatang).toBeLessThan(remaining);
        expect(r.redemptionSatang).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("computeRedemption — cap by balance", () => {
  it("caps the spend at the balance and flags the overdraw request", () => {
    // request 50 but only 20 in the wallet → spend 20 (200 satang), exceedsBalance.
    const r = computeRedemption(50, 20, 100000, 10, 0);
    expect(r.effectiveRedeemPoints).toBe(20);
    expect(r.redemptionSatang).toBe(200);
    expect(r.exceedsBalance).toBe(true);
    expect(r.belowMin).toBe(false);
  });
});

describe("computeRedemption — cap by bill (points always map exactly to value)", () => {
  it("caps at floor(remaining / perPoint) so no fractional point is ever spent", () => {
    // remaining 505 satang, perPoint 10 → maxByBill 50 (NOT 50.5); spend 50 = 500 off.
    // The stray 5 satang cannot be redeemed — a point is worth the WHOLE 10 satang.
    const r = computeRedemption(1000, 5000, 505, 10, 0);
    expect(r.effectiveRedeemPoints).toBe(50);
    expect(r.redemptionSatang).toBe(500);
    expect(r.maxByBillPoints).toBe(50);
    expect(r.exceedsBalance).toBe(false);
  });

  it("a zero-value bill absorbs nothing", () => {
    const r = computeRedemption(10, 100, 0, 10, 0);
    expect(r.effectiveRedeemPoints).toBe(0);
    expect(r.redemptionSatang).toBe(0);
    expect(r.maxByBillPoints).toBe(0);
  });
});

describe("computeRedemption — below the store minimum", () => {
  it("flags belowMin when the REQUEST is under the minimum", () => {
    // min 5, request 3 (fits balance + bill) → effective 3 < 5 → belowMin.
    const r = computeRedemption(3, 100, 100000, 10, 5);
    expect(r.effectiveRedeemPoints).toBe(3);
    expect(r.belowMin).toBe(true);
  });

  it("flags belowMin when the BILL cap pushes the effective spend under the minimum", () => {
    // min 10, request 100, balance 100, remaining 50 (perPoint 10 → maxByBill
    // floor((50 − 1) / 10) = 4, the never-zero cap) → effective 4 < 10 → belowMin (tell the
    // client, do NOT silently zero it). billTooSmallForMin is also true here (4 < 10).
    const r = computeRedemption(100, 100, 50, 10, 10);
    expect(r.effectiveRedeemPoints).toBe(4);
    expect(r.belowMin).toBe(true);
    expect(r.billTooSmallForMin).toBe(true);
  });

  it("does NOT flag belowMin once the effective spend meets the minimum", () => {
    const r = computeRedemption(10, 100, 100000, 10, 10);
    expect(r.effectiveRedeemPoints).toBe(10);
    expect(r.belowMin).toBe(false);
  });
});

describe("computeRedemption — billTooSmallForMin (FIX 3, redeem control unavailable)", () => {
  it("is TRUE when the remaining bill can never reach the floor (maxByBill < min)", () => {
    // min 10, remaining 50, perPoint 10 → maxByBill floor((50 − 1) / 10) = 4 < 10 → the
    // bill itself is too small to EVER satisfy the floor (regardless of request/balance).
    const r = computeRedemption(100, 100, 50, 10, 10);
    expect(r.maxByBillPoints).toBe(4);
    expect(r.billTooSmallForMin).toBe(true);
  });

  it("is FALSE when the bill COULD support the floor (belowMin instead)", () => {
    // min 5, remaining 100000, perPoint 10 → maxByBill 9999 ≥ 5 → the bill can support the
    // floor; a request of 3 is merely below the floor (belowMin), not bill-too-small.
    const r = computeRedemption(3, 100, 100000, 10, 5);
    expect(r.billTooSmallForMin).toBe(false);
    expect(r.belowMin).toBe(true);
  });

  it("is FALSE when there is no store floor (minRedeemPoints 0)", () => {
    // min 0 → there is no floor to be too small for, even on a tiny bill.
    const r = computeRedemption(1, 100, 10, 10, 0);
    expect(r.billTooSmallForMin).toBe(false);
  });
});

describe("computeRedemption — zero + guards (never negative, never crash)", () => {
  it("a zero request redeems nothing and never flags belowMin", () => {
    const r = computeRedemption(0, 100, 100000, 10, 5);
    expect(r.effectiveRedeemPoints).toBe(0);
    expect(r.redemptionSatang).toBe(0);
    expect(r.belowMin).toBe(false); // guarded by `requested > 0`
    expect(r.exceedsBalance).toBe(false);
  });

  it("a non-positive point value disables redemption (divide-by-zero guard)", () => {
    const r = computeRedemption(10, 100, 100000, 0, 0);
    expect(r.effectiveRedeemPoints).toBe(0);
    expect(r.redemptionSatang).toBe(0);
    expect(r.maxByBillPoints).toBe(0);
  });

  it("non-finite / negative inputs all degrade to a zero, non-negative plan", () => {
    const r = computeRedemption(Number.NaN, -5, -100, 10, -1);
    expect(r.effectiveRedeemPoints).toBe(0);
    expect(r.redemptionSatang).toBe(0);
    expect(r.exceedsBalance).toBe(false);
    expect(r.belowMin).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4 clamp — the shared inclusive-range helper
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

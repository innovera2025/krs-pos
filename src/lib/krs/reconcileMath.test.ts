// PURE unit tests for the KRS shared-reconcile integer/rounding math (krs-realtime-inbound
// P1). These rules move real, sellable POS stock, so they are pinned here (no DB, no mssql).

import { describe, it, expect } from "vitest";
import { POS_STOCK_MAX, toIntDelta, toWarehouseQty } from "./reconcileMath";

describe("toIntDelta", () => {
  it("rounds a fractional delta to the nearest integer", () => {
    expect(toIntDelta(2.4)).toBe(2);
    expect(toIntDelta(2.5)).toBe(3);
    expect(toIntDelta(-2.5)).toBe(-2); // Math.round rounds half toward +Infinity
    expect(toIntDelta(-2.6)).toBe(-3);
  });

  it("preserves sign (an ERP return/adjustment stays negative)", () => {
    expect(toIntDelta(-52)).toBe(-52);
    expect(toIntDelta(52)).toBe(52);
  });

  it("is a no-op for a zero delta (the idempotent re-run case)", () => {
    expect(toIntDelta(0)).toBe(0);
    expect(toIntDelta(0.0001)).toBe(0); // sub-unit fractional drift rounds to 0
  });

  it("collapses a non-finite input to 0", () => {
    expect(toIntDelta(Number.NaN)).toBe(0);
    expect(toIntDelta(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toIntDelta(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it("caps the magnitude at ±POS_STOCK_MAX so the Int column can never overflow", () => {
    expect(toIntDelta(POS_STOCK_MAX + 1000)).toBe(POS_STOCK_MAX);
    expect(toIntDelta(-(POS_STOCK_MAX + 1000))).toBe(-POS_STOCK_MAX);
  });
});

describe("toWarehouseQty", () => {
  it("rounds a fractional balance and floors negatives at 0", () => {
    expect(toWarehouseQty(51.6)).toBe(52);
    expect(toWarehouseQty(0.4)).toBe(0);
    expect(toWarehouseQty(-3)).toBe(0); // over-issued balance never shows negative stock
  });

  it("collapses a non-finite balance to 0", () => {
    expect(toWarehouseQty(Number.NaN)).toBe(0);
    expect(toWarehouseQty(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("caps at POS_STOCK_MAX", () => {
    expect(toWarehouseQty(POS_STOCK_MAX + 5)).toBe(POS_STOCK_MAX);
  });
});

// Regression sketch for the 15-07-26 incident's math shape: the SCOPED per-warehouse
// answers sum to the global figure via deltas, and a re-run with the SAME KRS answer is a
// no-op (delta = observed − observed = 0). No global sp_Onhand value is ever involved.
describe("Σ-per-warehouse delta shape (15-07-26 incident guard)", () => {
  it("first sighting seeds full stock; an unchanged re-read applies zero further delta", () => {
    // WH03 reports 52 for an item; baseline (no prior snapshot) = 0.
    const firstDelta = toIntDelta(52 - 0);
    expect(firstDelta).toBe(52);
    // Next cycle: KRS still reports 52; baseline is now the OBSERVED 52 → delta 0 (no
    // phantom movement — the exact failure mode Attempt-1 hit when the baseline was a
    // wished-for value against a broken global read).
    const steadyDelta = toIntDelta(52 - 52);
    expect(steadyDelta).toBe(0);
  });

  it("a genuine KRS receipt of +8 applies exactly +8 on top of the observed baseline", () => {
    const delta = toIntDelta(60 - 52);
    expect(delta).toBe(8);
  });
});

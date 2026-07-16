// PURE unit tests for the KRS product ghost-reconciliation decision core (17-07-26
// incident). This logic AUTO-DEACTIVATES POS products, so its safety guards are pinned
// here (no DB, no mssql) — a regression that widened the deactivation set would be a
// data-loss bug on the highest-risk (money/stock/catalogue) surface.

import { describe, it, expect } from "vitest";
import {
  planKrsGhostReconcile,
  RECONCILE_MIN_FETCH_RATIO,
  type ReconcileCandidate,
} from "./ghostReconcile";

/** Build a krsManaged-active candidate with sane defaults. */
function candidate(over: Partial<ReconcileCandidate> & { sku: string }): ReconcileCandidate {
  return { id: `id-${over.sku}`, stock: 0, barcode: null, ...over };
}

describe("planKrsGhostReconcile — ghost detection", () => {
  it("flags a krsManaged-active product whose sku vanished from the feed", () => {
    const candidates = [
      candidate({ sku: "F01-0001" }),
      candidate({ sku: "F01-0002" }),
      candidate({ sku: "F01-0003", barcode: "8850001" }),
    ];
    // The feed no longer carries F01-0003 (deleted KRS ItemCode).
    const fetchedSkus = new Set(["F01-0001", "F01-0002"]);

    const plan = planKrsGhostReconcile(candidates, fetchedSkus, 2);

    expect(plan.skip).toBe(false);
    expect(plan.ghostIds).toEqual(["id-F01-0003"]);
    expect(plan.freedBarcodes).toBe(1); // the ghost held a barcode → freed
    expect(plan.stockedGhosts).toEqual([]);
  });

  it("is a no-op when every candidate is still present in the feed", () => {
    const candidates = [candidate({ sku: "A" }), candidate({ sku: "B" })];
    const plan = planKrsGhostReconcile(candidates, new Set(["A", "B"]), 2);
    expect(plan.skip).toBe(false);
    expect(plan.ghostIds).toEqual([]);
    expect(plan.freedBarcodes).toBe(0);
  });

  it("counts freed barcodes only for ghosts that actually held one", () => {
    const candidates = [
      candidate({ sku: "G1", barcode: "111" }),
      candidate({ sku: "G2", barcode: null }),
    ];
    const plan = planKrsGhostReconcile(candidates, new Set<string>(), 100); // huge feed, both are ghosts
    // GUARD 1 uses candidateCount(2) → threshold 1.2; fetchedCount 100 ≥ 1.2, no skip.
    expect(plan.skip).toBe(false);
    expect(plan.ghostIds.sort()).toEqual(["id-G1", "id-G2"]);
    expect(plan.freedBarcodes).toBe(1); // only G1 had a barcode
  });
});

describe("planKrsGhostReconcile — GUARD 1 (fail-open on a small fetch)", () => {
  it("SKIPS entirely when the feed is below 60% of the krsManaged-active universe", () => {
    const candidates = Array.from({ length: 100 }, (_, i) => candidate({ sku: `S${i}` }));
    // 59 < 100 * 0.6 (=60) → partial fetch → skip, nothing deactivated.
    const plan = planKrsGhostReconcile(candidates, new Set(["S0"]), 59);
    expect(plan.skip).toBe(true);
    expect(plan.ghostIds).toEqual([]);
    expect(plan.freedBarcodes).toBe(0);
    expect(plan.stockedGhosts).toEqual([]);
  });

  it("does NOT skip exactly at the 60% boundary", () => {
    const candidates = Array.from({ length: 100 }, (_, i) => candidate({ sku: `S${i}` }));
    // 60 is NOT < 60 → boundary is inclusive → reconciliation runs.
    const plan = planKrsGhostReconcile(candidates, new Set(["S0"]), 60);
    expect(plan.skip).toBe(false);
  });

  it("SKIPS an empty feed when candidates exist (the incident's worst case)", () => {
    const candidates = [candidate({ sku: "A" }), candidate({ sku: "B" })];
    const plan = planKrsGhostReconcile(candidates, new Set<string>(), 0);
    expect(plan.skip).toBe(true);
    expect(plan.ghostIds).toEqual([]);
  });

  it("never trips GUARD 1 when there are no candidates to protect", () => {
    const plan = planKrsGhostReconcile([], new Set<string>(), 0);
    expect(plan.skip).toBe(false);
    expect(plan.ghostIds).toEqual([]);
  });

  it("exposes the ratio it used via the constant (documents the 60% floor)", () => {
    expect(RECONCILE_MIN_FETCH_RATIO).toBe(0.6);
  });
});

describe("planKrsGhostReconcile — GUARD 2 (never deactivate a stock-holding ghost)", () => {
  it("leaves a positive-stock ghost ACTIVE and surfaces it for review", () => {
    const candidates = [
      candidate({ sku: "ZERO" }),
      candidate({ sku: "STOCKED", stock: 5, barcode: "999" }),
    ];
    const plan = planKrsGhostReconcile(candidates, new Set<string>(), 100);
    expect(plan.ghostIds).toEqual(["id-ZERO"]);
    expect(plan.freedBarcodes).toBe(0); // ZERO had no barcode; STOCKED excluded
    expect(plan.stockedGhosts).toEqual([{ id: "id-STOCKED", sku: "STOCKED", stock: 5 }]);
  });

  it("treats a NEGATIVE-stock ghost as anomalous too (review, not deactivate)", () => {
    const candidates = [candidate({ sku: "NEG", stock: -3, barcode: "abc" })];
    const plan = planKrsGhostReconcile(candidates, new Set<string>(), 100);
    expect(plan.ghostIds).toEqual([]);
    expect(plan.freedBarcodes).toBe(0);
    expect(plan.stockedGhosts).toEqual([{ id: "id-NEG", sku: "NEG", stock: -3 }]);
  });
});

// The reconciler's universe is `krsManaged = true` ONLY — this is enforced by the DB
// query in importProducts.ts, so a manual (krsManaged=false) product is never even a
// candidate here. This test documents that the pure core acts purely on what it is
// given: feed a candidate list that (by contract) already excludes manual rows.
describe("planKrsGhostReconcile — manual-product safety (contract)", () => {
  it("only ever returns ids drawn from the supplied candidate list", () => {
    const candidates = [candidate({ sku: "KRS-ONLY" })];
    const plan = planKrsGhostReconcile(candidates, new Set<string>(), 100);
    // A manual product is not in `candidates`, so it can never appear in ghostIds.
    expect(plan.ghostIds).toEqual(["id-KRS-ONLY"]);
  });
});

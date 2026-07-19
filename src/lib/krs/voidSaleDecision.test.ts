// PURE unit tests for the void-path decision (krs-void-writeback gap fix). This maps the
// latest SALE SyncJob's status to a void path; it gates whether an unsynced bill's SALE
// job gets neutralized (no orphan KRS write) and whether a synced bill enqueues a cancel —
// real ERP-document + stock consequences — so the mapping is pinned here (no DB, no mssql).

import { describe, it, expect } from "vitest";
import { decideVoidSalePath } from "./voidSaleDecision";

describe("decideVoidSalePath — SALE-job status → void path", () => {
  it("null (no SALE job — legacy/simulated era) → skip-local", () => {
    expect(decideVoidSalePath(null)).toBe("skip-local");
  });

  it("SYNCED (sale reached KRS) → enqueue-void", () => {
    expect(decideVoidSalePath("SYNCED")).toBe("enqueue-void");
  });

  it("NEEDS_RECONCILE (ambiguous ERP state) → needs-reconcile (block the void)", () => {
    expect(decideVoidSalePath("NEEDS_RECONCILE")).toBe("needs-reconcile");
  });

  it("SKIPPED (already neutralized/deduped — never claimable) → skip-local", () => {
    expect(decideVoidSalePath("SKIPPED")).toBe("skip-local");
  });

  it("PENDING (still claimable — must neutralize before it writes) → neutralize", () => {
    expect(decideVoidSalePath("PENDING")).toBe("neutralize");
  });

  it("RETRYING (still claimable — must neutralize) → neutralize", () => {
    expect(decideVoidSalePath("RETRYING")).toBe("neutralize");
  });

  it("FAILED (not-yet-neutralized, unclaimable but tidy up) → neutralize", () => {
    expect(decideVoidSalePath("FAILED")).toBe("neutralize");
  });
});

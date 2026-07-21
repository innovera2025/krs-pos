import { describe, it, expect } from "vitest";
import {
  RewardPostBodySchema,
  RewardPatchBodySchema,
} from "@/lib/schemas/reward";

// ---------------------------------------------------------------------------
// Reward catalog schemas (loyalty program, Phase 3A). The schemas own SHAPE +
// VALUE; the ROUTE owns product-existence (→ 422 UNKNOWN_PRODUCT) and P2025 → 404,
// so these tests cover only the boundary contract.
// ---------------------------------------------------------------------------

describe("RewardPostBodySchema — valid input", () => {
  it("accepts a full reward and defaults isActive to true when omitted", () => {
    const r = RewardPostBodySchema.safeParse({
      name: "กาแฟเย็นฟรี",
      pointsCost: 100,
      productId: "prod_abc",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("กาแฟเย็นฟรี");
      expect(r.data.pointsCost).toBe(100);
      expect(r.data.productId).toBe("prod_abc");
      expect(r.data.isActive).toBe(true);
    }
  });

  it("trims the name", () => {
    const r = RewardPostBodySchema.safeParse({
      name: "  ของแถม  ",
      pointsCost: 1,
      productId: "p1",
    });
    expect(r.success && r.data.name).toBe("ของแถม");
  });

  it("honors an explicit isActive:false (created disabled)", () => {
    const r = RewardPostBodySchema.safeParse({
      name: "x",
      pointsCost: 5,
      productId: "p1",
      isActive: false,
    });
    expect(r.success && r.data.isActive).toBe(false);
  });

  it("accepts the pointsCost bounds exactly (1 and 1,000,000)", () => {
    expect(
      RewardPostBodySchema.safeParse({ name: "a", pointsCost: 1, productId: "p" }).success
    ).toBe(true);
    expect(
      RewardPostBodySchema.safeParse({ name: "a", pointsCost: 1_000_000, productId: "p" })
        .success
    ).toBe(true);
  });
});

describe("RewardPostBodySchema — rejected input", () => {
  it("rejects a blank / whitespace-only name", () => {
    expect(
      RewardPostBodySchema.safeParse({ name: "   ", pointsCost: 1, productId: "p" }).success
    ).toBe(false);
  });

  it("rejects a zero or negative pointsCost", () => {
    expect(
      RewardPostBodySchema.safeParse({ name: "a", pointsCost: 0, productId: "p" }).success
    ).toBe(false);
    expect(
      RewardPostBodySchema.safeParse({ name: "a", pointsCost: -5, productId: "p" }).success
    ).toBe(false);
  });

  it("rejects a fractional pointsCost (points are whole integers)", () => {
    expect(
      RewardPostBodySchema.safeParse({ name: "a", pointsCost: 2.5, productId: "p" }).success
    ).toBe(false);
  });

  it("rejects a pointsCost beyond the magnitude cap", () => {
    expect(
      RewardPostBodySchema.safeParse({ name: "a", pointsCost: 1_000_001, productId: "p" })
        .success
    ).toBe(false);
  });

  it("rejects a missing / empty productId", () => {
    expect(
      RewardPostBodySchema.safeParse({ name: "a", pointsCost: 1, productId: "" }).success
    ).toBe(false);
    expect(RewardPostBodySchema.safeParse({ name: "a", pointsCost: 1 }).success).toBe(false);
  });

  it("rejects a non-numeric pointsCost", () => {
    expect(
      RewardPostBodySchema.safeParse({ name: "a", pointsCost: "100", productId: "p" }).success
    ).toBe(false);
  });
});

describe("RewardPatchBodySchema — partial edits", () => {
  it("accepts an empty object (no-op; the route rejects zero fields)", () => {
    expect(RewardPatchBodySchema.safeParse({}).success).toBe(true);
  });

  it("accepts a lone isActive toggle", () => {
    const r = RewardPatchBodySchema.safeParse({ isActive: false });
    expect(r.success && r.data.isActive).toBe(false);
  });

  it("accepts a productId change (route re-validates it)", () => {
    const r = RewardPatchBodySchema.safeParse({ productId: "prod_new" });
    expect(r.success && r.data.productId).toBe("prod_new");
  });

  it("accepts a name + pointsCost edit", () => {
    const r = RewardPatchBodySchema.safeParse({ name: "ใหม่", pointsCost: 250 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe("ใหม่");
      expect(r.data.pointsCost).toBe(250);
    }
  });

  it("rejects an invalid pointsCost when provided", () => {
    expect(RewardPatchBodySchema.safeParse({ pointsCost: 0 }).success).toBe(false);
    expect(RewardPatchBodySchema.safeParse({ pointsCost: 1.5 }).success).toBe(false);
  });

  it("does not inject a default isActive on patch (key stays absent)", () => {
    const r = RewardPatchBodySchema.safeParse({ name: "a" });
    expect(r.success).toBe(true);
    if (r.success) expect("isActive" in r.data).toBe(false);
  });
});

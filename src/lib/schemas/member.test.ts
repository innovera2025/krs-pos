import { describe, it, expect } from "vitest";
import { MemberAdjustBodySchema } from "@/lib/schemas/member";

// ---------------------------------------------------------------------------
// MemberAdjustBodySchema — SHAPE validation for the manual points-adjust body.
// The schema owns shape only; the negative-overdraw guard is enforced atomically
// in the route (updateMany WHERE pointsBalance >= -points), NOT here.
// ---------------------------------------------------------------------------

describe("MemberAdjustBodySchema — valid input", () => {
  it("accepts a positive integer delta with a note", () => {
    const r = MemberAdjustBodySchema.safeParse({ points: 50, note: "โบนัส" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.points).toBe(50);
      expect(r.data.note).toBe("โบนัส");
    }
  });

  it("accepts a negative integer delta (a debit)", () => {
    const r = MemberAdjustBodySchema.safeParse({ points: -30 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.points).toBe(-30);
  });

  it("normalizes an omitted note to null", () => {
    const r = MemberAdjustBodySchema.safeParse({ points: 10 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.note).toBeNull();
  });

  it("trims a note and normalizes a blank one to null", () => {
    const trimmed = MemberAdjustBodySchema.safeParse({ points: 1, note: "  ปรับ  " });
    expect(trimmed.success && trimmed.data.note).toBe("ปรับ");
    const blank = MemberAdjustBodySchema.safeParse({ points: 1, note: "   " });
    expect(blank.success && blank.data.note).toBeNull();
  });

  it("accepts the magnitude cap exactly (±1,000,000)", () => {
    expect(MemberAdjustBodySchema.safeParse({ points: 1_000_000 }).success).toBe(true);
    expect(MemberAdjustBodySchema.safeParse({ points: -1_000_000 }).success).toBe(true);
  });
});

describe("MemberAdjustBodySchema — rejected input", () => {
  it("rejects a zero delta (nothing to adjust)", () => {
    expect(MemberAdjustBodySchema.safeParse({ points: 0 }).success).toBe(false);
  });

  it("rejects a fractional delta (points are whole integers)", () => {
    expect(MemberAdjustBodySchema.safeParse({ points: 2.5 }).success).toBe(false);
  });

  it("rejects a non-numeric / missing points value", () => {
    expect(MemberAdjustBodySchema.safeParse({ points: "5" }).success).toBe(false);
    expect(MemberAdjustBodySchema.safeParse({ note: "x" }).success).toBe(false);
  });

  it("rejects a non-finite delta", () => {
    expect(MemberAdjustBodySchema.safeParse({ points: Number.NaN }).success).toBe(false);
    expect(
      MemberAdjustBodySchema.safeParse({ points: Number.POSITIVE_INFINITY }).success
    ).toBe(false);
  });

  it("rejects a delta beyond the magnitude cap", () => {
    expect(MemberAdjustBodySchema.safeParse({ points: 1_000_001 }).success).toBe(false);
    expect(MemberAdjustBodySchema.safeParse({ points: -1_000_001 }).success).toBe(false);
  });

  it("rejects an over-long note", () => {
    expect(
      MemberAdjustBodySchema.safeParse({ points: 1, note: "ก".repeat(201) }).success
    ).toBe(false);
  });
});

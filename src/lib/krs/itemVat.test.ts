import { describe, it, expect } from "vitest";
import { parseItemVat } from "@/lib/krs/itemVat";

// ---------------------------------------------------------------------------
// parseItemVat (per-item-vat program) — KRS InventoryItem.itemvat text → boolean.
// The vendor value is Thai text "คิดภาษี" (VAT-applicable) / "ไม่คิดภาษี" (exempt);
// the parser must also tolerate codes and default UNKNOWN/BLANK to true (the safe
// VAT-applicable default that keeps the current uniform behavior).
// ---------------------------------------------------------------------------

describe("parseItemVat — vendor Thai text", () => {
  it('"คิดภาษี" → true (VAT-applicable)', () => {
    expect(parseItemVat("คิดภาษี")).toBe(true);
  });
  it('"ไม่คิดภาษี" → false (exempt), even though it CONTAINS "คิดภาษี"', () => {
    // The exempt marker must win — "ไม่คิดภาษี" embeds the substring "คิดภาษี".
    expect(parseItemVat("ไม่คิดภาษี")).toBe(false);
  });
  it('"ยกเว้นภาษี" (exempt) → false', () => {
    expect(parseItemVat("ยกเว้นภาษี")).toBe(false);
  });
  it("trims surrounding whitespace before matching", () => {
    expect(parseItemVat("  ไม่คิดภาษี  ")).toBe(false);
    expect(parseItemVat("  คิดภาษี  ")).toBe(true);
  });
});

describe("parseItemVat — codes (Y/N/1/0/bool)", () => {
  it("VAT-applicable codes → true", () => {
    for (const v of ["Y", "y", "Yes", "1", "true", "TRUE"]) {
      expect(parseItemVat(v)).toBe(true);
    }
  });
  it("non-VAT codes → false", () => {
    for (const v of ["N", "n", "No", "0", "false", "FALSE"]) {
      expect(parseItemVat(v)).toBe(false);
    }
  });
  it("numeric / boolean primitives are coerced via String()", () => {
    expect(parseItemVat(1)).toBe(true);
    expect(parseItemVat(0)).toBe(false);
    expect(parseItemVat(true)).toBe(true);
    expect(parseItemVat(false)).toBe(false);
  });
  it('a "NON-VAT"/"NOVAT" latin marker → false (never mis-read as VAT)', () => {
    // Both contain "VAT" but are exempt — the NON marker is tested first.
    expect(parseItemVat("NON-VAT")).toBe(false);
    expect(parseItemVat("NoVat")).toBe(false);
    expect(parseItemVat("EXEMPT")).toBe(false);
  });
  it('a plain "VAT" latin marker → true', () => {
    expect(parseItemVat("VAT")).toBe(true);
    expect(parseItemVat("VAT 7%")).toBe(true);
  });
});

describe("parseItemVat — safe default (unknown/blank/null)", () => {
  it("null / undefined → true", () => {
    expect(parseItemVat(null)).toBe(true);
    expect(parseItemVat(undefined)).toBe(true);
  });
  it("blank / whitespace-only → true", () => {
    expect(parseItemVat("")).toBe(true);
    expect(parseItemVat("   ")).toBe(true);
  });
  it("an unrecognized value → true (VAT-applicable = current uniform behavior)", () => {
    expect(parseItemVat("something-else")).toBe(true);
    expect(parseItemVat("2")).toBe(true);
  });
});

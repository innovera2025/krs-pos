// PURE, dependency-free (per-item-vat program). No Prisma / mssql / env imports, so it
// is unit-testable in the vitest node suite (which has no DATABASE_URL and cannot import
// the KRS module graph). `products.ts` imports `parseItemVat` from here for the inbound
// KRS product-master row mapping (KRS InventoryItem.itemvat → POS Product.vatable).

/**
 * Parse the KRS `InventoryItem.itemvat` flag into a POS `vatable` boolean.
 *
 * The vendor value is Thai TEXT — "คิดภาษี" (VAT-applicable) or "ไม่คิดภาษี" (VAT-exempt).
 * We parse it ROBUSTLY (it may also arrive as a code Y/N/1/0/true/false from the driver):
 *
 *   - blank / null / undefined / unrecognized → **true** (SAFE DEFAULT = VAT-applicable).
 *     This keeps an unmapped/unknown value byte-identical to the current uniform behavior,
 *     where every line is VAT-applicable.
 *   - explicit NON-VAT markers → false. Tested FIRST, because the exempt Thai text
 *     "ไม่คิดภาษี" CONTAINS the substring "คิดภาษี" (VAT-applicable) and the Latin
 *     "NON-VAT"/"NOVAT" contains "VAT" — so the exempt markers must win before the
 *     VAT-applicable markers below, or an exempt value would be mis-read as taxable.
 *   - explicit VAT-applicable markers → true.
 *
 * Priority is exempt → applicable → default-true. `raw` is coerced via `String(raw)` so a
 * numeric/boolean code (1/0/true/false) is handled alongside the vendor's text.
 */
export function parseItemVat(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  const s = String(raw).trim();
  if (s.length === 0) return true;
  const upper = s.toUpperCase();

  // 1. Explicit NON-VAT (exempt) — MUST be tested first (see docblock: "ไม่คิดภาษี"
  //    contains "คิดภาษี"; "NON-VAT"/"NOVAT" contains "VAT").
  //      Thai:  "ไม่" (ไม่คิดภาษี) or "ยกเว้น" (ยกเว้นภาษี = exempt)
  //      Latin: a leading "NO" (NO / NON-VAT / NOVAT / NONE), an EXEMPT substring, or an
  //             exact non-VAT code N / 0 / FALSE. `startsWith("NO")` (not `includes("VAT")`
  //             below) is why an exempt latin marker is never mis-read as VAT-applicable.
  if (
    s.includes("ไม่") ||
    s.includes("ยกเว้น") ||
    upper.startsWith("NO") ||
    upper.includes("EXEMPT") ||
    upper === "N" ||
    upper === "0" ||
    upper === "FALSE"
  ) {
    return false;
  }

  // 2. Explicit VAT-applicable.
  //      Thai:  "คิดภาษี"
  //      Latin: contains VAT, or an exact VAT code Y / YES / 1 / TRUE
  if (
    s.includes("คิดภาษี") ||
    upper.includes("VAT") ||
    upper === "Y" ||
    upper === "YES" ||
    upper === "1" ||
    upper === "TRUE"
  ) {
    return true;
  }

  // 3. Unknown / unrecognized → SAFE DEFAULT true (VAT-applicable = current behavior).
  return true;
}

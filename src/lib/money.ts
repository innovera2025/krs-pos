/**
 * Format a number or numeric string as Thai Baht with two decimal places.
 *
 * Phase 1 scope: presentation/formatting only. This is NOT Decimal-safe money
 * math — accurate money/stock arithmetic is owned by the production-readiness
 * program. Do not use this for computing totals.
 */
export function money(n: number | string): string {
  const raw = typeof n === "string" ? Number(n.trim()) : n;
  // Guard non-numeric / NaN / Infinity so a POS amount never renders "฿NaN".
  if (!Number.isFinite(raw)) return "฿0.00";
  // Normalize negative zero (a discount netting to exactly 0 must not show "฿-0.00").
  const v = raw === 0 ? 0 : raw;
  // Sign goes BEFORE the ฿ symbol: "-฿5.00", not "฿-5.00".
  const sign = v < 0 ? "-" : "";
  return (
    sign +
    "฿" +
    Math.abs(v).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

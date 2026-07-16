// PURE. Integer/rounding math for the KRS shared stock-reconcile engine
// (krs-realtime-inbound P1). Kept in its own module — free of `mssql` and Prisma — so the
// delta/rounding rules that move real, sellable POS stock are unit-testable with plain
// vitest (no DB, no driver). `stockReconcile.ts` imports these; nothing else should need
// the raw helpers.

/** POS `Product.stock` is a 32-bit Postgres Int. Applied deltas + rounded warehouse
 *  quantities are capped to this so an absurd KRS ledger value can never overflow the
 *  column (which would surface as a 500). Mirrors the old autoSync / sync-stock cap. */
export const POS_STOCK_MAX = 2_147_483_647;

/**
 * Round + cap a raw (fractional, possibly negative) KRS delta to the signed integer the
 * `Product.stock` column can hold. The KRS Balqty is fractional; we round to the nearest
 * integer and cap the magnitude at ±POS_STOCK_MAX. A non-finite input collapses to 0. Sign
 * is preserved (a negative ERP adjustment stays negative).
 */
export function toIntDelta(rawDelta: number): number {
  if (!Number.isFinite(rawDelta)) return 0;
  const rounded = Math.round(rawDelta);
  if (rounded > POS_STOCK_MAX) return POS_STOCK_MAX;
  if (rounded < -POS_STOCK_MAX) return -POS_STOCK_MAX;
  return rounded;
}

/**
 * Round + floor a raw KRS balance to the NON-NEGATIVE integer a `WarehouseStock.qty` column
 * holds (the per-warehouse display value). A negative balance (over-issued / opening
 * adjustment) floors to 0; a non-finite input collapses to 0; the magnitude is capped so it
 * can never overflow the Int column.
 */
export function toWarehouseQty(balance: number): number {
  if (!Number.isFinite(balance)) return 0;
  const rounded = Math.max(0, Math.round(balance));
  return rounded > POS_STOCK_MAX ? POS_STOCK_MAX : rounded;
}

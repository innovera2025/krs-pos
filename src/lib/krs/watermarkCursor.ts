// PURE. Watermark cursor comparison / advance logic + itemCode set helpers for the
// KRS realtime-inbound poller (krs-realtime-inbound P1, watermark variant).
//
// This module is deliberately FREE of the `mssql` driver and Prisma so its logic is
// unit-testable with plain vitest (no live SQL Server, no DB). The Node-only detector
// that actually issues the SQL lives in `watermark.ts` and imports these helpers; the
// route (`/api/krs/rt-poll`) uses them to decide "did anything move?" and "what does the
// cursor advance to?" without embedding that math in an un-testable route handler.
//
// WATERMARK MODEL (see references/krs-watermark-discovery_16-07-26.md): the KRS server
// exposes four cheap "high-water marks" that advance whenever a stock-affecting event
// happens: InventoryFlowHdr.TransactionNo (a monotonic running document number — every
// NEW doc gets a strictly higher value), InventoryFlowHdr.EntryDate (doc creation ts),
// InventoryFlowHdr.ApprovedDate (approval moment — a LATE approval of an old doc moves
// on-hand with no new TransactionNo, so it needs its own watermark), and
// InventoryItem.EntryDate (a NEW product master row). The stored cursor remembers the
// last-observed value of each; a probe that reads a strictly-greater value on ANY of the
// four means "something moved — fetch and reconcile."
//
// DELETION DETECTOR (added 17-07-26): the four MAX watermarks above can only ADVANCE, so a
// pure DELETE of an InventoryItem row (a KRS master purge) moves NONE of them — it would
// only ride the ≤60s full-reconcile sweep. But a delete DOES change COUNT(*) of the tiny
// (~4k row) dbo.InventoryItem table, and that count is effectively free on the existing 2s
// probe round-trip. So the probe also carries `itemCount`, and a change in that count IN
// EITHER DIRECTION (a delete lowers it; a re-add or add+delete net raises it) is treated as
// "item-master work needed" — making deletions realtime instead of sweep-latency. The count
// baseline starts UNOBSERVED (-1); until the first cursor advance records a real count it is
// not compared (deletions in that brief window still ride the ≤60s sweep).

/** The watermarks observed from a single KRS probe: the aggregate MAX values plus the
 *  InventoryItem row COUNT (the deletion detector). `maxTxn` is the running document number
 *  (0 when the table is empty); the three dates are null when their column has no non-null
 *  value yet (e.g. no approvals so far). `itemCount` is COUNT(*) of dbo.InventoryItem (>= 0
 *  in practice; a defensive/degenerate probe reports -1 = "not observed", ignored below). */
export type Watermarks = {
  maxTxn: number;
  maxEntry: Date | null;
  maxApproved: Date | null;
  maxItemEntry: Date | null;
  itemCount: number;
};

/** The persisted cursor state (mirrors the `KrsWatermarkCursor` singleton columns we
 *  care about for comparison/advance). Kept structural (not the Prisma type) so this
 *  module never imports Prisma. */
export type WatermarkCursorState = {
  lastTxn: number;
  lastEntryAt: Date | null;
  lastApprovedAt: Date | null;
  lastItemEntryAt: Date | null;
  /** COUNT(*) of dbo.InventoryItem at the last applied cycle; -1 = not yet observed
   *  (fresh field / pre-migration cursor). A negative value is never comparable, so the
   *  deletion detector reports "no change" until a real count is recorded (see
   *  `itemCountChanged`). */
  lastItemCount: number;
};

/** The zero cursor for a first-ever run (no row yet, or a freshly-created default). All
 *  watermarks unset → the first probe will always look "advanced", and the caller treats
 *  a fresh cursor as a full-reconcile trigger (see `isFreshCursor`). `lastItemCount` starts
 *  at -1 ("not yet observed") so the deletion detector stays quiet until the first advance
 *  records a real count. */
export const ZERO_CURSOR: WatermarkCursorState = {
  lastTxn: 0,
  lastEntryAt: null,
  lastApprovedAt: null,
  lastItemEntryAt: null,
  lastItemCount: -1,
};

/** True when the cursor has never observed anything (first run / retention re-init).
 *  The route uses this to choose a full reconcile (scope=ALL) instead of an incremental
 *  changed-docs fetch, so baselines are established from the whole catalogue once. */
export function isFreshCursor(cursor: WatermarkCursorState): boolean {
  return (
    cursor.lastTxn <= 0 &&
    cursor.lastEntryAt === null &&
    cursor.lastApprovedAt === null &&
    cursor.lastItemEntryAt === null
  );
}

/** `a > b` for a nullable Date watermark, treating null as "never observed" (the lowest
 *  possible value). A non-null probe value strictly beats a null cursor value; two nulls
 *  are not "advanced"; equal timestamps are not "advanced" (strict `>` so we never
 *  re-process the exact boundary forever). */
function dateAdvanced(probe: Date | null, cursor: Date | null): boolean {
  if (probe === null) return false; // nothing observed on this signal → cannot advance
  if (cursor === null) return true; // first non-null sighting of this signal
  return probe.getTime() > cursor.getTime();
}

/** True when the InventoryItem row COUNT changed since the cursor last observed it — the
 *  DELETION detector (a delete lowers COUNT but advances no MAX watermark). Detects a
 *  change in EITHER direction (deletes lower it; a re-add / add+delete net raises it).
 *  A negative value on EITHER side means "not yet observed" (fresh field / pre-migration
 *  cursor, or a degenerate probe) and is NEVER comparable → reports false, so the count is
 *  bootstrapped by the first cursor advance and deletions in that brief window still ride
 *  the ≤60s full-reconcile safety net. */
function itemCountChanged(cursor: WatermarkCursorState, probe: Watermarks): boolean {
  if (cursor.lastItemCount < 0 || probe.itemCount < 0) return false;
  return probe.itemCount !== cursor.lastItemCount;
}

/** True when ANY watermark advanced strictly past the stored cursor OR the InventoryItem
 *  row count changed — i.e. a stock movement, an approval flip, a new product/master row,
 *  or a product DELETION happened since the last successful cycle. This is the cheap gate
 *  that keeps the 2s hot path a no-op (probe-only, zero writes) when the shop is idle: it
 *  exits false ONLY when nothing moved AND the count is unchanged. */
export function watermarksAdvanced(
  cursor: WatermarkCursorState,
  probe: Watermarks
): boolean {
  if (probe.maxTxn > cursor.lastTxn) return true;
  if (dateAdvanced(probe.maxEntry, cursor.lastEntryAt)) return true;
  if (dateAdvanced(probe.maxApproved, cursor.lastApprovedAt)) return true;
  if (dateAdvanced(probe.maxItemEntry, cursor.lastItemEntryAt)) return true;
  if (itemCountChanged(cursor, probe)) return true;
  return false;
}

/** True when item-master work is needed: the InventoryItem.EntryDate watermark advanced
 *  (a NEW product-master row — adds/possible edits) OR the InventoryItem row count changed
 *  (a DELETION, or an add+delete net not covered by EntryDate). Either way the route runs
 *  the (existing) product import, whose ghost-reconcile pass upserts new items AND
 *  deactivates vanished ones + frees their barcodes, before stock is reconciled. */
export function itemMasterAdvanced(
  cursor: WatermarkCursorState,
  probe: Watermarks
): boolean {
  return (
    dateAdvanced(probe.maxItemEntry, cursor.lastItemEntryAt) ||
    itemCountChanged(cursor, probe)
  );
}

/** The larger of two nullable dates (null = lowest). Used so a cursor advance never
 *  regresses a watermark if a probe momentarily returns a lower value (defensive). */
function maxDate(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * The cursor values to persist after a cycle that fully applied. Advances to the PROBE
 * snapshot captured at the START of the cycle (the authoritative "as of now" reading),
 * never regressing below the current cursor. Using the probe snapshot — rather than the
 * max watermark of the fetched rows — is deliberately gap-free: any doc that arrived
 * AFTER the probe has a strictly-greater watermark than the probe (TransactionNo is
 * monotonic; the dates are "now" stamps), so it is not swallowed by this advance and is
 * caught on the next cycle. (Timestamp ties at the exact boundary are the one residual
 * edge, and are covered by the ≤60s full-reconcile safety net — see the plan.)
 */
export function nextCursorFromProbe(
  cursor: WatermarkCursorState,
  probe: Watermarks
): WatermarkCursorState {
  return {
    lastTxn: Math.max(cursor.lastTxn, probe.maxTxn),
    lastEntryAt: maxDate(cursor.lastEntryAt, probe.maxEntry),
    lastApprovedAt: maxDate(cursor.lastApprovedAt, probe.maxApproved),
    lastItemEntryAt: maxDate(cursor.lastItemEntryAt, probe.maxItemEntry),
    // Carry the OBSERVED row count verbatim — unlike the MAX watermarks there is NO
    // max()/monotonic guard, because a delete legitimately LOWERS the count and we must
    // track the exact current value to detect the NEXT change. A degenerate probe (<0)
    // is ignored so it never poisons the baseline to an un-comparable sentinel.
    lastItemCount: probe.itemCount < 0 ? cursor.lastItemCount : probe.itemCount,
  };
}

/** One changed (item, warehouse) pair discovered from a changed KRS document. Both codes
 *  are the trimmed KRS values (ItemCode == POS Product.sku; Warehouse == KRS WarehouseCode). */
export type KrsChangedPair = {
  itemCode: string;
  warehouseCode: string;
};

/**
 * The DISTINCT, sorted set of itemCodes touched this cycle: the union of the itemCodes
 * from the changed-doc (item, warehouse) pairs and any changed product-master itemCodes.
 * Trims, drops blanks, dedups. Sorted only for deterministic logging/tests. This is the
 * scope handed to the shared reconcile engine on the realtime path.
 */
export function collectItemCodes(
  pairs: KrsChangedPair[],
  itemCodes: string[] = []
): string[] {
  const set = new Set<string>();
  for (const p of pairs) {
    const code = p.itemCode.trim();
    if (code.length > 0) set.add(code);
  }
  for (const c of itemCodes) {
    const code = c.trim();
    if (code.length > 0) set.add(code);
  }
  return Array.from(set).sort();
}

/** The DISTINCT, sorted set of warehouseCodes touched this cycle (from the changed-doc
 *  pairs). Trims + drops blanks + dedups. Used only for the structured log line. */
export function collectWarehouseCodes(pairs: KrsChangedPair[]): string[] {
  const set = new Set<string>();
  for (const p of pairs) {
    const code = p.warehouseCode.trim();
    if (code.length > 0) set.add(code);
  }
  return Array.from(set).sort();
}

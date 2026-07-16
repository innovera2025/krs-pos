// PURE (no DB, no mssql) decision core for the KRS product ghost-reconciliation
// (17-07-26 incident). The KRS master DELETES obsolete ItemCodes, but the product
// import only creates/updates by sku — so deleted items lived on in POS as active
// "ghosts" (142 found on 17-07-26). This module computes WHICH krsManaged-and-active
// POS products have vanished from the latest KRS feed and must be deactivated, plus
// the fail-open + stock guards that mirror the one-time cleanup script
// (scripts/krs-ghost-products-cleanup.cjs). It is kept PURE so the mass-deactivation
// safety guards can be pinned by unit tests (like reconcileMath.ts), never touching
// the Prisma singleton. importProducts.ts owns the actual DB read/write.

/**
 * Fail-open threshold. If the latest KRS fetch returned FEWER records than
 * `RECONCILE_MIN_FETCH_RATIO` × (the current krsManaged-active universe), the fetch
 * is treated as partial/suspect and reconciliation is SKIPPED ENTIRELY — a partial
 * KRS read must NEVER mass-deactivate the catalogue. Mirrors the cleanup script's
 * GUARD 1 (`krsCodes.size < active.length * 0.6`).
 */
export const RECONCILE_MIN_FETCH_RATIO = 0.6;

/** A candidate POS product considered for ghost-reconciliation: a row that is
 *  currently `krsManaged = true` AND `isActive = true`. */
export type ReconcileCandidate = {
  id: string;
  sku: string;
  /** POS-owned on-hand. A vanished item is zero-stock by definition; a NON-zero
   *  ghost is anomalous and is left ACTIVE for manual review (see GUARD 2). */
  stock: number;
  /** Current barcode (freed to null on deactivation so the live KRS item can
   *  re-claim it — the holder-wins seeding the 17-07-26 incident depended on). */
  barcode: string | null;
};

/** The computed reconciliation plan (no writes performed here). */
export type GhostReconcilePlan = {
  /** true → the fetch was suspiciously small; SKIP reconciliation (fail-open). */
  skip: boolean;
  /** Candidate universe size (krsManaged-active count) used for the ratio guard. */
  candidateCount: number;
  /** Number of KRS records actually fetched this cycle (drives the ratio guard). */
  fetchedCount: number;
  /** ids of ZERO-STOCK ghosts to deactivate (isActive=false) + free their barcode. */
  ghostIds: string[];
  /** How many of the `ghostIds` had a non-null barcode that will be freed. */
  freedBarcodes: number;
  /** Ghosts that still HOLD stock (stock !== 0) — deliberately NOT deactivated;
   *  surfaced so the caller can warn for manual review (mirrors cleanup GUARD 2). */
  stockedGhosts: { id: string; sku: string; stock: number }[];
};

/**
 * Compute the ghost-reconciliation plan from the current krsManaged-active
 * candidates and the set of skus present in the latest KRS feed.
 *
 * Rules (mirror scripts/krs-ghost-products-cleanup.cjs):
 *  - GUARD 1 (fail-open): if `fetchedCount < candidates.length × 0.6`, return
 *    `skip = true` and touch nothing. A partial/failed KRS read must never
 *    mass-deactivate the catalogue.
 *  - A "ghost" is a candidate whose sku is NOT in `fetchedSkus` (it vanished from
 *    the KRS master — a deleted/deactivated ItemCode).
 *  - GUARD 2 (stock): only ZERO-STOCK ghosts are deactivated. A ghost with
 *    stock !== 0 is anomalous (a vanished item should be zero-stock); it is left
 *    ACTIVE and returned in `stockedGhosts` for manual review.
 *
 * @param candidates  krsManaged-and-active POS products.
 * @param fetchedSkus Set of skus present in the latest KRS product feed.
 * @param fetchedCount Number of records in the latest KRS feed (records.length) —
 *                     passed explicitly because a feed could carry duplicate skus,
 *                     and the ratio guard compares raw fetched volume, not distinct.
 */
export function planKrsGhostReconcile(
  candidates: ReconcileCandidate[],
  fetchedSkus: ReadonlySet<string>,
  fetchedCount: number
): GhostReconcilePlan {
  const candidateCount = candidates.length;

  // GUARD 1 — fail-open on a suspiciously small fetch. A zero-candidate universe
  // can never trip this (nothing to protect), and an empty fetch (fetchedCount 0)
  // with any candidates always skips.
  if (candidateCount > 0 && fetchedCount < candidateCount * RECONCILE_MIN_FETCH_RATIO) {
    return {
      skip: true,
      candidateCount,
      fetchedCount,
      ghostIds: [],
      freedBarcodes: 0,
      stockedGhosts: [],
    };
  }

  const ghosts = candidates.filter((c) => !fetchedSkus.has(c.sku));

  const ghostIds: string[] = [];
  let freedBarcodes = 0;
  const stockedGhosts: { id: string; sku: string; stock: number }[] = [];

  for (const g of ghosts) {
    // GUARD 2 — never deactivate a ghost that still holds stock (any non-zero,
    // positive over-count OR negative over-issue). Surface it for manual review.
    if (g.stock !== 0) {
      stockedGhosts.push({ id: g.id, sku: g.sku, stock: g.stock });
      continue;
    }
    ghostIds.push(g.id);
    if (g.barcode !== null) freedBarcodes += 1;
  }

  return {
    skip: false,
    candidateCount,
    fetchedCount,
    ghostIds,
    freedBarcodes,
    stockedGhosts,
  };
}

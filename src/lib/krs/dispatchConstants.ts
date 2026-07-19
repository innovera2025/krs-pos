// Shared KRS-dispatch constants (pure — NO imports, no mssql/Prisma). Split out of
// dispatcher.ts so a non-dispatcher caller (the orders VOID path) can reuse the SAME
// staleness window WITHOUT pulling the mssql driver into its module graph via dispatcher.ts.

/**
 * A dispatch lock older than this is stale (a crashed prior dispatch run) and is
 * re-claimable. The claim UPDATE stamps `lockedAt = NOW()`; anything older than this
 * window is treated as abandoned. The orders VOID path reuses this to decide whether a
 * PENDING/RETRYING SALE job it wants to neutralize is genuinely mid-flight (fresh lock →
 * back off) or safely claimable-by-nobody (null/stale lock → neutralize).
 */
export const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes

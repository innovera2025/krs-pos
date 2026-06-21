/**
 * Login rate-limiter (auth Phase 2).
 *
 * In-memory FIXED-WINDOW counter keyed by `ip:email`. It throttles repeated
 * failed sign-in attempts (credential-stuffing / brute force) at the Auth.js
 * `authorize` boundary (the Node runtime — middleware is edge and cannot do
 * this). Only FAILURES are counted; a successful sign-in clears the key.
 *
 * Scope: per-process and non-durable (a restart resets all counters). That is
 * acceptable for a single-store deployment; a Redis-backed limiter for
 * multi-instance is a future (Phase 3) concern. No new dependency — a plain Map
 * with a bounded size + lazy cleanup keeps memory from growing unbounded under a
 * distributed attack that varies the key.
 */

/** Max failed attempts allowed inside one live window before the key is locked. */
export const MAX_ATTEMPTS = 15;

/** Fixed-window length: 10 minutes. */
export const WINDOW_MS = 10 * 60 * 1000;

/**
 * Hard cap on distinct keys held at once. An attacker that varies ip:email could
 * otherwise grow the Map without bound; when the cap is hit we drop expired
 * entries first, and if still full, evict the oldest-started window.
 */
const MAX_KEYS = 10_000;

type Bucket = { count: number; windowStart: number };

const buckets = new Map<string, Bucket>();

/** True when the bucket's window has elapsed (so it should be reset, not counted). */
function isExpired(bucket: Bucket, now: number): boolean {
  return now - bucket.windowStart >= WINDOW_MS;
}

/**
 * Bound the Map. First sweep expired windows; if still at/over the cap, evict the
 * single entry with the oldest windowStart. Cheap and only runs when inserting a
 * brand-new key while at capacity.
 */
function enforceCap(now: number): void {
  if (buckets.size < MAX_KEYS) return;

  for (const [key, bucket] of buckets) {
    if (isExpired(bucket, now)) buckets.delete(key);
  }
  if (buckets.size < MAX_KEYS) return;

  let oldestKey: string | null = null;
  let oldestStart = Infinity;
  for (const [key, bucket] of buckets) {
    if (bucket.windowStart < oldestStart) {
      oldestStart = bucket.windowStart;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) buckets.delete(oldestKey);
}

/**
 * True when `key` has reached MAX_ATTEMPTS failures inside the current live
 * window. An expired window counts as not-limited (it will be reset on the next
 * recordFailure).
 */
export function isRateLimited(key: string): boolean {
  const bucket = buckets.get(key);
  if (!bucket) return false;
  const now = Date.now();
  if (isExpired(bucket, now)) return false;
  return bucket.count >= MAX_ATTEMPTS;
}

/**
 * Record one failed attempt for `key`. Starts a fresh window if none exists or
 * the previous one expired; otherwise increments the count in the live window.
 */
export function recordFailure(key: string): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || isExpired(bucket, now)) {
    enforceCap(now);
    buckets.set(key, { count: 1, windowStart: now });
    return;
  }
  bucket.count += 1;
}

/** Clear any recorded attempts for `key` (called on a successful sign-in). */
export function clearAttempts(key: string): void {
  buckets.delete(key);
}

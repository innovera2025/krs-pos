/**
 * Asia/Bangkok calendar helpers shared by the orders + shift APIs.
 *
 * Bangkok has a fixed +07:00 offset (no DST), so a calendar date's window is
 * [Bangkok-midnight − 7h, +24h) expressed as UTC instants. Computing the date in
 * Asia/Bangkok (not the process-local/UTC clock) keeps daily sequences (POS no.,
 * shift no.) and shift/day windows correct for an early-morning Thai sale.
 *
 * Extracted from orders/route.ts in Phase 5 so the shift route can reuse the same
 * logic — behavior is identical to the original inline helper.
 */

export const BANGKOK_TZ = "Asia/Bangkok";

/**
 * Resolve the Asia/Bangkok calendar date for an instant. Uses en-CA which
 * formats as `YYYY-MM-DD`, so the parts come back already zero-padded.
 */
export function bangkokDateParts(now: Date): { y: number; m: number; d: number } {
  const [yy, mm, dd] = new Intl.DateTimeFormat("en-CA", {
    timeZone: BANGKOK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .split("-");
  return { y: Number(yy), m: Number(mm), d: Number(dd) };
}

/** `YYYYMMDD` for the Asia/Bangkok calendar date of an instant. */
export function bangkokYyyymmdd(now: Date): string {
  const { y, m, d } = bangkokDateParts(now);
  return `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

/**
 * `YYYYMMDD` Bangkok day stamp used as the DailyOrderCounter primary key and the
 * `POS-<day>-<seq>` orderNumber prefix (Financial/Inventory correctness,
 * Sub-phase C). The day MUST be derived in Asia/Bangkok (not UTC/process-local)
 * so an early-morning Thai sale (e.g. 00:30 Bangkok = 17:30 UTC the previous day)
 * counts toward the correct Thai business day.
 *
 * Identical output to `bangkokYyyymmdd`; named explicitly so the collision-safe
 * counter path reads in domain terms ("the Bangkok day this order belongs to").
 */
export function bangkokDayStamp(now: Date): string {
  return bangkokYyyymmdd(now);
}

/**
 * Format the daily POS number from a Bangkok day stamp and an atomic sequence:
 * `POS-YYYYMMDD-####` with the sequence zero-padded to 4 (Sub-phase C). Pure —
 * unit-tested. Lives here (not in the orders route) because a Next.js route file
 * may only export route handlers; this is a reusable, testable pure helper.
 */
export function formatOrderNumber(day: string, seq: number): string {
  return `POS-${day}-${String(seq).padStart(4, "0")}`;
}

/**
 * Format the sequential tax-invoice number from a Bangkok calendar YEAR and an
 * atomic per-year sequence: `TAX-YYYY-NNNNNN` with the sequence zero-padded to 6
 * (Phase 4 — Thai full §86/4 invoice, owner decision D5). Matches the seeded
 * `TAX-2026-000418`. Pure — lives here (not in the route file) because a Next.js
 * route may only export route handlers; the year is fed from the Postgres
 * transaction clock at request-tax time (mirroring formatOrderNumber's day).
 */
export function formatTaxInvoiceNumber(year: string, seq: number): string {
  return `TAX-${year}-${String(seq).padStart(6, "0")}`;
}

/**
 * The UTC instant window [start, nextDay) covering the Asia/Bangkok calendar day
 * of `now`. UTC = Bangkok − 7h.
 */
export function bangkokDayWindow(now: Date): { startOfDay: Date; startOfNextDay: Date } {
  const { y, m, d } = bangkokDateParts(now);
  const startOfDay = new Date(Date.UTC(y, m - 1, d, -7, 0, 0, 0));
  const startOfNextDay = new Date(Date.UTC(y, m - 1, d + 1, -7, 0, 0, 0));
  return { startOfDay, startOfNextDay };
}

/**
 * Convert a browser `<input type="datetime-local">` value — "YYYY-MM-DDTHH:mm"
 * (optionally with ":ss") interpreted as an Asia/Bangkok WALL-CLOCK instant
 * (fixed +07:00, no DST) — into a UTC ISO instant string. Used by the Sales
 * History date+time range filter: the browser gives Bangkok wall-clock, but the
 * orders API filters on UTC `createdAt`, so the client converts here before it
 * sends `from`/`to`.
 *
 * Returns null for a malformed OR impossible date/time (bad shape, month > 12,
 * hour > 23, or a calendar overflow like 2026-02-30T10:00). Bangkok = UTC + 7h,
 * so the UTC instant is the wall-clock minus 7 hours; the result is round-tripped
 * through bangkokDateParts to reject overflow dates (Feb 30 → Mar 2 would not
 * round-trip). Pure — unit-tested.
 */
export function bangkokLocalInputToInstant(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value
  );
  if (!match) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const h = Number(match[4]);
  const mi = Number(match[5]);
  const s = match[6] ? Number(match[6]) : 0;
  // Field-range guard before the Date math so an out-of-range component (e.g.
  // hour 25, month 13) is rejected rather than silently normalized by Date.UTC.
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) {
    return null;
  }
  // Bangkok wall-clock is +07:00 → subtract 7h to get the UTC instant.
  const dt = new Date(Date.UTC(y, mo - 1, d, h - 7, mi, s, 0));
  if (Number.isNaN(dt.getTime())) return null;
  // Reject calendar overflow: the resulting instant's Bangkok date MUST equal the
  // input date (2026-02-30 would land on Mar 2 in Bangkok and fail this check).
  const parts = bangkokDateParts(dt);
  if (parts.y !== y || parts.m !== mo || parts.d !== d) return null;
  return dt.toISOString();
}

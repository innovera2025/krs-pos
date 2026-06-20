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
 * The UTC instant window [start, nextDay) covering the Asia/Bangkok calendar day
 * of `now`. UTC = Bangkok − 7h.
 */
export function bangkokDayWindow(now: Date): { startOfDay: Date; startOfNextDay: Date } {
  const { y, m, d } = bangkokDateParts(now);
  const startOfDay = new Date(Date.UTC(y, m - 1, d, -7, 0, 0, 0));
  const startOfNextDay = new Date(Date.UTC(y, m - 1, d + 1, -7, 0, 0, 0));
  return { startOfDay, startOfNextDay };
}

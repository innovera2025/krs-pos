import { describe, it, expect } from "vitest";
import {
  bangkokDayStamp,
  bangkokDayStringToWindow,
  bangkokYyyymmdd,
  formatOrderNumber,
} from "@/lib/datetime";

// ---------------------------------------------------------------------------
// Sub-phase C — collision-safe orderNumber helpers.
//
// bangkokDayStamp is the DailyOrderCounter primary key (one row per Asia/Bangkok
// calendar day) and the POS-<day>-<seq> prefix. The day MUST be computed in
// Asia/Bangkok (+07:00, no DST), so these pin the day-boundary behavior: an
// instant that is "yesterday" in UTC but "today" in Bangkok must stamp the
// Bangkok day. formatOrderNumber pins the zero-padded POS-YYYYMMDD-#### shape.
// ---------------------------------------------------------------------------

describe("bangkokDayStamp — Asia/Bangkok day boundary", () => {
  it("stamps the Bangkok calendar day (YYYYMMDD), not the UTC day", () => {
    // 2026-06-21 06:30 UTC = 2026-06-21 13:30 Bangkok → 20260621 both ways.
    const midday = new Date("2026-06-21T06:30:00.000Z");
    expect(bangkokDayStamp(midday)).toBe("20260621");
  });

  it("at Bangkok 00:00 (start of day) belongs to that Bangkok day", () => {
    // Bangkok 2026-06-21 00:00 = 2026-06-20 17:00 UTC. Despite being the 20th in
    // UTC, the Bangkok day is the 21st.
    const startOfBangkokDay = new Date("2026-06-20T17:00:00.000Z");
    expect(bangkokDayStamp(startOfBangkokDay)).toBe("20260621");
  });

  it("at Bangkok 23:59 (end of day) still belongs to that Bangkok day", () => {
    // Bangkok 2026-06-21 23:59 = 2026-06-21 16:59 UTC.
    const endOfBangkokDay = new Date("2026-06-21T16:59:00.000Z");
    expect(bangkokDayStamp(endOfBangkokDay)).toBe("20260621");
  });

  it("an instant just before Bangkok midnight rolls to the PREVIOUS Bangkok day", () => {
    // Bangkok 2026-06-20 23:59:59 = 2026-06-20 16:59:59 UTC → 20260620.
    const justBeforeMidnight = new Date("2026-06-20T16:59:59.000Z");
    expect(bangkokDayStamp(justBeforeMidnight)).toBe("20260620");
  });

  it("an early-morning Thai sale (00:30 Bangkok) does NOT roll onto the previous UTC day", () => {
    // Bangkok 2026-06-21 00:30 = 2026-06-20 17:30 UTC. UTC day is the 20th, but
    // the Thai business day is the 21st — the whole reason day math is in Bangkok.
    const earlyMorning = new Date("2026-06-20T17:30:00.000Z");
    expect(bangkokDayStamp(earlyMorning)).toBe("20260621");
  });

  it("crosses a month boundary in Bangkok correctly", () => {
    // Bangkok 2026-07-01 00:00 = 2026-06-30 17:00 UTC → 20260701.
    const newMonth = new Date("2026-06-30T17:00:00.000Z");
    expect(bangkokDayStamp(newMonth)).toBe("20260701");
  });

  it("is identical to bangkokYyyymmdd (same output, domain-named alias)", () => {
    const samples = [
      new Date("2026-06-20T16:59:59.000Z"),
      new Date("2026-06-20T17:00:00.000Z"),
      new Date("2026-06-21T06:30:00.000Z"),
      new Date("2026-12-31T17:00:00.000Z"),
    ];
    for (const d of samples) {
      expect(bangkokDayStamp(d)).toBe(bangkokYyyymmdd(d));
    }
  });
});

describe("formatOrderNumber — POS-YYYYMMDD-#### zero-padding", () => {
  it("zero-pads the sequence to 4 digits", () => {
    expect(formatOrderNumber("20260621", 1)).toBe("POS-20260621-0001");
    expect(formatOrderNumber("20260621", 7)).toBe("POS-20260621-0007");
    expect(formatOrderNumber("20260621", 42)).toBe("POS-20260621-0042");
    expect(formatOrderNumber("20260621", 999)).toBe("POS-20260621-0999");
  });

  it("keeps exactly 4 digits at the padding boundary (1000)", () => {
    expect(formatOrderNumber("20260621", 1000)).toBe("POS-20260621-1000");
  });

  it("does not truncate a sequence that exceeds 4 digits", () => {
    // padStart only pads, never truncates — a >9999 day stays full-width.
    expect(formatOrderNumber("20260621", 12345)).toBe("POS-20260621-12345");
  });

  it("composes with bangkokDayStamp end-to-end", () => {
    const now = new Date("2026-06-21T06:30:00.000Z");
    expect(formatOrderNumber(bangkokDayStamp(now), 3)).toBe(
      "POS-20260621-0003"
    );
  });
});

// ---------------------------------------------------------------------------
// Sales History range filter — bangkokDayStringToWindow.
//
// The two <input type="date"> fields give an Asia/Bangkok CALENDAR day
// ("YYYY-MM-DD"), but the orders API filters on UTC createdAt. Bangkok is a
// fixed +07:00 (no DST), so a calendar day maps to the half-open UTC window
// [Bangkok-00:00 − 7h, +24h). The client sends `from` → startOfDay (inclusive)
// and `to` → startOfNextDay (the EXCLUSIVE upper bound the API compares with
// `lt`). These pin that conversion, the single-day-covers-all-bills contract,
// and the malformed / calendar-overflow rejection (→ null).
// ---------------------------------------------------------------------------

describe("bangkokDayStringToWindow — Bangkok calendar day → UTC [start, nextStart)", () => {
  it("maps a day to Bangkok 00:00 (start) and the next Bangkok 00:00 (exclusive end)", () => {
    // Bangkok 2026-07-20 00:00 = 2026-07-19 17:00 UTC (−7h); next day start = +24h.
    const win = bangkokDayStringToWindow("2026-07-20");
    expect(win).not.toBeNull();
    expect(win!.startOfDay.toISOString()).toBe("2026-07-19T17:00:00.000Z");
    expect(win!.startOfNextDay.toISOString()).toBe("2026-07-20T17:00:00.000Z");
  });

  it("a single day (from=to=20/07) covers every bill of that Bangkok day", () => {
    // Screenshot case: bills at 20 ก.ค. 16:45 / 16:46 Bangkok must fall inside
    // [startOfDay, nextStart) when both fields pick 2026-07-20.
    const from = bangkokDayStringToWindow("2026-07-20")!.startOfDay.getTime();
    const to = bangkokDayStringToWindow("2026-07-20")!.startOfNextDay.getTime();
    // 20 ก.ค. 16:45 Bangkok = 2026-07-20 09:45 UTC; 16:46 = 09:46 UTC.
    const bill1645 = new Date("2026-07-20T09:45:00.000Z").getTime();
    const bill1646 = new Date("2026-07-20T09:46:00.000Z").getTime();
    expect(bill1645).toBeGreaterThanOrEqual(from);
    expect(bill1645).toBeLessThan(to);
    expect(bill1646).toBeGreaterThanOrEqual(from);
    expect(bill1646).toBeLessThan(to);
  });

  it("the exclusive end excludes the very first instant of the next Bangkok day", () => {
    // Bangkok 2026-07-21 00:00 = 2026-07-20 17:00 UTC = startOfNextDay → NOT < to.
    const to = bangkokDayStringToWindow("2026-07-20")!.startOfNextDay.getTime();
    const nextDayStart = new Date("2026-07-20T17:00:00.000Z").getTime();
    expect(nextDayStart).toBe(to);
    expect(nextDayStart).not.toBeLessThan(to);
  });

  it("the window spans exactly 24h (Bangkok has no DST)", () => {
    const win = bangkokDayStringToWindow("2026-07-20")!;
    const DAY_MS = 24 * 60 * 60 * 1000;
    expect(win.startOfNextDay.getTime() - win.startOfDay.getTime()).toBe(DAY_MS);
  });

  it("crosses a month boundary correctly", () => {
    // Bangkok 2026-07-01 00:00 = 2026-06-30 17:00 UTC; next start = 2026-07-01 17:00 UTC.
    const win = bangkokDayStringToWindow("2026-07-01")!;
    expect(win.startOfDay.toISOString()).toBe("2026-06-30T17:00:00.000Z");
    expect(win.startOfNextDay.toISOString()).toBe("2026-07-01T17:00:00.000Z");
  });

  it("crosses a year boundary correctly (Dec 31 → Jan 1)", () => {
    // Bangkok 2026-12-31 00:00 = 2026-12-30 17:00 UTC; next start = 2026-12-31 17:00 UTC.
    const win = bangkokDayStringToWindow("2026-12-31")!;
    expect(win.startOfDay.toISOString()).toBe("2026-12-30T17:00:00.000Z");
    expect(win.startOfNextDay.toISOString()).toBe("2026-12-31T17:00:00.000Z");
  });

  it("startOfDay belongs to the requested Bangkok business day", () => {
    const win = bangkokDayStringToWindow("2026-07-20")!;
    expect(bangkokDayStamp(win.startOfDay)).toBe("20260720");
  });

  it("returns null for a malformed shape (not YYYY-MM-DD)", () => {
    expect(bangkokDayStringToWindow("")).toBeNull();
    expect(bangkokDayStringToWindow("2026-07")).toBeNull();
    expect(bangkokDayStringToWindow("2026-07-20T14:30")).toBeNull();
    expect(bangkokDayStringToWindow("not-a-date")).toBeNull();
    expect(bangkokDayStringToWindow("2026/07/20")).toBeNull();
  });

  it("returns null for out-of-range components (month 13, day 0)", () => {
    expect(bangkokDayStringToWindow("2026-13-01")).toBeNull();
    expect(bangkokDayStringToWindow("2026-07-00")).toBeNull();
    expect(bangkokDayStringToWindow("2026-07-32")).toBeNull();
  });

  it("returns null for an impossible calendar date (2026-02-30)", () => {
    // Feb 30 would normalize to Mar 2 in Date.UTC → the round-trip guard rejects it.
    expect(bangkokDayStringToWindow("2026-02-30")).toBeNull();
  });
});

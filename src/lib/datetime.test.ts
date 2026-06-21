import { describe, it, expect } from "vitest";
import {
  bangkokDayStamp,
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

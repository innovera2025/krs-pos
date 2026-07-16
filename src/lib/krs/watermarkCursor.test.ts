// PURE unit tests for the KRS realtime-inbound watermark cursor logic (krs-realtime-inbound
// P1). No mssql, no DB — this is exactly why `watermarkCursor.ts` is kept free of the driver.
// These tests pin the "did anything move?" gate (the every-2s hot-path decision), the
// gap-free cursor advance, and the itemCode/warehouse set extraction the realtime scope
// depends on.

import { describe, it, expect } from "vitest";
import {
  ZERO_CURSOR,
  isFreshCursor,
  watermarksAdvanced,
  itemMasterAdvanced,
  nextCursorFromProbe,
  collectItemCodes,
  collectWarehouseCodes,
  type Watermarks,
  type WatermarkCursorState,
} from "./watermarkCursor";

/** A date factory for readable, ordered timestamps in the assertions. */
const at = (iso: string) => new Date(iso);

const T0 = at("2026-07-16T10:00:00.000Z");
const T1 = at("2026-07-16T10:00:02.000Z");
const T2 = at("2026-07-16T10:00:04.000Z");

/** A settled cursor that has already observed some activity. */
const settledCursor: WatermarkCursorState = {
  lastTxn: 20,
  lastEntryAt: T1,
  lastApprovedAt: T1,
  lastItemEntryAt: T0,
};

/** A probe that observed exactly the settled cursor's values (nothing moved). */
const settledProbe: Watermarks = {
  maxTxn: 20,
  maxEntry: T1,
  maxApproved: T1,
  maxItemEntry: T0,
};

describe("isFreshCursor", () => {
  it("is true for the ZERO_CURSOR (first run / re-init)", () => {
    expect(isFreshCursor(ZERO_CURSOR)).toBe(true);
  });

  it("is false once any watermark has been observed", () => {
    expect(isFreshCursor({ ...ZERO_CURSOR, lastTxn: 1 })).toBe(false);
    expect(isFreshCursor({ ...ZERO_CURSOR, lastEntryAt: T0 })).toBe(false);
    expect(isFreshCursor({ ...ZERO_CURSOR, lastApprovedAt: T0 })).toBe(false);
    expect(isFreshCursor({ ...ZERO_CURSOR, lastItemEntryAt: T0 })).toBe(false);
    expect(isFreshCursor(settledCursor)).toBe(false);
  });
});

describe("watermarksAdvanced", () => {
  it("is false when the probe exactly matches the cursor (the idle 2s hot path)", () => {
    expect(watermarksAdvanced(settledCursor, settledProbe)).toBe(false);
  });

  it("detects a new document via a strictly-greater TransactionNo", () => {
    expect(watermarksAdvanced(settledCursor, { ...settledProbe, maxTxn: 21 })).toBe(true);
  });

  it("does NOT advance on an equal TransactionNo (strict >, no re-processing the boundary)", () => {
    expect(watermarksAdvanced(settledCursor, { ...settledProbe, maxTxn: 20 })).toBe(false);
  });

  it("detects a newly-created document via a later EntryDate", () => {
    expect(watermarksAdvanced(settledCursor, { ...settledProbe, maxEntry: T2 })).toBe(true);
  });

  it("detects a late APPROVAL (ApprovedDate moved, no new TransactionNo)", () => {
    expect(watermarksAdvanced(settledCursor, { ...settledProbe, maxApproved: T2 })).toBe(true);
  });

  it("detects a new product-master row via a later item EntryDate", () => {
    expect(watermarksAdvanced(settledCursor, { ...settledProbe, maxItemEntry: T2 })).toBe(true);
  });

  it("treats a first non-null sighting of a date signal as advanced (self-heal from null)", () => {
    const cursorNoApprovals: WatermarkCursorState = { ...settledCursor, lastApprovedAt: null };
    expect(
      watermarksAdvanced(cursorNoApprovals, { ...settledProbe, maxApproved: T2 })
    ).toBe(true);
  });

  it("does not advance when a date signal stays null on both sides", () => {
    const cursorNoApprovals: WatermarkCursorState = { ...settledCursor, lastApprovedAt: null };
    expect(
      watermarksAdvanced(cursorNoApprovals, { ...settledProbe, maxApproved: null })
    ).toBe(false);
  });

  it("always advances from a fresh (zero) cursor when the server has any activity", () => {
    expect(
      watermarksAdvanced(ZERO_CURSOR, { maxTxn: 20, maxEntry: T1, maxApproved: T1, maxItemEntry: T0 })
    ).toBe(true);
  });

  it("does NOT advance from a fresh cursor against a totally-empty server", () => {
    expect(
      watermarksAdvanced(ZERO_CURSOR, { maxTxn: 0, maxEntry: null, maxApproved: null, maxItemEntry: null })
    ).toBe(false);
  });
});

describe("itemMasterAdvanced", () => {
  it("is true only when the InventoryItem.EntryDate watermark moved", () => {
    expect(itemMasterAdvanced(settledCursor, { ...settledProbe, maxItemEntry: T2 })).toBe(true);
    expect(itemMasterAdvanced(settledCursor, { ...settledProbe, maxTxn: 99 })).toBe(false);
    expect(itemMasterAdvanced(settledCursor, settledProbe)).toBe(false);
  });
});

describe("nextCursorFromProbe", () => {
  it("advances every watermark to the probe snapshot", () => {
    const probe: Watermarks = { maxTxn: 25, maxEntry: T2, maxApproved: T2, maxItemEntry: T1 };
    const next = nextCursorFromProbe(settledCursor, probe);
    expect(next.lastTxn).toBe(25);
    expect(next.lastEntryAt).toEqual(T2);
    expect(next.lastApprovedAt).toEqual(T2);
    expect(next.lastItemEntryAt).toEqual(T1);
  });

  it("never regresses a watermark below the current cursor (defensive against a lower probe)", () => {
    const lowerProbe: Watermarks = { maxTxn: 5, maxEntry: T0, maxApproved: null, maxItemEntry: null };
    const next = nextCursorFromProbe(settledCursor, lowerProbe);
    expect(next.lastTxn).toBe(20); // kept the higher cursor value
    expect(next.lastEntryAt).toEqual(T1);
    expect(next.lastApprovedAt).toEqual(T1);
    expect(next.lastItemEntryAt).toEqual(T0);
  });

  it("adopts a probe's first non-null date when the cursor had null", () => {
    const cursor: WatermarkCursorState = { ...ZERO_CURSOR, lastTxn: 3 };
    const probe: Watermarks = { maxTxn: 4, maxEntry: T1, maxApproved: T1, maxItemEntry: T0 };
    const next = nextCursorFromProbe(cursor, probe);
    expect(next.lastTxn).toBe(4);
    expect(next.lastEntryAt).toEqual(T1);
    expect(next.lastApprovedAt).toEqual(T1);
    expect(next.lastItemEntryAt).toEqual(T0);
  });

  it("round-trips: advancing to a probe then re-comparing shows no further advance", () => {
    const probe: Watermarks = { maxTxn: 30, maxEntry: T2, maxApproved: T2, maxItemEntry: T2 };
    const next = nextCursorFromProbe(settledCursor, probe);
    expect(watermarksAdvanced(next, probe)).toBe(false);
  });
});

describe("collectItemCodes", () => {
  it("extracts a distinct, sorted, trimmed set from the changed-doc pairs", () => {
    const pairs = [
      { itemCode: "F01-0002", warehouseCode: "WH01" },
      { itemCode: "F01-0001", warehouseCode: "WH01" },
      { itemCode: "F01-0001", warehouseCode: "WH02" }, // same item, other warehouse → dedup
    ];
    expect(collectItemCodes(pairs)).toEqual(["F01-0001", "F01-0002"]);
  });

  it("merges the changed product-master itemCodes and dedups across both sources", () => {
    const pairs = [{ itemCode: "F01-0001", warehouseCode: "WH01" }];
    const changedItems = ["F01-0003", "F01-0001"]; // F01-0001 overlaps the pair
    expect(collectItemCodes(pairs, changedItems)).toEqual(["F01-0001", "F01-0003"]);
  });

  it("trims padding and drops blank codes", () => {
    const pairs = [
      { itemCode: "  F01-0009  ", warehouseCode: "WH01" },
      { itemCode: "   ", warehouseCode: "WH01" },
    ];
    expect(collectItemCodes(pairs, ["", "  F01-0010 "])).toEqual(["F01-0009", "F01-0010"]);
  });

  it("returns an empty array for no input", () => {
    expect(collectItemCodes([])).toEqual([]);
  });
});

describe("collectWarehouseCodes", () => {
  it("extracts a distinct, sorted, trimmed set of warehouse codes", () => {
    const pairs = [
      { itemCode: "F01-0001", warehouseCode: "WH02" },
      { itemCode: "F01-0002", warehouseCode: "WH01" },
      { itemCode: "F01-0003", warehouseCode: "WH02" }, // dup warehouse
      { itemCode: "F01-0004", warehouseCode: "  " }, // blank → dropped
    ];
    expect(collectWarehouseCodes(pairs)).toEqual(["WH01", "WH02"]);
  });
});

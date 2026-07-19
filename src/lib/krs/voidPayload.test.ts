// PURE unit tests for parseVoidPayload (krs-void-writeback). This validator gates the
// VOID outbox payload at the dispatcher's input boundary — it moves real ERP documents +
// POS stock — so its lenient-vs-structural behavior is pinned here (no DB, no mssql).

import { describe, it, expect } from "vitest";
import { parseVoidPayload } from "./voidPayload";

const full = {
  orderNumber: "POS-20260719-0001",
  warehouseCode: "WH01",
  requestedBy: "cashier@example.com",
  requestedAt: "2026-07-19T10:00:00.000Z",
  items: [
    { itemCode: "SKU-1", qty: 2 },
    { itemCode: "SKU-2", qty: 1 },
  ],
  saleRef: {
    transactionNo: "12345",
    saleVoucherNo: "SC-2607-0023",
    flowTxnNo: "67890",
    flowVoucherNo: "OSL-2607-0023",
  },
};

describe("parseVoidPayload — happy path", () => {
  it("parses a full, well-formed payload verbatim", () => {
    const p = parseVoidPayload(full);
    expect(p.orderNumber).toBe("POS-20260719-0001");
    expect(p.warehouseCode).toBe("WH01");
    expect(p.requestedBy).toBe("cashier@example.com");
    expect(p.requestedAt).toBe("2026-07-19T10:00:00.000Z");
    expect(p.items).toEqual([
      { itemCode: "SKU-1", qty: 2 },
      { itemCode: "SKU-2", qty: 1 },
    ]);
    expect(p.saleRef).toEqual({
      transactionNo: "12345",
      saleVoucherNo: "SC-2607-0023",
      flowTxnNo: "67890",
      flowVoucherNo: "OSL-2607-0023",
    });
  });

  it("strips extra item keys to just { itemCode, qty }", () => {
    const p = parseVoidPayload({
      ...full,
      items: [{ itemCode: "SKU-9", qty: 3, description: "junk", extra: true }],
    });
    expect(p.items).toEqual([{ itemCode: "SKU-9", qty: 3 }]);
  });
});

describe("parseVoidPayload — lenient defaults", () => {
  it("defaults a missing requestedBy to an empty string (writes blank IsClosedBy)", () => {
    const { requestedBy: _omit, ...noBy } = full;
    void _omit;
    expect(parseVoidPayload(noBy).requestedBy).toBe("");
  });

  it("defaults a non-string requestedBy to an empty string", () => {
    expect(parseVoidPayload({ ...full, requestedBy: 42 }).requestedBy).toBe("");
  });

  it("treats a missing saleRef as an all-undefined fallback (empty ref)", () => {
    const { saleRef: _omit, ...noRef } = full;
    void _omit;
    expect(parseVoidPayload(noRef).saleRef).toEqual({
      transactionNo: undefined,
      saleVoucherNo: undefined,
      flowTxnNo: undefined,
      flowVoucherNo: undefined,
    });
  });

  it("treats a non-object saleRef as an empty ref", () => {
    expect(parseVoidPayload({ ...full, saleRef: "nope" }).saleRef.saleVoucherNo).toBeUndefined();
  });

  it("keeps only the string saleRef fields present, dropping non-strings", () => {
    const p = parseVoidPayload({
      ...full,
      saleRef: { saleVoucherNo: "SC-2607-0099", flowVoucherNo: 123 },
    });
    expect(p.saleRef.saleVoucherNo).toBe("SC-2607-0099");
    expect(p.saleRef.flowVoucherNo).toBeUndefined();
    expect(p.saleRef.transactionNo).toBeUndefined();
  });
});

describe("parseVoidPayload — structural failures throw", () => {
  it("throws when value is not an object", () => {
    expect(() => parseVoidPayload("x")).toThrow(/not an object/);
    expect(() => parseVoidPayload(null)).toThrow(/not an object/);
    expect(() => parseVoidPayload(42)).toThrow(/not an object/);
  });

  it("throws on a missing/empty orderNumber", () => {
    expect(() => parseVoidPayload({ ...full, orderNumber: "" })).toThrow(/orderNumber/);
    const { orderNumber: _o, ...no } = full;
    void _o;
    expect(() => parseVoidPayload(no)).toThrow(/orderNumber/);
  });

  it("throws on a missing warehouseCode", () => {
    const { warehouseCode: _w, ...no } = full;
    void _w;
    expect(() => parseVoidPayload(no)).toThrow(/warehouseCode/);
  });

  it("throws on a missing requestedAt", () => {
    const { requestedAt: _r, ...no } = full;
    void _r;
    expect(() => parseVoidPayload(no)).toThrow(/requestedAt/);
  });

  it("throws on an empty or non-array items", () => {
    expect(() => parseVoidPayload({ ...full, items: [] })).toThrow(/non-empty array/);
    expect(() => parseVoidPayload({ ...full, items: "nope" })).toThrow(/non-empty array/);
  });

  it("throws when an item is not an object or lacks an itemCode", () => {
    expect(() => parseVoidPayload({ ...full, items: [null] })).toThrow(/items\[0\]/);
    expect(() => parseVoidPayload({ ...full, items: [{ qty: 1 }] })).toThrow(/itemCode/);
    expect(() => parseVoidPayload({ ...full, items: [{ itemCode: "", qty: 1 }] })).toThrow(/itemCode/);
  });

  it("throws when qty is not a positive integer", () => {
    expect(() => parseVoidPayload({ ...full, items: [{ itemCode: "A", qty: 0 }] })).toThrow(/positive integer/);
    expect(() => parseVoidPayload({ ...full, items: [{ itemCode: "A", qty: -2 }] })).toThrow(/positive integer/);
    expect(() => parseVoidPayload({ ...full, items: [{ itemCode: "A", qty: 1.5 }] })).toThrow(/positive integer/);
    expect(() => parseVoidPayload({ ...full, items: [{ itemCode: "A", qty: "3" }] })).toThrow(/positive integer/);
  });
});

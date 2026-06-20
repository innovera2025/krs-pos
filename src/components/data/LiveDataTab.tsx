"use client";

import { useState } from "react";
import type { SyncJobDTO } from "@/types";
import { jobTypeLabel } from "./syncMeta";

/**
 * Live Data tab (KRS Data Link). A read-only KRS browser: a 6-table selector
 * (sales/sale_items/products/stock_movements/sync_jobs/users), a SQL-preview pill,
 * synthetic per-table rows, a green-highlighted "just inserted" sales row (fed by
 * the Connection tab's insertTestRow counter), and a row-count footer. Static
 * synthetic data (decision D) — there is no real KRS read; sync_jobs mirrors the
 * live fetched jobs so the tab reflects retry/skip/pull actions.
 */

type TableKey =
  | "sales"
  | "sale_items"
  | "products"
  | "stock_movements"
  | "sync_jobs"
  | "users";

type TableMeta = { label: string; cols: string[]; count: number };

const TABLE_META: Record<TableKey, TableMeta> = {
  sales: { label: "sales", cols: ["id", "pos_no", "total", "vat", "sync_status", "created_at"], count: 1248 },
  sale_items: { label: "sale_items", cols: ["id", "sale_id", "sku", "qty", "unit_price", "line_total"], count: 3892 },
  products: { label: "products", cols: ["id", "sku", "name", "price", "vat", "stock"], count: 17 },
  stock_movements: { label: "stock_movements", cols: ["id", "sku", "type", "qty", "ref", "created_at"], count: 642 },
  sync_jobs: { label: "sync_jobs", cols: ["id", "type", "ref", "status", "provider", "updated_at"], count: 8 },
  users: { label: "users", cols: ["id", "name", "email", "role", "status", "last_login"], count: 3 },
};

const TABLE_KEYS: TableKey[] = [
  "sales",
  "sale_items",
  "products",
  "stock_movements",
  "sync_jobs",
  "users",
];

type Row = { cells: string[]; fresh: boolean };

// Static synthetic rows (transcribed from the Simple POS dbVals builders).
const STATIC_ROWS: Record<Exclude<TableKey, "sales" | "sync_jobs">, string[][]> = {
  sale_items: [
    ["5031", "1041", "BV-002", "2", "65.00", "130.00"],
    ["5030", "1041", "FD-001", "1", "75.00", "75.00"],
    ["5029", "1040", "BV-005", "2", "45.00", "90.00"],
    ["5028", "1040", "DS-001", "1", "65.00", "65.00"],
    ["5027", "1039", "BV-006", "1", "70.00", "70.00"],
    ["5026", "1039", "GD-001", "1", "350.00", "350.00"],
  ],
  products: [
    ["p1", "BV-001", "อเมริกาโน่ (ร้อน)", "55.00", "7", "120"],
    ["p2", "BV-002", "ลาเต้ (ร้อน)", "65.00", "7", "88"],
    ["p3", "BV-003", "คาปูชิโน่", "65.00", "7", "64"],
    ["p8", "FD-001", "ครัวซองต์แฮมชีส", "75.00", "7", "14"],
    ["p12", "DS-001", "บราวนี่", "65.00", "7", "32"],
    ["p15", "GD-001", "เมล็ดกาแฟคั่ว 250g", "350.00", "7", "9"],
  ],
  stock_movements: [
    ["9043", "BV-001", "sale", "-1", "POS-20260616-0041", "2026-06-16 13:58"],
    ["9042", "DS-001", "receive", "+40", "GRN-20260616-007", "2026-06-16 10:42"],
    ["9041", "BV-002", "adjust", "-5", "ADJ-20260616-012", "2026-06-16 09:30"],
    ["9040", "FD-001", "sale", "-2", "POS-20260616-0040", "2026-06-16 13:42"],
    ["9039", "GD-001", "sale", "-1", "POS-20260616-0039", "2026-06-16 13:20"],
  ],
  users: [
    ["u1", "Admin", "admin@krs-pos.local", "admin", "active", "2026-06-16 08:30"],
    ["u2", "อรุณ ขายดี", "seller.aroon@krs-pos.local", "seller", "active", "2026-06-16 09:05"],
    ["u3", "มาลี พักงาน", "seller.malee@krs-pos.local", "seller", "inactive", "—"],
  ],
};

const STATIC_SALES: string[][] = [
  ["1041", "POS-20260616-0041", "962.30", "62.94", "synced", "2026-06-16 13:58"],
  ["1040", "POS-20260616-0040", "130.00", "8.50", "daily", "2026-06-16 13:42"],
  ["1039", "POS-20260616-0039", "240.00", "15.70", "failed", "2026-06-16 13:20"],
  ["1038", "POS-20260616-0038", "-65.00", "-4.25", "synced", "2026-06-16 12:50"],
  ["1037", "POS-20260616-0037", "0.00", "0.00", "skipped", "2026-06-16 12:31"],
  ["1036", "POS-20260616-0036", "185.00", "12.10", "daily", "2026-06-16 11:58"],
];

export function LiveDataTab({
  jobs,
  insertedCount,
  lastInsert,
}: {
  jobs: SyncJobDTO[];
  /** Session test-INSERT count from the Connection tab — feeds the green rows. */
  insertedCount: number;
  /** Display timestamp of the last test INSERT (or null). */
  lastInsert: string | null;
}) {
  const [table, setTable] = useState<TableKey>("sales");
  const meta = TABLE_META[table];

  const rows = buildRows(table, jobs, insertedCount, lastInsert);

  return (
    <div className="overflow-hidden rounded-2xl border" style={{ background: "#fff", borderColor: "#e8edf3" }}>
      <div className="flex items-center gap-[10px] border-b px-5 py-4" style={{ borderColor: "#f1f5f9" }}>
        <div>
          <div className="text-[14.5px] font-bold">ตรวจข้อมูลที่เชื่อมอยู่ · Live data</div>
          <div className="text-[11.5px]" style={{ color: "#94a3b8" }}>
            ดึงข้อมูลจริงจาก KRS.krs_pos — อ่านอย่างเดียว (read-only)
          </div>
        </div>
        <div className="flex-1" />
        <div className="mono rounded-[8px] px-[11px] py-1.5 text-[11.5px]" style={{ background: "#f1f5f9", color: "#64748b" }}>
          SELECT * FROM {meta.label} LIMIT 50
        </div>
      </div>

      <div className="flex min-h-0">
        {/* Table selector */}
        <div className="flex w-[230px] shrink-0 flex-col gap-[7px] border-r p-3" style={{ borderColor: "#f1f5f9" }}>
          <div className="px-1 pb-1 pt-0.5 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "#94a3b8" }}>
            KRS Tables
          </div>
          {TABLE_KEYS.map((k) => {
            const tm = TABLE_META[k];
            const active = table === k;
            const liveCount = k === "sync_jobs" ? jobs.length : k === "sales" ? tm.count + insertedCount : tm.count;
            return (
              <button
                key={k}
                type="button"
                aria-pressed={active}
                onClick={() => setTable(k)}
                className="flex items-center justify-between gap-[10px] rounded-[10px] border px-[13px] py-[10px] transition hover:border-[#cbd5e1]"
                style={{ background: active ? "#eff6ff" : "#fff", borderColor: active ? "#2563eb" : "#eaeef3" }}
              >
                <span className="mono text-[12.5px] font-semibold" style={{ color: "#334155" }}>
                  {tm.label}
                </span>
                <span className="mono text-[11px]" style={{ color: "#94a3b8" }}>
                  {liveCount.toLocaleString("en-US")}
                </span>
              </button>
            );
          })}
        </div>

        {/* Rows */}
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div style={{ minWidth: 640 }}>
            <div
              className="sticky top-0 flex border-b px-4 py-[11px]"
              style={{ borderColor: "#eef2f6", background: "#fafbfc" }}
            >
              {meta.cols.map((c) => (
                <div key={c} className="mono min-w-0 flex-1 text-[11px] font-semibold" style={{ color: "#94a3b8" }}>
                  {c}
                </div>
              ))}
            </div>
            {rows.map((r, i) => (
              <div
                key={i}
                className="flex border-b px-4 py-[10px]"
                style={{ borderColor: "#f4f7fa", background: r.fresh ? "#f0fdf4" : "transparent" }}
              >
                {r.cells.map((cell, ci) => (
                  <div
                    key={ci}
                    className="mono min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap pr-2 text-[11.5px]"
                    style={{ color: "#334155" }}
                  >
                    {cell}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-t px-5 py-[11px] text-[11.5px]" style={{ borderColor: "#f1f5f9", color: "#94a3b8" }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: "#16a34a" }} />
        แสดง {rows.length} แถวจาก KRS · แถวเขียว = เพิ่งถูก INSERT
      </div>
    </div>
  );
}

function buildRows(
  table: TableKey,
  jobs: SyncJobDTO[],
  insertedCount: number,
  lastInsert: string | null
): Row[] {
  if (table === "sales") {
    const fresh: Row[] = [];
    // The just-inserted test rows (green) — capped at 3, newest first.
    for (let i = 0; i < Math.min(insertedCount, 3); i++) {
      const seq = 43 + insertedCount - i;
      fresh.push({
        cells: [
          String(1248 + insertedCount - i),
          `POS-20260616-${String(seq).padStart(4, "0")}`,
          "—",
          "—",
          "pending",
          lastInsert ?? "2026-06-16 14:25",
        ],
        fresh: true,
      });
    }
    return [...fresh, ...STATIC_SALES.map((c) => ({ cells: c, fresh: false }))];
  }
  if (table === "sync_jobs") {
    return jobs.slice(0, 8).map((j) => ({
      cells: [
        j.id,
        jobTypeLabel(j.type),
        j.ref,
        j.status.toLowerCase(),
        j.provider,
        new Date(j.updatedAt).toLocaleString("en-CA", {
          timeZone: "Asia/Bangkok",
          hour12: false,
        }).replace(",", ""),
      ],
      fresh: false,
    }));
  }
  return STATIC_ROWS[table].map((c) => ({ cells: c, fresh: false }));
}

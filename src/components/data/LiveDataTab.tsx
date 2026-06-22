"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Live Data tab (KRS Data Link) — a REAL read-only browser over the live KRS
 * database (krs-sync schema browser). On mount it GETs `/api/krs/schema` to list
 * EVERY base table (the real `db_ACC_SNP` has ~238); a search box filters that list.
 * Selecting a table GETs `/api/krs/schema?table=X` to show that table's columns
 * (name / type / nullable) + a capped sample (`SELECT TOP 50 *`) on the right.
 *
 * Admin-only: the /data page is AdminOnly-wrapped and the route is requireAdmin
 * server-side. This component renders nothing sensitive of its own — it only shows
 * what the admin-gated endpoint returns. "KRS not configured" is handled gracefully
 * (a prompt to configure on the Connection tab). All values come straight from the
 * server (already JSON-sanitized — binary columns show a "<binary N bytes>"
 * placeholder, dates are ISO strings).
 *
 * Taste visual language: forest/mint accents, IBM Plex Sans Thai, Thai-first
 * microcopy, restrained borders. Mirrors the loading/empty/error tri-state used on
 * /pos /products /sales.
 */

type TableSummary = { schema: string; name: string; columns: number };

type ColumnMeta = {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
};

type TableDetail = {
  schema: string;
  name: string;
  columns: ColumnMeta[];
  sample: Record<string, unknown>[];
};

type ListResponse =
  | { configured: false }
  | { configured: true; tables: TableSummary[] }
  | { configured: true; tables: null; error: string };

type DetailResponse =
  | { configured: true; table: TableDetail }
  | { configured: false; error: string }
  | { error: string };

/** Top-level list state (tri-state + "not configured"). */
type ListState =
  | { status: "loading" }
  | { status: "not-configured" }
  | { status: "error"; message: string }
  | { status: "ready"; tables: TableSummary[] };

/** Per-table detail state (tri-state). */
type DetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; detail: TableDetail };

export function LiveDataTab() {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ status: "idle" });

  // ---- Load the full table list on mount ----
  useEffect(() => {
    let mounted = true;
    setList({ status: "loading" });
    fetch("/api/krs/schema")
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as ListResponse | null;
        if (!mounted) return;
        if (!res.ok || data === null) {
          setList({ status: "error", message: "โหลดรายการตารางไม่สำเร็จ · could not load tables" });
          return;
        }
        if (data.configured === false) {
          setList({ status: "not-configured" });
          return;
        }
        if (data.tables === null) {
          setList({ status: "error", message: data.error || "อ่านสคีมาไม่สำเร็จ" });
          return;
        }
        setList({ status: "ready", tables: data.tables });
      })
      .catch(() => {
        if (mounted) {
          setList({ status: "error", message: "โหลดรายการตารางไม่สำเร็จ · could not load tables" });
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  // ---- Load one table's detail when selected ----
  useEffect(() => {
    if (selected === null) {
      setDetail({ status: "idle" });
      return;
    }
    let mounted = true;
    setDetail({ status: "loading" });
    fetch(`/api/krs/schema?table=${encodeURIComponent(selected)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as DetailResponse | null;
        if (!mounted) return;
        if (!res.ok || data === null || !("table" in data)) {
          const message =
            data && "error" in data && data.error
              ? data.error
              : "อ่านตารางไม่สำเร็จ · could not read table";
          setDetail({ status: "error", message });
          return;
        }
        setDetail({ status: "ready", detail: data.table });
      })
      .catch(() => {
        if (mounted) {
          setDetail({ status: "error", message: "อ่านตารางไม่สำเร็จ · could not read table" });
        }
      });
    return () => {
      mounted = false;
    };
  }, [selected]);

  const tables = list.status === "ready" ? list.tables : [];
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length === 0) return tables;
    return tables.filter(
      (t) =>
        t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q)
    );
  }, [tables, search]);

  return (
    <div className="overflow-hidden rounded-2xl border" style={{ background: "#fff", borderColor: "#e8edf3" }}>
      {/* Header */}
      <div className="flex items-center gap-[10px] border-b px-5 py-4" style={{ borderColor: "#f1f5f9" }}>
        <div className="min-w-0">
          <div className="text-[14.5px] font-bold">ตรวจข้อมูลที่เชื่อมอยู่ · Live data</div>
          <div className="text-[11.5px]" style={{ color: "#94a3b8" }}>
            เรียกดูทุกตารางจาก KRS โดยตรง — อ่านอย่างเดียว (read-only)
          </div>
        </div>
        <div className="flex-1" />
        {list.status === "ready" ? (
          <div
            className="mono rounded-[8px] px-[11px] py-1.5 text-[11.5px]"
            style={{ background: "#f1f5f9", color: "#64748b" }}
          >
            {tables.length.toLocaleString("en-US")} tables
          </div>
        ) : null}
      </div>

      {/* Not configured */}
      {list.status === "not-configured" ? (
        <div className="px-5 py-10 text-center">
          <div className="text-[13.5px] font-semibold" style={{ color: "#334155" }}>
            ยังไม่ได้ตั้งค่าการเชื่อมต่อ KRS
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "#94a3b8" }}>
            ไปที่แท็บ “เชื่อมต่อ · Connection” เพื่อตั้งค่าและทดสอบการเชื่อมต่อก่อน
          </div>
        </div>
      ) : null}

      {/* Error loading the list */}
      {list.status === "error" ? (
        <div className="px-5 py-10 text-center">
          <div className="text-[13.5px] font-semibold" style={{ color: "#b91c1c" }}>
            {list.message}
          </div>
          <div className="mt-1 text-[11.5px]" style={{ color: "#94a3b8" }}>
            ลองตรวจการเชื่อมต่อที่แท็บ “เชื่อมต่อ · Connection”
          </div>
        </div>
      ) : null}

      {/* Loading the list */}
      {list.status === "loading" ? (
        <div className="px-5 py-10 text-center text-[12.5px]" style={{ color: "#94a3b8" }}>
          กำลังโหลดรายการตาราง… · loading tables…
        </div>
      ) : null}

      {/* Browser (list + detail) */}
      {list.status === "ready" ? (
        <div className="flex min-h-0" style={{ minHeight: 420 }}>
          {/* Table selector (searchable) */}
          <div className="flex w-[260px] shrink-0 flex-col border-r" style={{ borderColor: "#f1f5f9" }}>
            <div className="border-b p-3" style={{ borderColor: "#f1f5f9" }}>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาตาราง… · search tables"
                aria-label="ค้นหาตาราง · search tables"
                className="w-full rounded-[10px] border px-3 py-2 text-[12.5px] outline-none"
                style={{ borderColor: "#e2e8f0", color: "#334155" }}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <div className="px-2 py-6 text-center text-[11.5px]" style={{ color: "#94a3b8" }}>
                  ไม่พบตารางที่ตรงกับคำค้น
                </div>
              ) : (
                <div className="flex flex-col gap-[5px]">
                  {filtered.map((t) => {
                    const active = selected === t.name;
                    return (
                      <button
                        key={`${t.schema}.${t.name}`}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setSelected(t.name)}
                        className="flex items-center justify-between gap-[10px] rounded-[10px] border px-[12px] py-[9px] text-left transition hover:border-[#86efac]"
                        style={{
                          background: active ? "#ecfdf5" : "#fff",
                          borderColor: active ? "#16a34a" : "#eaeef3",
                        }}
                      >
                        <span className="min-w-0">
                          <span
                            className="mono block truncate text-[12.5px] font-semibold"
                            style={{ color: "#334155" }}
                            title={`${t.schema}.${t.name}`}
                          >
                            {t.name}
                          </span>
                          <span className="mono block text-[10px]" style={{ color: "#94a3b8" }}>
                            {t.schema}
                          </span>
                        </span>
                        <span className="mono shrink-0 text-[10.5px]" style={{ color: "#94a3b8" }}>
                          {t.columns} cols
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Detail pane */}
          <div className="min-w-0 flex-1 overflow-y-auto">
            {selected === null ? (
              <div className="flex h-full items-center justify-center px-6 py-10 text-center text-[12.5px]" style={{ color: "#94a3b8" }}>
                เลือกตารางทางซ้ายเพื่อดูคอลัมน์และตัวอย่างข้อมูล
              </div>
            ) : detail.status === "loading" ? (
              <div className="px-6 py-10 text-center text-[12.5px]" style={{ color: "#94a3b8" }}>
                กำลังโหลดข้อมูลตาราง… · loading table…
              </div>
            ) : detail.status === "error" ? (
              <div className="px-6 py-10 text-center">
                <div className="text-[13px] font-semibold" style={{ color: "#b91c1c" }}>
                  {detail.message}
                </div>
              </div>
            ) : detail.status === "ready" ? (
              <TableDetailView detail={detail.detail} />
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Footer */}
      <div className="flex items-center gap-2 border-t px-5 py-[11px] text-[11.5px]" style={{ borderColor: "#f1f5f9", color: "#94a3b8" }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: "#16a34a" }} />
        ข้อมูลจริงจาก KRS · read-only · ตัวอย่างจำกัด 50 แถวต่อตาราง
      </div>
    </div>
  );
}

/** The right-side detail: a columns table (name/type/nullable) + a sample-rows grid. */
function TableDetailView({ detail }: { detail: TableDetail }) {
  const cols = detail.columns;
  return (
    <div className="flex flex-col">
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b px-5 py-3" style={{ borderColor: "#f1f5f9" }}>
        <span className="mono text-[13.5px] font-bold" style={{ color: "#0f5132" }}>
          {detail.schema}.{detail.name}
        </span>
        <span className="text-[11px]" style={{ color: "#94a3b8" }}>
          {cols.length} คอลัมน์ · {detail.sample.length} แถวตัวอย่าง
        </span>
      </div>

      {/* Columns */}
      <div className="px-5 py-4">
        <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "#94a3b8" }}>
          คอลัมน์ · Columns
        </div>
        <div className="overflow-hidden rounded-[10px] border" style={{ borderColor: "#eef2f6" }}>
          {cols.length === 0 ? (
            <div className="px-3 py-4 text-center text-[11.5px]" style={{ color: "#94a3b8" }}>
              ไม่มีคอลัมน์
            </div>
          ) : (
            cols.map((c, i) => (
              <div
                key={c.columnName}
                className="flex items-center gap-3 px-3 py-[7px] text-[11.5px]"
                style={{ borderTop: i === 0 ? "none" : "1px solid #f4f7fa" }}
              >
                <span className="mono min-w-0 flex-1 truncate font-semibold" style={{ color: "#334155" }}>
                  {c.columnName}
                </span>
                <span className="mono shrink-0" style={{ color: "#64748b" }}>
                  {formatType(c)}
                </span>
                <span
                  className="shrink-0 rounded-[6px] px-[6px] py-px text-[9.5px] font-semibold"
                  style={
                    c.isNullable
                      ? { background: "#f1f5f9", color: "#94a3b8" }
                      : { background: "#ecfdf5", color: "#0f5132" }
                  }
                >
                  {c.isNullable ? "NULL" : "NOT NULL"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Sample rows */}
      <div className="px-5 pb-5">
        <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: "#94a3b8" }}>
          ตัวอย่างข้อมูล · Sample (TOP 50)
        </div>
        {detail.sample.length === 0 ? (
          <div className="rounded-[10px] border px-3 py-4 text-center text-[11.5px]" style={{ borderColor: "#eef2f6", color: "#94a3b8" }}>
            ไม่มีข้อมูลในตารางนี้
          </div>
        ) : (
          <div className="overflow-x-auto rounded-[10px] border" style={{ borderColor: "#eef2f6" }}>
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ background: "#fafbfc" }}>
                  {cols.map((c) => (
                    <th
                      key={c.columnName}
                      className="mono whitespace-nowrap border-b px-3 py-[9px] text-left text-[10.5px] font-semibold"
                      style={{ borderColor: "#eef2f6", color: "#94a3b8" }}
                    >
                      {c.columnName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {detail.sample.map((row, ri) => (
                  <tr key={ri}>
                    {cols.map((c) => (
                      <td
                        key={c.columnName}
                        className="mono max-w-[280px] truncate whitespace-nowrap border-b px-3 py-[8px] text-[11px]"
                        style={{ borderColor: "#f4f7fa", color: "#334155" }}
                        title={renderCell(row[c.columnName])}
                      >
                        {renderCell(row[c.columnName])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** Compose a compact type label (e.g. `nvarchar(255)`, `decimal(10,2)`). */
function formatType(c: ColumnMeta): string {
  if (c.maxLength !== null && c.maxLength > 0) {
    return `${c.dataType}(${c.maxLength})`;
  }
  if (c.numericPrecision !== null && c.numericScale !== null) {
    return `${c.dataType}(${c.numericPrecision},${c.numericScale})`;
  }
  return c.dataType;
}

/** Render one sample cell value as display text. The server already sanitized the
 *  values to JSON primitives (Date→ISO string, binary→placeholder), so we only need
 *  to stringify null/undefined cleanly. */
function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

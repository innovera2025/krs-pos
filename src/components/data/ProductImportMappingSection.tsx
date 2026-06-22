"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowRight, Check, AlertTriangle, Loader2 } from "lucide-react";
import { useToast } from "@/components/ToastProvider";

/**
 * Product Import field-mapping editor (krs-sync inbound import config) — the
 * INTERACTIVE half of the "จับคู่ฟิลด์ · Field Mapping" tab for the live
 * PRODUCT_IMPORT function. It replaces the static inbound product diagram with a
 * real, persisted mapping:
 *
 *  - on mount: GET /api/krs/mappings?function=PRODUCT_IMPORT (saved-or-default
 *    mapping + the target-field spec) and GET /api/krs/schema (the table list).
 *  - a searchable SOURCE-TABLE dropdown (the ~238 KRS tables; default InventoryItem).
 *  - choosing a table GETs /api/krs/schema?table=X for that table's columns.
 *  - for each POS Product target field, a column dropdown (required fields marked +
 *    must be set). Save → PATCH /api/krs/mappings; server validation errors surface.
 *
 * Generic-ready but scoped to PRODUCT_IMPORT (the only wired function today). Taste
 * language: forest/mint accents, IBM Plex Sans Thai, Thai-first microcopy, restrained
 * borders. Self-contained (its own fetches) so it does not disturb the page-level
 * health check or the other tabs.
 */

const FUNCTION = "PRODUCT_IMPORT";

type TargetFieldSpec = { field: string; required: boolean; label: string };

type MappingResponse = {
  function: string;
  sourceTable: string;
  fieldMap: Record<string, string>;
  targetFields: TargetFieldSpec[];
};

type TableSummary = { schema: string; name: string; columns: number };

type ColumnMeta = { columnName: string; dataType: string; isNullable: boolean };

/** Top-level load state for the mapping + table list (fetched together on mount). */
type LoadState =
  | { status: "loading" }
  | { status: "not-configured" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      targetFields: TargetFieldSpec[];
      tables: TableSummary[];
    };

/** Per-source-table columns load state. */
type ColumnsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; columns: ColumnMeta[] };

export function ProductImportMappingSection() {
  const { showToast } = useToast();

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  // The editable mapping form state (seeded from the saved/default mapping).
  const [sourceTable, setSourceTable] = useState<string>("");
  const [fieldMap, setFieldMap] = useState<Record<string, string>>({});
  const [tableSearch, setTableSearch] = useState("");
  const [columns, setColumns] = useState<ColumnsState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ---- Load the saved/default mapping + the table list on mount ----
  useEffect(() => {
    let mounted = true;
    setLoad({ status: "loading" });

    Promise.all([
      fetch(`/api/krs/mappings?function=${encodeURIComponent(FUNCTION)}`).then(
        async (res) => ({
          ok: res.ok,
          data: (await res.json().catch(() => null)) as MappingResponse | null,
        })
      ),
      fetch("/api/krs/schema").then(async (res) => ({
        ok: res.ok,
        data: (await res.json().catch(() => null)) as
          | { configured: false }
          | { configured: true; tables: TableSummary[] | null; error?: string }
          | null,
      })),
    ])
      .then(([mapRes, schemaRes]) => {
        if (!mounted) return;

        if (!mapRes.ok || mapRes.data === null) {
          setLoad({
            status: "error",
            message: "โหลดการจับคู่ฟิลด์ไม่สำเร็จ · could not load mapping",
          });
          return;
        }

        // Seed the form from the saved/default mapping regardless of schema state.
        setSourceTable(mapRes.data.sourceTable);
        setFieldMap({ ...mapRes.data.fieldMap });

        // Schema (table list) — "not configured" is a graceful state (the admin must
        // set up the Connection tab first); a null/failed list is an error.
        if (!schemaRes.ok || schemaRes.data === null) {
          setLoad({
            status: "error",
            message: "โหลดรายการตารางไม่สำเร็จ · could not load tables",
          });
          return;
        }
        if (schemaRes.data.configured === false) {
          setLoad({ status: "not-configured" });
          return;
        }
        if (schemaRes.data.tables === null) {
          setLoad({
            status: "error",
            message: schemaRes.data.error || "อ่านสคีมาไม่สำเร็จ · could not read schema",
          });
          return;
        }
        setLoad({
          status: "ready",
          targetFields: mapRes.data.targetFields,
          tables: schemaRes.data.tables,
        });
      })
      .catch(() => {
        if (mounted) {
          setLoad({
            status: "error",
            message: "โหลดข้อมูลไม่สำเร็จ · could not load data",
          });
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  // ---- Load the chosen source table's columns whenever it changes ----
  useEffect(() => {
    if (load.status !== "ready") return;
    if (sourceTable.trim().length === 0) {
      setColumns({ status: "idle" });
      return;
    }
    let mounted = true;
    setColumns({ status: "loading" });
    fetch(`/api/krs/schema?table=${encodeURIComponent(sourceTable)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as
          | { configured: true; table: { columns: ColumnMeta[] } }
          | { error: string }
          | null;
        if (!mounted) return;
        if (!res.ok || data === null || !("table" in data)) {
          const message =
            data && "error" in data && data.error
              ? data.error
              : "อ่านคอลัมน์ไม่สำเร็จ · could not read columns";
          setColumns({ status: "error", message });
          return;
        }
        setColumns({ status: "ready", columns: data.table.columns });
      })
      .catch(() => {
        if (mounted) {
          setColumns({
            status: "error",
            message: "อ่านคอลัมน์ไม่สำเร็จ · could not read columns",
          });
        }
      });
    return () => {
      mounted = false;
    };
  }, [sourceTable, load.status]);

  const tables = load.status === "ready" ? load.tables : [];
  const targetFields = load.status === "ready" ? load.targetFields : [];

  const filteredTables = useMemo(() => {
    const q = tableSearch.trim().toLowerCase();
    if (q.length === 0) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, tableSearch]);

  const columnNames = useMemo(
    () => (columns.status === "ready" ? columns.columns.map((c) => c.columnName) : []),
    [columns]
  );

  // When the source table changes, drop any mapped column that is no longer present
  // in the newly-loaded column set (so a stale mapping can't be saved by accident).
  useEffect(() => {
    if (columns.status !== "ready") return;
    const live = new Set(columnNames.map((c) => c.toLowerCase()));
    setFieldMap((prev) => {
      let changed = false;
      const next: Record<string, string> = {};
      for (const [field, col] of Object.entries(prev)) {
        if (live.has(col.toLowerCase())) {
          next[field] = col;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [columns.status, columnNames]);

  const setFieldColumn = useCallback((field: string, column: string) => {
    setSaveError(null);
    setFieldMap((prev) => {
      const next = { ...prev };
      if (column.length === 0) {
        delete next[field];
      } else {
        next[field] = column;
      }
      return next;
    });
  }, []);

  // A required field with no mapped column blocks Save (client-side mirror of the
  // server's MISSING_REQUIRED gate — the server still enforces it authoritatively).
  const missingRequired = useMemo(
    () =>
      targetFields
        .filter((t) => t.required)
        .filter((t) => {
          const col = fieldMap[t.field];
          return typeof col !== "string" || col.trim().length === 0;
        })
        .map((t) => t.field),
    [targetFields, fieldMap]
  );

  const canSave =
    load.status === "ready" &&
    sourceTable.trim().length > 0 &&
    missingRequired.length === 0 &&
    !saving;

  const onSave = useCallback(async () => {
    setSaveError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/krs/mappings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          function: FUNCTION,
          sourceTable: sourceTable.trim(),
          fieldMap,
        }),
      });
      const data = (await res.json().catch(() => null)) as
        | { error?: string; issues?: { path: string; message: string }[] }
        | null;
      if (!res.ok) {
        const issueMsg =
          data && Array.isArray(data.issues) && data.issues.length > 0
            ? data.issues.map((i) => i.message).join(" · ")
            : null;
        const message =
          issueMsg ||
          (data && data.error) ||
          "บันทึกไม่สำเร็จ · could not save mapping";
        setSaveError(message);
        return;
      }
      showToast("บันทึกการจับคู่ฟิลด์แล้ว · field mapping saved");
    } catch {
      setSaveError("บันทึกไม่สำเร็จ · could not save mapping");
    } finally {
      setSaving(false);
    }
  }, [sourceTable, fieldMap, showToast]);

  return (
    <div
      className="rounded-2xl border px-5 py-[18px]"
      style={{ background: "#fff", borderColor: "#e8edf3" }}
    >
      {/* Section header */}
      <div className="mb-[14px] flex items-center gap-[9px]">
        <span
          className="grid h-[26px] w-[26px] place-items-center rounded-[7px]"
          style={{ background: "#eff6ff", color: "#1d4ed8" }}
        >
          <ArrowDown size={15} strokeWidth={2.2} />
        </span>
        <span className="text-[14px] font-bold">ดึงสินค้าจาก KRS · Product import</span>
        <span className="text-[11.5px]" style={{ color: "#94a3b8" }}>
          เลือกตารางต้นทางและจับคู่คอลัมน์ → POS Product
        </span>
      </div>

      {/* Loading */}
      {load.status === "loading" ? (
        <div className="flex items-center gap-2 px-1 py-8 text-[12.5px]" style={{ color: "#94a3b8" }}>
          <Loader2 size={15} className="animate-spin" />
          กำลังโหลดการจับคู่ฟิลด์… · loading mapping…
        </div>
      ) : null}

      {/* Not configured */}
      {load.status === "not-configured" ? (
        <div
          className="flex items-start gap-[10px] rounded-[12px] border px-[14px] py-[12px]"
          style={{ background: "#fffbeb", borderColor: "#fde68a" }}
        >
          <AlertTriangle size={17} strokeWidth={2} color="#d97706" className="mt-0.5 shrink-0" />
          <div className="text-[12px] leading-relaxed" style={{ color: "#a16207" }}>
            ยังไม่ได้ตั้งค่าการเชื่อมต่อ KRS — ไปที่แท็บ “เชื่อมต่อ · Connection”
            เพื่อตั้งค่าและทดสอบก่อน จึงจะจับคู่ฟิลด์ได้
          </div>
        </div>
      ) : null}

      {/* Error */}
      {load.status === "error" ? (
        <div
          className="flex items-start gap-[10px] rounded-[12px] border px-[14px] py-[12px]"
          style={{ background: "#fef2f2", borderColor: "#fecaca" }}
        >
          <AlertTriangle size={17} strokeWidth={2} color="#dc2626" className="mt-0.5 shrink-0" />
          <div className="text-[12px] leading-relaxed" style={{ color: "#b91c1c" }}>
            {load.message}
          </div>
        </div>
      ) : null}

      {/* Editor */}
      {load.status === "ready" ? (
        <div className="flex flex-col gap-[16px]">
          {/* Source-table picker (searchable) */}
          <div>
            <label
              className="mb-1.5 block text-[11.5px] font-semibold"
              style={{ color: "#475569" }}
            >
              ตารางต้นทางใน KRS · Source table
            </label>
            <input
              type="search"
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              placeholder="ค้นหาตาราง… · search tables"
              aria-label="ค้นหาตารางต้นทาง · search source tables"
              className="mb-2 w-full rounded-[10px] border px-3 py-2 text-[12.5px] outline-none"
              style={{ borderColor: "#e2e8f0", color: "#334155" }}
            />
            <select
              value={sourceTable}
              onChange={(e) => {
                setSaveError(null);
                setSourceTable(e.target.value);
              }}
              aria-label="ตารางต้นทาง · source table"
              className="mono w-full rounded-[10px] border px-3 py-2 text-[12.5px] outline-none"
              style={{ borderColor: "#e2e8f0", color: "#334155", background: "#fff" }}
            >
              {/* Keep the saved table selectable even if filtered out by the search. */}
              {sourceTable.length > 0 &&
              !filteredTables.some((t) => t.name === sourceTable) ? (
                <option value={sourceTable}>{sourceTable}</option>
              ) : null}
              {filteredTables.map((t) => (
                <option key={`${t.schema}.${t.name}`} value={t.name}>
                  {t.name} ({t.columns} cols)
                </option>
              ))}
            </select>
            <div className="mt-1 text-[10.5px]" style={{ color: "#94a3b8" }}>
              {tables.length.toLocaleString("en-US")} ตารางจาก KRS · default:{" "}
              <span className="mono">InventoryItem</span>
            </div>
          </div>

          {/* Column-loading state */}
          {columns.status === "loading" ? (
            <div className="flex items-center gap-2 px-1 text-[12px]" style={{ color: "#94a3b8" }}>
              <Loader2 size={14} className="animate-spin" />
              กำลังโหลดคอลัมน์… · loading columns…
            </div>
          ) : null}
          {columns.status === "error" ? (
            <div
              className="flex items-start gap-[10px] rounded-[12px] border px-[14px] py-[10px]"
              style={{ background: "#fef2f2", borderColor: "#fecaca" }}
            >
              <AlertTriangle size={15} strokeWidth={2} color="#dc2626" className="mt-0.5 shrink-0" />
              <div className="text-[11.5px]" style={{ color: "#b91c1c" }}>
                {columns.message}
              </div>
            </div>
          ) : null}

          {/* Field → column dropdowns */}
          <div className="overflow-hidden rounded-[12px] border" style={{ borderColor: "#eef2f6" }}>
            <div
              className="grid gap-[10px] border-b px-[14px] py-2.5 text-[11px] font-semibold"
              style={{ gridTemplateColumns: "1.2fr 24px 1.5fr", borderColor: "#eef2f6", color: "#94a3b8", background: "#fafbfc" }}
            >
              <div>POS field</div>
              <div />
              <div>KRS column</div>
            </div>
            {targetFields.map((t) => {
              const value = fieldMap[t.field] ?? "";
              const isMissing = t.required && value.trim().length === 0;
              return (
                <div
                  key={t.field}
                  className="grid items-center gap-[10px] border-b px-[14px] py-[11px]"
                  style={{ gridTemplateColumns: "1.2fr 24px 1.5fr", borderColor: "#f4f7fa" }}
                >
                  <div className="flex items-center gap-[7px]">
                    <span className="mono text-[12px] font-semibold" style={{ color: "#334155" }}>
                      {t.field}
                    </span>
                    {t.required ? (
                      <span
                        className="rounded-[6px] px-[6px] py-px text-[9px] font-semibold"
                        style={{ background: "#fef2f2", color: "#b91c1c" }}
                      >
                        บังคับ
                      </span>
                    ) : (
                      <span
                        className="rounded-[6px] px-[6px] py-px text-[9px] font-semibold"
                        style={{ background: "#f1f5f9", color: "#94a3b8" }}
                      >
                        ไม่บังคับ
                      </span>
                    )}
                  </div>
                  <ArrowRight size={14} strokeWidth={2} color="#cbd5e1" />
                  <select
                    value={value}
                    onChange={(e) => setFieldColumn(t.field, e.target.value)}
                    aria-label={`คอลัมน์ KRS สำหรับ ${t.field}`}
                    disabled={columns.status !== "ready"}
                    className="mono w-full rounded-[9px] border px-[10px] py-[7px] text-[12px] outline-none disabled:opacity-50"
                    style={{
                      borderColor: isMissing ? "#fca5a5" : "#e2e8f0",
                      color: "#334155",
                      background: "#fff",
                    }}
                  >
                    <option value="">
                      {t.required ? "— ต้องเลือก —" : "— ไม่จับคู่ —"}
                    </option>
                    {/* Preserve a saved value even if the live columns haven't loaded
                        yet or it dropped out — so it stays visible until reconciled. */}
                    {value.length > 0 && !columnNames.includes(value) ? (
                      <option value={value}>{value}</option>
                    ) : null}
                    {columnNames.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>

          {/* Missing-required warning */}
          {missingRequired.length > 0 ? (
            <div
              className="flex items-start gap-[10px] rounded-[12px] border px-[14px] py-[10px]"
              style={{ background: "#fffbeb", borderColor: "#fde68a" }}
            >
              <AlertTriangle size={15} strokeWidth={2} color="#d97706" className="mt-0.5 shrink-0" />
              <div className="text-[11.5px]" style={{ color: "#a16207" }}>
                ยังไม่ได้จับคู่ฟิลด์บังคับ:{" "}
                <span className="mono">{missingRequired.join(", ")}</span> — บันทึกไม่ได้จนกว่าจะครบ
              </div>
            </div>
          ) : null}

          {/* Save error (server validation) */}
          {saveError !== null ? (
            <div
              className="flex items-start gap-[10px] rounded-[12px] border px-[14px] py-[10px]"
              style={{ background: "#fef2f2", borderColor: "#fecaca" }}
            >
              <AlertTriangle size={15} strokeWidth={2} color="#dc2626" className="mt-0.5 shrink-0" />
              <div className="text-[11.5px]" style={{ color: "#b91c1c" }}>
                {saveError}
              </div>
            </div>
          ) : null}

          {/* Save */}
          <div className="flex items-center justify-end gap-3">
            <span className="text-[11px]" style={{ color: "#94a3b8" }}>
              การปั๊ม “ดึงสินค้าจาก KRS” จะใช้การจับคู่ที่บันทึกนี้โดยอัตโนมัติ
            </span>
            <button
              type="button"
              onClick={onSave}
              disabled={!canSave}
              className="inline-flex items-center gap-1.5 rounded-[10px] px-4 py-2 text-[12.5px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: "#16a34a" }}
            >
              {saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Check size={14} strokeWidth={2.4} />
              )}
              บันทึกการจับคู่ · Save mapping
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  RotateCcw,
  RefreshCw,
  Database,
  ArrowDownToLine,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import type {
  KrsReconcileDTO,
  KrsReconcileRowDTO,
  KrsReconcileSummaryDTO,
  KrsSyncStockResultDTO,
} from "@/types";
import { useToast } from "@/components/ToastProvider";

/**
 * Data Flow tab (KRS Data Link) — krs-sync R1 stock RECONCILIATION dashboard.
 *
 * This replaces the previous SIMULATED sync-job UI. It is now a REAL, read-mostly
 * POS↔KRS stock reconciliation view:
 *   - On mount + every ~45s it GETs /api/krs/reconcile (READ-ONLY both ways: reads
 *     the KRS standard-cost stock ledger `dbo.tbl_STOCKSTD` and the POS products,
 *     joins by sku == itemCode) and renders summary cards + a searchable table.
 *   - The "ซิงค์สต็อกจาก KRS" button POSTs /api/krs/sync-stock, the BASELINE import
 *     that SETs POS Product.stock = the KRS balance (rounded, floored at 0). It
 *     writes ONLY to the POS DB — it NEVER writes to KRS.
 *
 * NOTE on "realtime": true instant realtime would need a push channel the KRS
 * accounting ERP does not provide; this is NEAR-realtime via ~45s polling. Outbound
 * write-back to KRS (R2) is deferred (gated on the KRS vendor's supported write
 * interface).
 *
 * The legacy /api/sync-jobs route and the NavRail failed-count badge are left ALONE
 * (still functional, just no longer surfaced in this tab).
 */

/** Poll cadence for the reconcile refresh (near-realtime). */
const RECONCILE_POLL_MS = 45_000;

/** Tri-state load status so the empty/loading/error/not-configured states are
 *  distinct (mirrors the /pos /products patterns). */
type LoadState = "loading" | "ok" | "error" | "not-configured";

/** Format an ISO timestamp as a local HH:MM:SS "last checked" label. */
function formatCheckedAt(iso: string | null): string {
  if (iso === null) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format a possibly-fractional stock quantity compactly (integers show no decimals;
 *  fractional KRS totals show up to 2dp). */
function qty(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function SummaryCard({
  label,
  en,
  value,
  tone,
}: {
  label: string;
  en: string;
  value: number;
  tone: "neutral" | "good" | "bad" | "info";
}) {
  const toneStyle: Record<typeof tone, { bg: string; fg: string }> = {
    neutral: { bg: "#fff", fg: "#0f172a" },
    good: { bg: "#f0fdf4", fg: "#15803d" },
    bad: { bg: "#fef2f2", fg: "#dc2626" },
    info: { bg: "#eff6ff", fg: "#1d4ed8" },
  };
  const t = toneStyle[tone];
  return (
    <div
      className="flex flex-col gap-1 rounded-[14px] border px-4 py-[14px]"
      style={{ background: t.bg, borderColor: "#e8edf3" }}
    >
      <span className="mono text-[24px] font-bold leading-none" style={{ color: t.fg }}>
        {value}
      </span>
      <span className="text-[12.5px] font-semibold" style={{ color: "#334155" }}>
        {label}
      </span>
      <span className="text-[10px]" style={{ color: "#94a3b8" }}>
        {en}
      </span>
    </div>
  );
}

export function DataFlowTab() {
  const { showToast } = useToast();

  const [state, setState] = useState<LoadState>("loading");
  const [data, setData] = useState<KrsReconcileDTO | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  // Mounted guard so a poll tick or in-flight fetch resolving after unmount never
  // calls setState (mirrors the page-level health-check + ConnectionTab lesson).
  const mountedRef = useRef(true);

  const summary: KrsReconcileSummaryDTO | null = data?.summary ?? null;

  const fetchReconcile = useCallback(async () => {
    try {
      const res = await fetch("/api/krs/reconcile");
      if (res.status === 422) {
        if (!mountedRef.current) return;
        setState("not-configured");
        return;
      }
      if (!res.ok) throw new Error("reconcile failed");
      const json = (await res.json()) as KrsReconcileDTO;
      if (!mountedRef.current) return;
      setData(json);
      setCheckedAt(json.checkedAt);
      setState("ok");
    } catch {
      if (!mountedRef.current) return;
      // Keep any previously loaded data so a transient poll error does not blank the
      // table; only flip to a full error screen when we have nothing yet.
      setState((prev) => (prev === "ok" ? "ok" : "error"));
    }
  }, []);

  // Initial load + ~45s near-realtime poll. The interval is cleared and the mounted
  // guard flipped on cleanup so there is no setState-after-unmount and no stuck timer.
  useEffect(() => {
    mountedRef.current = true;
    void fetchReconcile();
    const id = setInterval(() => {
      void fetchReconcile();
    }, RECONCILE_POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [fetchReconcile]);

  // Manual refresh: show the loading spinner only when we have no data yet.
  const manualRefresh = useCallback(async () => {
    if (state !== "ok" && state !== "error") setState("loading");
    await fetchReconcile();
  }, [fetchReconcile, state]);

  // Baseline import: POST /api/krs/sync-stock → toast → re-fetch reconcile.
  const syncStock = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/krs/sync-stock", { method: "POST" });
      const json = (await res.json().catch(() => null)) as
        | (KrsSyncStockResultDTO & { error?: string })
        | { error?: string }
        | null;
      if (!res.ok || !json || !("ok" in json)) {
        showToast(
          (json && "error" in json && json.error) ||
            "ซิงค์สต็อกไม่สำเร็จ · sync failed"
        );
        return;
      }
      showToast(
        `ซิงค์สต็อกจาก KRS แล้ว · อัปเดต ${json.updated} · ไม่เปลี่ยน ${json.skipped} · ไม่มีใน KRS ${json.notInKrs}`
      );
      await fetchReconcile();
    } catch {
      if (mountedRef.current) showToast("ซิงค์สต็อกไม่สำเร็จ · ลองอีกครั้ง");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [busy, fetchReconcile, showToast]);

  // Filtered + sorted rows: mismatches first, then by sku. Search matches sku/name.
  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = search.trim().toLowerCase();
    const filtered =
      q.length === 0
        ? all
        : all.filter(
            (r) =>
              r.sku.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
          );
    return [...filtered].sort((a, b) => {
      // Mismatches first.
      if (a.status !== b.status) return a.status === "mismatch" ? -1 : 1;
      return a.sku.localeCompare(b.sku);
    });
  }, [data, search]);

  // ---- Not-configured state ----
  if (state === "not-configured") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[14px] border bg-white px-[18px] py-[52px] text-center" style={{ borderColor: "#e8edf3" }}>
        <span className="grid h-[56px] w-[56px] place-items-center rounded-[18px]" style={{ background: "#eff6ff", color: "#1d4ed8" }}>
          <Database size={26} strokeWidth={2} />
        </span>
        <div className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>
          ยังไม่ได้ตั้งค่าการเชื่อมต่อ KRS
        </div>
        <p className="m-0 max-w-[340px] text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
          ตั้งค่าการเชื่อมต่อในแท็บ “เชื่อมต่อ” ก่อน แล้วจึงเทียบสต็อกได้ · Configure
          the KRS connection first, then stock reconciliation will appear here.
        </p>
      </div>
    );
  }

  // ---- Hard error state (nothing loaded) ----
  if (state === "error" && data === null) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[14px] border bg-white px-[18px] py-[48px] text-center" style={{ borderColor: "#e8edf3" }}>
        <span className="grid h-[56px] w-[56px] place-items-center rounded-[18px]" style={{ background: "var(--red-soft)", color: "#dc2626" }}>
          <AlertCircle size={26} strokeWidth={2} />
        </span>
        <div className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>
          เทียบสต็อกกับ KRS ไม่สำเร็จ
        </div>
        <p className="m-0 max-w-[340px] text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
          อ่านสต็อกจาก KRS ไม่ได้ ตรวจสอบการเชื่อมต่อแล้วลองใหม่ · Could not read KRS
          stock — check the connection and retry.
        </p>
        <button
          type="button"
          onClick={() => void manualRefresh()}
          className="mt-1 inline-flex h-[38px] items-center gap-2 rounded-[10px] border px-4 text-[12.5px] font-semibold transition hover:bg-[#f8fafc]"
          style={{ borderColor: "#e2e8f0", color: "#334155" }}
        >
          <RotateCcw size={15} strokeWidth={2} />
          ลองใหม่ · Retry
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-[10px]">
        <button
          type="button"
          onClick={() => void syncStock()}
          disabled={busy}
          className="flex h-[42px] items-center gap-2 rounded-[11px] px-4 text-[13px] font-semibold text-white transition hover:brightness-105 disabled:opacity-50"
          style={{ background: "#16a34a", boxShadow: "0 4px 12px rgba(22,163,74,.25)" }}
        >
          <ArrowDownToLine size={16} strokeWidth={2} />
          {busy ? "กำลังซิงค์…" : "ซิงค์สต็อกจาก KRS"}
        </button>
        <button
          type="button"
          onClick={() => void manualRefresh()}
          disabled={busy}
          className="flex h-[42px] items-center gap-2 rounded-[11px] border px-4 text-[13px] font-semibold transition hover:bg-[#f8fafc] disabled:opacity-50"
          style={{ background: "#fff", borderColor: "#e2e8f0", color: "#334155" }}
        >
          <RefreshCw size={15} strokeWidth={2} />
          รีเฟรช
        </button>
        <div className="flex-1" />
        <div className="text-[12px]" style={{ color: "#94a3b8" }}>
          ตรวจล่าสุด:{" "}
          <span className="mono font-semibold" style={{ color: "#334155" }}>
            {formatCheckedAt(checkedAt)}
          </span>
          <span className="ml-2 hidden sm:inline">· อัปเดตอัตโนมัติทุก ~45 วิ</span>
        </div>
      </div>

      {/* Summary cards */}
      {summary ? (
        <div className="grid grid-cols-2 gap-[10px] sm:grid-cols-3 lg:grid-cols-5">
          <SummaryCard label="ทั้งหมด" en="Total" value={summary.total} tone="neutral" />
          <SummaryCard label="ตรงกัน" en="Matched" value={summary.matched} tone="good" />
          <SummaryCard label="ไม่ตรง" en="Mismatched" value={summary.mismatched} tone="bad" />
          <SummaryCard label="มีใน KRS ไม่มีใน POS" en="Only in KRS" value={summary.onlyInKrs} tone="info" />
          <SummaryCard label="มีใน POS ไม่มีใน KRS" en="Only in POS" value={summary.onlyInPos} tone="info" />
        </div>
      ) : null}

      {/* Search */}
      <div className="flex items-center gap-[10px]">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหารหัส / ชื่อสินค้า · Search sku / name"
          className="h-[40px] flex-1 rounded-[11px] border px-3 text-[13px] outline-none transition focus:border-[#16a34a]"
          style={{ background: "#fff", borderColor: "#e2e8f0", color: "#0f172a" }}
        />
      </div>

      {/* Reconcile table */}
      <div className="overflow-hidden rounded-[14px] border" style={{ background: "#fff", borderColor: "#e8edf3" }}>
        <div
          className="grid gap-[10px] border-b px-[18px] py-[13px] text-[11.5px] font-semibold"
          style={{ gridTemplateColumns: "130px 1.4fr 90px 90px 90px 120px", borderColor: "#eef2f6", color: "#94a3b8" }}
        >
          <div>รหัส · SKU</div>
          <div>ชื่อสินค้า</div>
          <div className="text-right">POS</div>
          <div className="text-right">KRS</div>
          <div className="text-right">ส่วนต่าง</div>
          <div>สถานะ</div>
        </div>

        {state === "loading" && data === null ? (
          <div className="px-[18px] py-[50px] text-center text-[13px]" style={{ color: "var(--soft)" }}>
            กำลังโหลด...
          </div>
        ) : rows.length === 0 ? (
          <div className="px-[18px] py-[50px] text-center">
            <div className="font-semibold" style={{ color: "#64748b" }}>
              {search.trim().length > 0
                ? "ไม่พบสินค้าที่ตรงกับการค้นหา"
                : "ไม่มีสินค้าที่จับคู่กับ KRS ได้"}
            </div>
          </div>
        ) : (
          rows.map((r: KrsReconcileRowDTO) => {
            const mismatch = r.status === "mismatch";
            return (
              <div
                key={r.sku}
                className="grid w-full items-center gap-[10px] border-b px-[18px] py-[13px] text-left"
                style={{
                  gridTemplateColumns: "130px 1.4fr 90px 90px 90px 120px",
                  borderColor: "#f4f7fa",
                  background: mismatch ? "#fef2f2" : undefined,
                }}
              >
                <div className="mono overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-semibold" style={{ color: "#475569" }}>
                  {r.sku}
                </div>
                <div className="min-w-0">
                  <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium" style={{ color: "#334155" }}>
                    {r.name}
                  </div>
                  {!r.isActive ? (
                    <div className="text-[10.5px]" style={{ color: "#94a3b8" }}>
                      ปิดการขาย · inactive
                    </div>
                  ) : null}
                </div>
                <div className="mono text-right text-[13px] font-semibold" style={{ color: "#0f172a" }}>
                  {qty(r.posStock)}
                </div>
                <div className="mono text-right text-[13px] font-semibold" style={{ color: "#0f172a" }}>
                  {qty(r.krsStock)}
                </div>
                <div
                  className="mono text-right text-[13px] font-bold"
                  style={{ color: mismatch ? "#dc2626" : "#94a3b8" }}
                >
                  {r.diff > 0 ? "+" : ""}
                  {qty(r.diff)}
                </div>
                <div>
                  <span
                    className="inline-flex items-center gap-[5px] rounded-[7px] px-[9px] py-1 text-[11.5px] font-semibold"
                    style={
                      mismatch
                        ? { background: "#fee2e2", color: "#dc2626" }
                        : { background: "#dcfce7", color: "#15803d" }
                    }
                  >
                    {mismatch ? (
                      <AlertTriangle size={12} strokeWidth={2.4} />
                    ) : (
                      <CheckCircle2 size={12} strokeWidth={2.4} />
                    )}
                    {mismatch ? "ไม่ตรง" : "ตรง"}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footnote: this is near-realtime polling; true push realtime + outbound
          write-back to KRS (R2) is deferred. */}
      <p className="m-0 text-[11px] leading-relaxed" style={{ color: "#94a3b8" }}>
        อ่านสต็อกจากบัญชี KRS แบบใกล้เคียงเรียลไทม์ (โพลทุก ~45 วิ) · การ “ซิงค์สต็อกจาก KRS”
        ตั้งค่าสต็อก POS ตามยอดคงเหลือใน KRS เท่านั้น และไม่เขียนกลับเข้า KRS · เขียนกลับเข้า
        KRS (R2) ยังไม่เปิดใช้งาน รอช่องทางเขียนที่ผู้ให้บริการ KRS รองรับ
      </p>
    </div>
  );
}

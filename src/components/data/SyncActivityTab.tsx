"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  RotateCcw,
  RefreshCw,
  ArrowDownToLine,
  ArrowUpToLine,
  Inbox,
} from "lucide-react";
import type {
  SyncJobDTO,
  SyncJobStatus,
  SyncDirection,
  SyncCountsDTO,
} from "@/types";
import { money } from "@/lib/money";
import { syncJobMeta, jobTypeLabel, formatJobTime } from "./syncMeta";
import { SyncDetailDrawer } from "./SyncDetailDrawer";

/**
 * Sync Activity tab (KRS Data Link) — a READ-ONLY ledger of the real `SyncJob`
 * table. It answers two operator questions from one feed:
 *   - ขาเข้า · รับจาก KRS (direction PULL)   — what KRS has pushed INTO the POS
 *   - ส่งกลับ · ส่งไป KRS (direction INSERT)  — what the POS has QUEUED/SENT back
 *
 * On mount + every ~30s it GETs /api/sync-jobs (admin-only, the real SyncJob rows
 * ordered updatedAt desc) and renders a per-direction summary row (total +
 * per-status counts) plus one searchable, newest-first table across both
 * directions with a direction filter and a read-only detail drawer.
 *
 * READ-ONLY: this tab performs NO writes. The legacy /api/sync-jobs POST actions
 * (pull / insert-all) and the SyncDetailDrawer retry/skip actions are SIMULATED
 * and are intentionally NOT wired here (the drawer renders with `readOnly`). The
 * real outbound write to KRS is gated by KRS_OUTBOUND_ENABLED (a NODE-only env the
 * client cannot read); when every outbound (INSERT) job is still PENDING we infer
 * the outbound writer is dormant and surface a passive "queued, not sent" note.
 */

/** Poll cadence — matches the ~30–45s near-realtime cadence of the other tabs. */
const ACTIVITY_POLL_MS = 30_000;

/** Tri-state load status so empty/loading/error states stay distinct. */
type LoadState = "loading" | "ok" | "error";

/** Direction table filter (synthetic "all" + the two real directions). */
type DirFilter = "all" | "PULL" | "INSERT";

const DIR_FILTERS: { key: DirFilter; label: string; en: string }[] = [
  { key: "all", label: "ทั้งหมด", en: "All" },
  { key: "PULL", label: "รับเข้า", en: "Inbound" },
  { key: "INSERT", label: "ส่งกลับ", en: "Outbound" },
];

/** The 5 status keys rendered in each summary row, in lifecycle order. */
const STATUS_ORDER: SyncJobStatus[] = [
  "PENDING",
  "SYNCED",
  "FAILED",
  "RETRYING",
  "SKIPPED",
];

/** Map a SyncJobStatus to the SyncCountsDTO key it tallies into. */
const STATUS_COUNT_KEY: Record<SyncJobStatus, keyof SyncCountsDTO> = {
  PENDING: "pending",
  SYNCED: "synced",
  FAILED: "failed",
  RETRYING: "retrying",
  SKIPPED: "skipped",
};

const EMPTY_COUNTS: SyncCountsDTO = {
  pending: 0,
  synced: 0,
  failed: 0,
  retrying: 0,
  skipped: 0,
};

/** Tally a job list into per-status counts. */
function countByStatus(jobs: SyncJobDTO[]): SyncCountsDTO {
  const counts: SyncCountsDTO = { ...EMPTY_COUNTS };
  for (const j of jobs) {
    const key = STATUS_COUNT_KEY[j.status];
    if (key) counts[key] += 1;
  }
  return counts;
}

/** Most-recent updatedAt across a job list (already updatedAt-desc from the API),
 *  formatted as a compact HH:MM time; "—" when the list is empty. */
function lastSyncedTime(jobs: SyncJobDTO[]): string {
  if (jobs.length === 0) return "—";
  // The API returns updatedAt desc, so the first row is the most recent; fall back
  // to a defensive max in case ordering ever changes.
  let latest = jobs[0].updatedAt;
  for (const j of jobs) {
    if (j.updatedAt > latest) latest = j.updatedAt;
  }
  return formatJobTime(latest);
}

/** Compact direction badge (รับเข้า / ส่งกลับ) for a table row. */
function DirectionBadge({ direction }: { direction: SyncDirection }) {
  const inbound = direction === "PULL";
  const style = inbound
    ? { bg: "#eff6ff", fg: "#1d4ed8" }
    : { bg: "#f0fdf4", fg: "#15803d" };
  return (
    <span
      className="inline-flex items-center gap-[5px] rounded-[7px] px-[8px] py-1 text-[11px] font-semibold"
      style={{ background: style.bg, color: style.fg }}
    >
      {inbound ? (
        <ArrowDownToLine size={11} strokeWidth={2.4} />
      ) : (
        <ArrowUpToLine size={11} strokeWidth={2.4} />
      )}
      {inbound ? "รับเข้า" : "ส่งกลับ"}
    </span>
  );
}

/** Status pill (reuses syncMeta colors) for a table row. */
function StatusBadge({ status }: { status: SyncJobStatus }) {
  const sy = syncJobMeta(status);
  return (
    <span
      className="inline-flex items-center gap-[5px] rounded-[7px] px-[8px] py-1 text-[11px] font-semibold"
      style={{ background: sy.bg, color: sy.fg }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 99, background: sy.dot }} />
      {sy.label}
    </span>
  );
}

/** A per-direction summary card: total + per-status count chips (+ last-synced for
 *  inbound). */
function DirectionSummary({
  tone,
  label,
  en,
  total,
  counts,
  lastSynced,
}: {
  tone: "inbound" | "outbound";
  label: string;
  en: string;
  total: number;
  counts: SyncCountsDTO;
  /** Inbound only — last time KRS pushed data in. Omitted for outbound. */
  lastSynced?: string;
}) {
  const head = tone === "inbound" ? "#1d4ed8" : "#15803d";
  const headBg = tone === "inbound" ? "#eff6ff" : "#f0fdf4";
  return (
    <div
      className="flex flex-col gap-3 rounded-[14px] border px-[18px] py-4"
      style={{ background: "#fff", borderColor: "#e8edf3" }}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="inline-flex items-center gap-[7px] rounded-[8px] px-[10px] py-[6px] text-[12.5px] font-semibold"
          style={{ background: headBg, color: head }}
        >
          {tone === "inbound" ? (
            <ArrowDownToLine size={15} strokeWidth={2.2} />
          ) : (
            <ArrowUpToLine size={15} strokeWidth={2.2} />
          )}
          {label}
        </span>
        <span className="mono text-[22px] font-bold leading-none" style={{ color: "#0f172a" }}>
          {total}
        </span>
      </div>
      <div className="text-[10.5px]" style={{ color: "#94a3b8" }}>
        {en}
        {lastSynced !== undefined ? (
          <span className="ml-2">
            · รับล่าสุด{" "}
            <span className="mono font-semibold" style={{ color: "#334155" }}>
              {lastSynced}
            </span>
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-[6px]">
        {STATUS_ORDER.map((s) => {
          const sy = syncJobMeta(s);
          const n = counts[STATUS_COUNT_KEY[s]];
          return (
            <span
              key={s}
              className="inline-flex items-center gap-[5px] rounded-[7px] px-[8px] py-[5px] text-[11px] font-semibold"
              style={{ background: sy.bg, color: sy.fg, opacity: n === 0 ? 0.45 : 1 }}
            >
              <span
                style={{ width: 6, height: 6, borderRadius: 99, background: sy.dot }}
              />
              {sy.label}
              <span className="mono">{n}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function SyncActivityTab() {
  const [state, setState] = useState<LoadState>("loading");
  const [jobs, setJobs] = useState<SyncJobDTO[]>([]);
  const [search, setSearch] = useState("");
  const [dirFilter, setDirFilter] = useState<DirFilter>("all");
  const [selected, setSelected] = useState<SyncJobDTO | null>(null);

  // Mounted guard so a poll tick / in-flight fetch resolving after unmount never
  // calls setState (mirrors the DataFlowTab + page-level health-check pattern).
  const mountedRef = useRef(true);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/sync-jobs");
      if (!res.ok) throw new Error("sync-jobs failed");
      const json = (await res.json()) as SyncJobDTO[];
      if (!mountedRef.current) return;
      setJobs(Array.isArray(json) ? json : []);
      setState("ok");
    } catch {
      if (!mountedRef.current) return;
      // Keep any previously loaded rows so a transient poll error never blanks the
      // table; only show the full error screen when we have nothing yet.
      setState((prev) => (prev === "ok" ? "ok" : "error"));
    }
  }, []);

  // Initial load + ~30s near-realtime poll. Interval cleared + mounted guard flipped
  // on cleanup so there is no setState-after-unmount and no stuck timer.
  useEffect(() => {
    mountedRef.current = true;
    void fetchJobs();
    const id = setInterval(() => {
      void fetchJobs();
    }, ACTIVITY_POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [fetchJobs]);

  const manualRefresh = useCallback(async () => {
    if (state !== "ok" && state !== "error") setState("loading");
    await fetchJobs();
  }, [fetchJobs, state]);

  // Split by direction for the two summary rows.
  const inbound = useMemo(() => jobs.filter((j) => j.direction === "PULL"), [jobs]);
  const outbound = useMemo(
    () => jobs.filter((j) => j.direction === "INSERT"),
    [jobs]
  );

  const inboundCounts = useMemo(() => countByStatus(inbound), [inbound]);
  const outboundCounts = useMemo(() => countByStatus(outbound), [outbound]);
  const inboundLast = useMemo(() => lastSyncedTime(inbound), [inbound]);

  // Dormant-outbound inference: every outbound (INSERT) job is still PENDING (and at
  // least one exists) → the real KRS write (KRS_OUTBOUND_ENABLED, a NODE-only env)
  // is off and jobs are parked in the queue. We never read that env client-side.
  const outboundDormant = useMemo(
    () => outbound.length > 0 && outbound.every((j) => j.status === "PENDING"),
    [outbound]
  );

  // Filtered + sorted table rows: direction filter + ref search, newest first.
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = jobs.filter((j) => {
      if (dirFilter !== "all" && j.direction !== dirFilter) return false;
      if (q.length > 0 && !j.ref.toLowerCase().includes(q)) return false;
      return true;
    });
    // Newest first by updatedAt (the API is already desc; re-sort defensively so the
    // direction filter never disturbs ordering).
    return [...filtered].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [jobs, search, dirFilter]);

  // ---- Hard error state (nothing loaded yet) ----
  if (state === "error" && jobs.length === 0) {
    return (
      <div
        className="flex flex-col items-center gap-3 rounded-[14px] border bg-white px-[18px] py-[48px] text-center"
        style={{ borderColor: "#e8edf3" }}
      >
        <span
          className="grid h-[56px] w-[56px] place-items-center rounded-[18px]"
          style={{ background: "var(--red-soft)", color: "#dc2626" }}
        >
          <AlertCircle size={26} strokeWidth={2} />
        </span>
        <div className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>
          โหลดบันทึกการซิงค์ไม่สำเร็จ
        </div>
        <p
          className="m-0 max-w-[340px] text-[12px] leading-relaxed"
          style={{ color: "var(--muted)" }}
        >
          อ่านรายการซิงค์ไม่ได้ ลองใหม่อีกครั้ง · Could not load the sync activity —
          please retry.
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
          onClick={() => void manualRefresh()}
          className="flex h-[42px] items-center gap-2 rounded-[11px] border px-4 text-[13px] font-semibold transition hover:bg-[#f8fafc]"
          style={{ background: "#fff", borderColor: "#e2e8f0", color: "#334155" }}
        >
          <RefreshCw size={15} strokeWidth={2} />
          รีเฟรช
        </button>
        <div className="flex-1" />
        <div className="text-[12px]" style={{ color: "#94a3b8" }}>
          <span className="hidden sm:inline">อ่านอย่างเดียว · อัปเดตอัตโนมัติทุก ~30 วิ</span>
        </div>
      </div>

      {/* Per-direction summary rows */}
      <div className="grid grid-cols-1 gap-[10px] lg:grid-cols-2">
        <DirectionSummary
          tone="inbound"
          label="ขาเข้า · รับจาก KRS"
          en="Inbound · received from KRS (PULL)"
          total={inbound.length}
          counts={inboundCounts}
          lastSynced={inboundLast}
        />
        <DirectionSummary
          tone="outbound"
          label="ส่งกลับ · ส่งไป KRS"
          en="Outbound · queued / sent to KRS (INSERT)"
          total={outbound.length}
          counts={outboundCounts}
        />
      </div>

      {/* Dormant-outbound note (inferred: all INSERT jobs still PENDING) */}
      {outboundDormant ? (
        <div
          className="flex items-start gap-[10px] rounded-[12px] border px-[14px] py-[11px]"
          style={{ background: "#fffbeb", borderColor: "#fde68a" }}
        >
          <span style={{ color: "#b45309", marginTop: 1 }}>
            <Inbox size={16} strokeWidth={2} />
          </span>
          <p className="m-0 text-[12px] leading-relaxed" style={{ color: "#92400e" }}>
            ยังไม่เปิดส่งจริง — รายการถูกพักไว้ในคิว ·{" "}
            <span style={{ color: "#b45309" }}>
              Outbound write to KRS is off; jobs are parked in the queue until it is
              enabled.
            </span>
          </p>
        </div>
      ) : null}

      {/* Direction filter + ref search */}
      <div className="flex flex-wrap items-center gap-[10px]">
        <div className="flex gap-1 rounded-[11px] border p-1" style={{ borderColor: "#e2e8f0", background: "#fff" }}>
          {DIR_FILTERS.map((f) => {
            const active = dirFilter === f.key;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={active}
                onClick={() => setDirFilter(f.key)}
                className="rounded-[8px] px-[12px] py-[7px] text-[12px] font-semibold transition"
                style={
                  active
                    ? { background: "#16a34a", color: "#fff" }
                    : { background: "transparent", color: "#64748b" }
                }
              >
                {f.label}
                <span className="ml-1 text-[10px] font-normal opacity-80">{f.en}</span>
              </button>
            );
          })}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="ค้นหาอ้างอิง · Search reference"
          className="h-[40px] min-w-[180px] flex-1 rounded-[11px] border px-3 text-[13px] outline-none transition focus:border-[#16a34a]"
          style={{ background: "#fff", borderColor: "#e2e8f0", color: "#0f172a" }}
        />
      </div>

      {/* Jobs table */}
      <div
        className="overflow-hidden rounded-[14px] border"
        style={{ background: "#fff", borderColor: "#e8edf3" }}
      >
        <div
          className="grid gap-[10px] border-b px-[18px] py-[13px] text-[11.5px] font-semibold"
          style={{
            gridTemplateColumns: "92px 130px 1.4fr 110px 130px 70px",
            borderColor: "#eef2f6",
            color: "#94a3b8",
          }}
        >
          <div>ทิศทาง</div>
          <div>ประเภท · Type</div>
          <div>อ้างอิง · Ref</div>
          <div className="text-right">ยอด · Amount</div>
          <div>สถานะ · Status</div>
          <div className="text-right">เวลา</div>
        </div>

        {state === "loading" && jobs.length === 0 ? (
          <div
            className="px-[18px] py-[50px] text-center text-[13px]"
            style={{ color: "var(--soft)" }}
          >
            กำลังโหลด...
          </div>
        ) : rows.length === 0 ? (
          <div className="px-[18px] py-[50px] text-center">
            <div className="font-semibold" style={{ color: "#64748b" }}>
              {search.trim().length > 0 || dirFilter !== "all"
                ? "ไม่พบรายการที่ตรงกับการค้นหา"
                : "ยังไม่มีบันทึกการซิงค์"}
            </div>
          </div>
        ) : (
          rows.map((j) => {
            const amt = Number(j.amount);
            return (
              <button
                key={j.id}
                type="button"
                onClick={() => setSelected(j)}
                className="grid w-full items-center gap-[10px] border-b px-[18px] py-[12px] text-left transition hover:bg-[#f8fafc]"
                style={{
                  gridTemplateColumns: "92px 130px 1.4fr 110px 130px 70px",
                  borderColor: "#f4f7fa",
                }}
              >
                <div>
                  <DirectionBadge direction={j.direction} />
                </div>
                <div
                  className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium"
                  style={{ color: "#334155" }}
                >
                  {jobTypeLabel(j.type)}
                </div>
                <div
                  className="mono overflow-hidden text-ellipsis whitespace-nowrap text-[12px] font-semibold"
                  style={{ color: "#475569" }}
                >
                  {j.ref}
                </div>
                <div
                  className="mono text-right text-[12.5px] font-semibold"
                  style={{ color: "#0f172a" }}
                >
                  {amt === 0 ? "—" : money(amt)}
                </div>
                <div>
                  <StatusBadge status={j.status} />
                </div>
                <div className="mono text-right text-[12px]" style={{ color: "#94a3b8" }}>
                  {formatJobTime(j.updatedAt)}
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Footnote */}
      <p className="m-0 text-[11px] leading-relaxed" style={{ color: "#94a3b8" }}>
        บันทึกการซิงค์เป็นแบบอ่านอย่างเดียว (โพลทุก ~30 วิ) · ขาเข้า = ข้อมูลที่ KRS ส่งเข้ามา ·
        ส่งกลับ = รายการที่ POS เตรียมส่งกลับไป KRS · การส่งกลับจริงเปิด/ปิดด้วย
        KRS_OUTBOUND_ENABLED ที่ฝั่งเซิร์ฟเวอร์
      </p>

      {/* Read-only detail drawer (no retry/skip — those POST actions are simulated). */}
      <SyncDetailDrawer
        job={selected}
        busy={false}
        readOnly
        onClose={() => setSelected(null)}
        onRetry={() => {}}
        onSkip={() => {}}
      />
    </div>
  );
}

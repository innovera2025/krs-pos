"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, AlertCircle, RotateCcw } from "lucide-react";
import type { SyncJobDTO, SyncCountsDTO } from "@/types";
import { useToast } from "@/components/ToastProvider";
import { money } from "@/lib/money";
import { syncJobMeta, jobTypeLabel, directionMeta, formatJobTime } from "./syncMeta";
import { SyncKpiCards, type SyncFilter } from "./SyncKpiCards";
import { SyncDetailDrawer } from "./SyncDetailDrawer";

/**
 * Data Flow tab (KRS Data Link). The "ดึงข้อมูลจาก KRS" (pull) + "ส่งทั้งหมดเข้า KRS"
 * (insert-all) actions, the 5 KPI filter cards, the jobs table, and the
 * SyncDetailDrawer. Owns the live job list + the server actions; on every action it
 * refetches via `onRefetch` (passed from the page so the cards/table stay in sync).
 * The NavRail failed-job badge lives in the persistent (shell) layout and never
 * remounts on intra-shell nav, so after each successful action we also dispatch a
 * `krs:sync-jobs-changed` window event that the rail listens for to re-derive its
 * FAILED count. The KRS transport is SIMULATED — actions hit /api/sync-jobs.
 */
/**
 * Tell the persistent NavRail to re-derive its FAILED badge after a sync-jobs
 * mutation (the rail never remounts on intra-shell nav). SSR-guarded.
 */
function notifySyncJobsChanged() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("krs:sync-jobs-changed"));
  }
}

export function DataFlowTab({
  jobs,
  loading,
  error,
  onRefetch,
}: {
  jobs: SyncJobDTO[];
  loading: boolean;
  /** True when GET /api/sync-jobs failed (tri-state error, like /pos /products). */
  error: boolean;
  onRefetch: () => Promise<void> | void;
}) {
  const { showToast } = useToast();
  const [filter, setFilter] = useState<SyncFilter>("all");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<SyncJobDTO | null>(null);

  const counts: SyncCountsDTO = useMemo(
    () => ({
      pending: jobs.filter((j) => j.status === "PENDING").length,
      synced: jobs.filter((j) => j.status === "SYNCED").length,
      failed: jobs.filter((j) => j.status === "FAILED").length,
      retrying: jobs.filter((j) => j.status === "RETRYING").length,
      skipped: jobs.filter((j) => j.status === "SKIPPED").length,
    }),
    [jobs]
  );

  const filtered = useMemo(
    () =>
      filter === "all"
        ? jobs
        : jobs.filter((j) => j.status === filter.toUpperCase()),
    [jobs, filter]
  );

  const toggleFilter = (key: Exclude<SyncFilter, "all">) =>
    setFilter((f) => (f === key ? "all" : key));

  // ---- Simulated server actions ----
  const pull = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/sync-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pull" }),
      });
      if (!res.ok) throw new Error("pull failed");
      await onRefetch();
      notifySyncJobsChanged();
      showToast("ดึงข้อมูลจาก KRS แล้ว · map field → อัปเดต POS");
    } catch {
      showToast("ดึงข้อมูลไม่สำเร็จ · ลองอีกครั้ง");
    } finally {
      setBusy(false);
    }
  };

  const insertAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/sync-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "insert-all" }),
      });
      if (!res.ok) throw new Error("insert-all failed");
      const data = (await res.json()) as { synced?: number };
      await onRefetch();
      notifySyncJobsChanged();
      const n = data.synced ?? 0;
      showToast(
        n > 0
          ? `ส่งทั้งหมด ${n} รายการเข้า KRS สำเร็จ · INSERT ok`
          : "ไม่มีรายการรอ insert"
      );
    } catch {
      showToast("ส่งข้อมูลไม่สำเร็จ · ลองอีกครั้ง");
    } finally {
      setBusy(false);
    }
  };

  const retry = async (job: SyncJobDTO) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sync-jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry" }),
      });
      if (!res.ok) throw new Error("retry failed");
      await onRefetch();
      notifySyncJobsChanged();
      setDetail(null);
      showToast("ส่งบัญชีสำเร็จ · Synced successfully");
    } catch {
      showToast("ลองใหม่ไม่สำเร็จ · ตรวจสอบสถานะรายการ");
    } finally {
      setBusy(false);
    }
  };

  const skip = async (job: SyncJobDTO, reason: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sync-jobs/${job.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "skip", reason }),
      });
      if (!res.ok) throw new Error("skip failed");
      await onRefetch();
      notifySyncJobsChanged();
      setDetail(null);
      showToast("ทำเครื่องหมายข้ามแล้ว · Marked as skipped");
    } catch {
      showToast("ข้ามรายการไม่สำเร็จ · ตรวจสอบสถานะรายการ");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Action bar */}
      <div className="flex items-center gap-[10px]">
        <button
          type="button"
          onClick={pull}
          disabled={busy}
          className="flex h-[42px] items-center gap-2 rounded-[11px] border px-4 text-[13px] font-semibold transition hover:border-[#2563eb] hover:bg-[#eff6ff] disabled:opacity-50"
          style={{ background: "#fff", borderColor: "#e2e8f0", color: "#1d4ed8" }}
        >
          <ArrowDown size={16} strokeWidth={2} />
          ดึงข้อมูลจาก KRS
        </button>
        <button
          type="button"
          onClick={insertAll}
          disabled={busy}
          className="flex h-[42px] items-center gap-2 rounded-[11px] px-4 text-[13px] font-semibold text-white transition hover:brightness-105 disabled:opacity-50"
          style={{ background: "#16a34a", boxShadow: "0 4px 12px rgba(22,163,74,.25)" }}
        >
          <ArrowUp size={16} strokeWidth={2} />
          ส่งทั้งหมดเข้า KRS · {counts.pending}
        </button>
        <div className="flex-1" />
        <div className="text-[12.5px]" style={{ color: "#94a3b8" }}>
          ตัวกรอง:{" "}
          <span className="font-semibold" style={{ color: "#334155" }}>
            {filter === "all" ? "ทุกสถานะ" : syncJobMeta(filter.toUpperCase() as SyncJobDTO["status"]).label}
          </span>
        </div>
      </div>

      <SyncKpiCards counts={counts} active={filter} onToggle={toggleFilter} />

      {/* Jobs table */}
      <div className="overflow-hidden rounded-[14px] border" style={{ background: "#fff", borderColor: "#e8edf3" }}>
        <div
          className="grid gap-[10px] border-b px-[18px] py-[13px] text-[11.5px] font-semibold"
          style={{ gridTemplateColumns: "95px 1.3fr 150px 110px 80px 140px", borderColor: "#eef2f6", color: "#94a3b8" }}
        >
          <div>Job ID</div>
          <div>ประเภท · อ้างอิง</div>
          <div>ทิศทาง</div>
          <div className="text-right">ยอด</div>
          <div>เวลา</div>
          <div>สถานะ</div>
        </div>

        {loading && jobs.length === 0 ? (
          <div className="px-[18px] py-[50px] text-center text-[13px]" style={{ color: "var(--soft)" }}>
            กำลังโหลด...
          </div>
        ) : error && jobs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-[18px] py-[44px] text-center">
            <span
              className="grid h-[56px] w-[56px] place-items-center rounded-[18px]"
              style={{ background: "var(--red-soft)", color: "#dc2626" }}
            >
              <AlertCircle size={26} strokeWidth={2} />
            </span>
            <div className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>
              โหลดรายการซิงค์ไม่สำเร็จ
            </div>
            <p className="m-0 max-w-[320px] text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>
              ตรวจสอบการเชื่อมต่อแล้วลองใหม่ · Could not load sync jobs — check the connection and retry.
            </p>
            <button
              type="button"
              onClick={() => void onRefetch()}
              className="mt-1 inline-flex h-[38px] items-center gap-2 rounded-[10px] border px-4 text-[12.5px] font-semibold transition hover:bg-[#f8fafc]"
              style={{ borderColor: "#e2e8f0", color: "#334155" }}
            >
              <RotateCcw size={15} strokeWidth={2} />
              ลองใหม่ · Retry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-[18px] py-[50px] text-center">
            <div className="font-semibold" style={{ color: "#64748b" }}>
              ไม่มีรายการในสถานะนี้
            </div>
          </div>
        ) : (
          filtered.map((j) => {
            const sy = syncJobMeta(j.status);
            const dm = directionMeta(j.direction);
            const amt = Number(j.amount);
            return (
              <button
                key={j.id}
                type="button"
                onClick={() => setDetail(j)}
                className="grid w-full cursor-pointer items-center gap-[10px] border-b px-[18px] py-[14px] text-left transition hover:bg-[#f8fafc]"
                style={{ gridTemplateColumns: "95px 1.3fr 150px 110px 80px 140px", borderColor: "#f4f7fa" }}
              >
                <div className="mono text-[12px] font-semibold" style={{ color: "#475569" }}>
                  {j.id}
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium" style={{ color: "#334155" }}>
                    {jobTypeLabel(j.type)}
                  </div>
                  <div className="mono overflow-hidden text-ellipsis whitespace-nowrap text-[11px]" style={{ color: "#94a3b8" }}>
                    {j.ref}
                  </div>
                </div>
                <div>
                  <span
                    className="inline-flex items-center gap-[5px] rounded-[7px] px-[9px] py-1 text-[11px] font-semibold"
                    style={{ background: dm.bg, color: dm.color }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d={dm.icon} />
                    </svg>
                    {dm.label}
                  </span>
                </div>
                <div className="mono text-right text-[13px] font-semibold" style={{ color: "#0f172a" }}>
                  {amt === 0 ? "—" : money(amt)}
                </div>
                <div className="mono text-[12px]" style={{ color: "#94a3b8" }}>
                  {j.status === "PENDING" ? "—" : formatJobTime(j.updatedAt)}
                </div>
                <div>
                  <span
                    className="inline-flex items-center gap-[5px] rounded-[7px] px-[9px] py-1 text-[11.5px] font-semibold"
                    style={{ background: sy.bg, color: sy.fg }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: 99, background: sy.dot }} />
                    {sy.label}
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>

      <SyncDetailDrawer
        job={detail}
        busy={busy}
        onClose={() => setDetail(null)}
        onRetry={retry}
        onSkip={skip}
      />
    </div>
  );
}

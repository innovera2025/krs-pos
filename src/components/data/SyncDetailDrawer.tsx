"use client";

import { useEffect, useRef, useState } from "react";
import { X, RefreshCw, SkipForward, AlertTriangle } from "lucide-react";
import type { SyncJobDTO } from "@/types";
import { money } from "@/lib/money";
import { syncJobMeta, jobTypeLabel, formatJobTime } from "./syncMeta";

type SyncDetailDrawerProps = {
  job: SyncJobDTO | null;
  /** Disable action buttons while a retry/skip request is in flight. */
  busy: boolean;
  onClose: () => void;
  onRetry: (job: SyncJobDTO) => void;
  /** Skip with a user-supplied reason (inline panel — decision I, no window.prompt). */
  onSkip: (job: SyncJobDTO, reason: string) => void;
  /**
   * READ-ONLY mode (Sync Activity tab). When true the Retry/Skip action footer +
   * skip-reason panel are suppressed entirely — the drawer becomes a pure detail
   * view. The legacy retry/skip POST actions are SIMULATED, so the read-only Sync
   * Activity view never wires them. Defaults to false (the legacy interactive mode).
   */
  readOnly?: boolean;
};

/**
 * Sync-job detail right drawer (KRS Data Link). Mirrors SaleDetailDrawer: 440px
 * panel, slideIn .2s, backdrop fadeIn .12s, closes on backdrop/X/Escape with a
 * Tab focus-trap. Shows the job's id/type/status/ref/amount/provider/updated, an
 * error panel (red) when there's an error, and a response panel (dark mono) when
 * there's a response.
 *
 * Actions (server-gated; mirrors the PATCH route):
 *  - ลองใหม่ · Retry — when status ∈ {FAILED, RETRYING, PENDING} (canRetry)
 *  - ข้าม · Skip     — when status ∉ {SYNCED, SKIPPED} (canSkip); reveals an
 *    inline reason input panel (decision I) instead of a window.prompt.
 */
export function SyncDetailDrawer({
  job,
  busy,
  onClose,
  onRetry,
  onSkip,
  readOnly = false,
}: SyncDetailDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const open = job !== null;

  // Inline skip-reason panel state (decision I). Reset whenever the open job
  // changes so a fresh drawer never shows a stale reason / open panel.
  const [skipOpen, setSkipOpen] = useState(false);
  const [reason, setReason] = useState("");
  useEffect(() => {
    setSkipOpen(false);
    setReason("");
  }, [job?.id]);

  // Focus capture/restore + body-scroll lock + Tab focus-trap (deps [open] only —
  // mirrors the Modal/SaleDetailDrawer pattern so a fresh onClose closure never
  // re-runs it / steals focus).
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])'
        ) ?? []
      );

    (focusables()[0] ?? panelRef.current)?.focus();

    const onTabKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onTabKey);
    return () => {
      document.removeEventListener("keydown", onTabKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Escape closes (separate effect, deps [open, onClose]).
  useEffect(() => {
    if (!open) return;
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [open, onClose]);

  if (!job) return null;

  const sy = syncJobMeta(job.status);
  const canRetry =
    job.status === "FAILED" ||
    job.status === "RETRYING" ||
    job.status === "PENDING";
  const canSkip = job.status !== "SYNCED" && job.status !== "SKIPPED";

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex justify-end"
      style={{ background: "rgba(15,23,42,.4)", animation: "fadeIn .12s" }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`รายละเอียดงานซิงค์ ${job.id}`}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-[440px] max-w-[94vw] flex-col bg-white"
        style={{ boxShadow: "-10px 0 40px rgba(0,0,0,.2)", animation: "slideIn .2s" }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between border-b px-[22px] py-[18px]"
          style={{ borderColor: "#f1f5f9" }}
        >
          <div className="min-w-0">
            <div className="mono text-[16px] font-bold" style={{ color: "var(--ink)" }}>
              {job.id}
            </div>
            <div className="text-[12px]" style={{ color: "var(--soft)" }}>
              {jobTypeLabel(job.type)}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="grid h-[34px] w-[34px] place-items-center rounded-[9px] transition hover:bg-[#f1f5f9]"
            style={{ color: "var(--soft)" }}
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] py-5">
          <div className="mb-[18px]">
            <span
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold"
              style={{ background: sy.bg, color: sy.fg }}
            >
              <span style={{ width: 7, height: 7, borderRadius: 99, background: sy.dot }} />
              {sy.label} · {sy.en}
            </span>
          </div>

          <div className="flex flex-col gap-[11px] text-[13px]">
            <Row label="อ้างอิง · Reference">
              <span className="mono font-medium" style={{ color: "var(--ink)" }}>
                {job.ref}
              </span>
            </Row>
            <Row label="ยอด · Amount">
              <span className="mono text-[15px] font-bold" style={{ color: "var(--ink)" }}>
                {Number(job.amount) === 0 ? "—" : money(Number(job.amount))}
              </span>
            </Row>
            <Row label="ผู้ให้บริการ · Provider">
              <span className="font-medium">{job.provider}</span>
            </Row>
            <Row label="อัปเดตล่าสุด · Updated">
              <span className="mono">{formatJobTime(job.updatedAt)}</span>
            </Row>
          </div>

          {/* Error panel (red) */}
          {job.error ? (
            <div
              className="mt-4 rounded-[11px] border px-[13px] py-[11px]"
              style={{ background: "#fef2f2", borderColor: "#fecaca" }}
            >
              <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "#b91c1c" }}>
                <AlertTriangle size={14} strokeWidth={2} />
                ข้อผิดพลาด · Error
              </div>
              <div className="text-[12px] leading-relaxed" style={{ color: "#991b1b" }}>
                {job.error}
              </div>
            </div>
          ) : null}

          {/* Response panel (dark mono) */}
          {job.response ? (
            <div
              className="mono mt-4 rounded-[11px] px-[13px] py-[11px] text-[11.5px] leading-relaxed"
              style={{ background: "#0f172a", color: "#a7f3d0", wordBreak: "break-all" }}
            >
              <div className="mb-1 text-[10.5px] font-semibold" style={{ color: "#64748b" }}>
                การตอบกลับ · Response
              </div>
              {job.response}
            </div>
          ) : null}

          {/* Inline skip-reason panel (decision I) — suppressed in read-only mode */}
          {!readOnly && skipOpen ? (
            <div
              className="mt-4 rounded-[11px] border px-[13px] py-[12px]"
              style={{ background: "#faf5ff", borderColor: "#e9d5ff" }}
            >
              <label
                htmlFor="skip-reason"
                className="mb-1.5 block text-[12px] font-semibold"
                style={{ color: "#7c3aed" }}
              >
                เหตุผลที่ข้ามรายการนี้ · Reason to skip
              </label>
              <input
                id="skip-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="เช่น ออกเอกสารด้วยมือแล้ว"
                className="h-[40px] w-full rounded-[9px] border px-3 text-[13px]"
                style={{ borderColor: "#d8b4fe" }}
              />
              <div className="mt-2.5 flex gap-2">
                <button
                  type="button"
                  onClick={() => onSkip(job, reason)}
                  disabled={busy}
                  className="flex h-[40px] flex-1 items-center justify-center rounded-[10px] text-[13px] font-bold text-white transition hover:brightness-110 disabled:opacity-50"
                  style={{ background: "#7c3aed" }}
                >
                  ยืนยันข้าม · Confirm skip
                </button>
                <button
                  type="button"
                  onClick={() => setSkipOpen(false)}
                  disabled={busy}
                  className="flex h-[40px] items-center justify-center rounded-[10px] border px-4 text-[13px] font-semibold transition hover:bg-[#f8fafc] disabled:opacity-50"
                  style={{ borderColor: "var(--line)", color: "#475569" }}
                >
                  ยกเลิก
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {/* Actions — suppressed entirely in read-only mode (the legacy retry/skip
            POST actions are simulated and must not be wired from Sync Activity). */}
        {!readOnly && (canRetry || canSkip) && !skipOpen ? (
          <div
            className="flex flex-col gap-[9px] border-t px-[22px] py-4"
            style={{ borderColor: "#f1f5f9" }}
          >
            {canRetry ? (
              <button
                type="button"
                onClick={() => onRetry(job)}
                disabled={busy}
                className="flex h-[46px] items-center justify-center gap-2 rounded-[11px] text-[13.5px] font-bold text-white transition hover:bg-[#15803d] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ background: "#16a34a" }}
              >
                <RefreshCw size={16} strokeWidth={2} />
                ลองส่งใหม่ · Retry
              </button>
            ) : null}
            {canSkip ? (
              <button
                type="button"
                onClick={() => setSkipOpen(true)}
                disabled={busy}
                className="flex h-[46px] items-center justify-center gap-2 rounded-[11px] border text-[13px] font-semibold transition hover:bg-[#faf5ff] disabled:opacity-50"
                style={{ borderColor: "#e9d5ff", color: "#7c3aed" }}
              >
                <SkipForward size={16} strokeWidth={2} />
                ข้ามรายการนี้ · Skip
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: "var(--soft)" }}>{label}</span>
      {children}
    </div>
  );
}

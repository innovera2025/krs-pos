"use client";

import { useEffect, useRef, useState } from "react";
import { X, AlertTriangle, SlidersHorizontal } from "lucide-react";
import {
  GOLD,
  POINTS_TYPE_LABEL,
  fmtDate,
  fmtDateTime,
  fmtPoints,
  fmtSignedPoints,
  type MemberDetail,
  type MemberRow,
} from "@/components/members/memberMeta";

/**
 * Right-side ledger drawer for the /members screen (loyalty program, Phase 1B). On
 * open it fetches GET /api/members/[id] (member header + latest ~50 ledger rows) and
 * shows the gold points balance, a "ปรับแต้ม" button (ADMIN-only — the API is
 * `requireAdmin`), and the newest-first points history.
 *
 * A monotonic request token guards against a slow earlier fetch overwriting a newer
 * one (switching members quickly). `refreshToken` bumps force a refetch after a
 * successful adjust so the drawer reflects the new balance immediately.
 */

type LoadState = "loading" | "ready" | "error";

export function MemberLedgerDrawer({
  open,
  memberId,
  isAdmin,
  refreshToken,
  onClose,
  onRequestAdjust,
}: {
  open: boolean;
  memberId: string | null;
  isAdmin: boolean;
  refreshToken: number;
  onClose: () => void;
  onRequestAdjust: (member: MemberRow) => void;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!open || !memberId) return;
    const reqId = ++reqIdRef.current;
    setState("loading");
    fetch(`/api/members/${memberId}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: MemberDetail) => {
        if (reqId !== reqIdRef.current) return;
        setDetail(json);
        setState("ready");
      })
      .catch(() => {
        if (reqId !== reqIdRef.current) return;
        setState("error");
      });
  }, [open, memberId, refreshToken]);

  if (!open) return null;

  const member = detail?.member ?? null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      style={{ background: "rgba(8,20,15,.42)", backdropFilter: "blur(3px)" }}
      onClick={onClose}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="ประวัติแต้มสมาชิก"
        className="flex h-full w-[min(440px,calc(100vw-24px))] flex-col overflow-hidden bg-white"
        style={{ boxShadow: "-18px 0 40px rgba(8,20,15,.18)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <div className="min-w-0">
            <h2 className="m-0 truncate text-[16px] font-bold leading-tight">
              {member?.name ?? "สมาชิก"}
            </h2>
            <p className="mt-0.5 text-[12px]" style={{ color: "var(--muted)" }}>
              {member?.phone ? `${member.phone} · ` : ""}
              สมาชิกตั้งแต่ {fmtDate(member?.memberSince ?? null)}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[11px] border"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        {/* Balance + adjust */}
        <div className="px-5 py-4">
          <div
            className="flex items-center justify-between rounded-[16px] px-4 py-3.5"
            style={{ background: GOLD.bg }}
          >
            <span className="text-[12.5px] font-semibold" style={{ color: GOLD.fg }}>
              แต้มคงเหลือ
            </span>
            <span className="mono text-[24px] font-bold" style={{ color: GOLD.fg }}>
              {member ? fmtPoints(member.pointsBalance) : "—"}
            </span>
          </div>

          {isAdmin && member && (
            <button
              type="button"
              onClick={() => onRequestAdjust(member)}
              className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-[12px] text-[13.5px] font-bold text-white"
              style={{ background: GOLD.fg }}
            >
              <SlidersHorizontal size={16} strokeWidth={2.2} /> ปรับแต้ม
            </button>
          )}
        </div>

        {/* Ledger */}
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
          <h3
            className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--muted)" }}
          >
            ประวัติแต้ม · Points history
          </h3>

          {state === "loading" ? (
            <div
              className="grid place-items-center py-12 text-center text-[13px]"
              style={{ color: "var(--soft)" }}
            >
              กำลังโหลด…
            </div>
          ) : state === "error" ? (
            <div
              className="mx-auto flex max-w-[280px] flex-col items-center justify-center gap-3 py-12 text-center"
              style={{ color: "var(--muted)" }}
            >
              <span
                className="grid h-[56px] w-[56px] place-items-center rounded-[20px]"
                style={{ background: "var(--red-soft)", color: "#dc2626" }}
              >
                <AlertTriangle size={24} strokeWidth={2} />
              </span>
              <strong className="text-[13.5px]" style={{ color: "var(--ink)" }}>
                โหลดประวัติไม่สำเร็จ
              </strong>
            </div>
          ) : !detail || detail.ledger.length === 0 ? (
            <div
              className="grid place-items-center py-12 text-center text-[13px]"
              style={{ color: "var(--soft)" }}
            >
              ยังไม่มีประวัติแต้ม
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {detail.ledger.map((row) => {
                const credit = row.points > 0;
                return (
                  <li
                    key={row.id}
                    className="flex items-start justify-between gap-3 rounded-[12px] border px-3.5 py-2.5"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold" style={{ color: "var(--ink)" }}>
                          {POINTS_TYPE_LABEL[row.type]}
                        </span>
                      </div>
                      <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--muted)" }}>
                        {fmtDateTime(row.createdAt)}
                      </div>
                      {row.note && (
                        <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--soft)" }}>
                          {row.note}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end flex-shrink-0">
                      <span
                        className="mono text-[14px] font-bold"
                        style={{ color: credit ? GOLD.fg : "#dc2626" }}
                      >
                        {fmtSignedPoints(row.points)}
                      </span>
                      <span className="mono text-[11px]" style={{ color: "var(--muted)" }}>
                        คงเหลือ {fmtPoints(row.balanceAfter)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}

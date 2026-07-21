"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { GOLD, fmtPoints, type MemberRow } from "@/components/members/memberMeta";

/**
 * Manual points-adjust dialog (loyalty program, Phase 1B). ADMIN-only — the parent
 * only mounts/opens it for an admin, and POST /api/members/[id]/adjust is
 * `requireAdmin`, so this is UX gating over the real server boundary.
 *
 * The admin picks a DIRECTION (เพิ่ม/ลด) + a POSITIVE integer magnitude + an optional
 * note; the signed delta sent to the API is `+mag` (credit) or `−mag` (debit). A
 * client-side overdraw preview blocks a debit larger than the balance, but the SERVER
 * still enforces it atomically (POINTS_INSUFFICIENT) — the client guard is only to
 * save a round-trip and show the resulting balance.
 */

export type AdjustPayload = { points: number; note: string };

export function AdjustPointsModal({
  open,
  member,
  submitting,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  member: MemberRow | null;
  submitting: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (payload: AdjustPayload) => void;
}) {
  const [mode, setMode] = useState<"add" | "subtract">("add");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  // Reset the form whenever the dialog (re)opens for a member.
  useEffect(() => {
    if (open) {
      setMode("add");
      setAmount("");
      setNote("");
    }
  }, [open, member?.id]);

  const mag = Number(amount);
  const validMag = Number.isInteger(mag) && mag > 0 && mag <= 1_000_000;
  const signed = mode === "add" ? mag : -mag;
  const wouldOverdraw =
    mode === "subtract" && member != null && validMag && mag > member.pointsBalance;
  const newBalance =
    member != null && validMag ? member.pointsBalance + signed : member?.pointsBalance ?? 0;
  const canSubmit = validMag && !wouldOverdraw && !submitting;

  function submit() {
    if (!canSubmit) return;
    onSubmit({ points: signed, note: note.trim() });
  }

  return (
    <Modal open={open && member != null} onClose={onClose} label="ปรับแต้มสมาชิก">
      <div
        className="w-[min(420px,calc(100vw-32px))] rounded-[22px] bg-white p-5"
        style={{ boxShadow: "var(--shadow)" }}
      >
        <strong className="block text-[15px]">ปรับแต้มสมาชิก</strong>
        <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
          {member?.name ?? ""}
          {member?.phone ? ` · ${member.phone}` : ""}
        </p>

        {/* Current balance (gold). */}
        <div
          className="mt-3 flex items-center justify-between rounded-[14px] px-3.5 py-2.5"
          style={{ background: GOLD.bg }}
        >
          <span className="text-[12.5px]" style={{ color: GOLD.fg }}>
            แต้มคงเหลือปัจจุบัน
          </span>
          <span className="mono text-[16px] font-bold" style={{ color: GOLD.fg }}>
            {member ? fmtPoints(member.pointsBalance) : "0"}
          </span>
        </div>

        {/* Direction toggle. */}
        <div className="mt-4 flex items-center gap-1.5">
          <DirPill active={mode === "add"} onClick={() => setMode("add")}>
            เพิ่มแต้ม
          </DirPill>
          <DirPill active={mode === "subtract"} onClick={() => setMode("subtract")}>
            ลดแต้ม
          </DirPill>
        </div>

        {/* Magnitude. */}
        <label className="mt-3 block">
          <span className="text-[12.5px] font-semibold" style={{ color: "var(--ink)" }}>
            จำนวนแต้ม
          </span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="เช่น 50"
            autoFocus
            className="mt-1 h-11 w-full rounded-[12px] border px-3 text-[14px] font-medium outline-none"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          />
        </label>

        {/* Optional note. */}
        <label className="mt-3 block">
          <span className="text-[12.5px] font-semibold" style={{ color: "var(--ink)" }}>
            หมายเหตุ (ไม่บังคับ)
          </span>
          <input
            type="text"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder="เหตุผลในการปรับแต้ม"
            className="mt-1 h-11 w-full rounded-[12px] border px-3 text-[14px] font-medium outline-none"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          />
        </label>

        {/* New-balance preview / overdraw warning. */}
        {validMag && (
          <p
            className="mt-3 text-[12.5px] font-semibold"
            style={{ color: wouldOverdraw ? "#dc2626" : GOLD.fg }}
          >
            {wouldOverdraw
              ? "แต้มคงเหลือไม่พอสำหรับการปรับลด"
              : `แต้มคงเหลือใหม่: ${fmtPoints(newBalance)}`}
          </p>
        )}

        {error && (
          <p className="mt-3 text-[12.5px] font-semibold" style={{ color: "#dc2626" }}>
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="h-11 rounded-[12px] border px-4 text-[13.5px] font-semibold disabled:opacity-60"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            ยกเลิก
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="h-11 rounded-[12px] px-5 text-[13.5px] font-bold text-white disabled:opacity-60"
            style={{ background: GOLD.fg }}
          >
            {submitting ? "กำลังบันทึก…" : "บันทึกการปรับแต้ม"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DirPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-9 flex-1 rounded-full px-3.5 text-[12.5px] font-semibold transition"
      style={
        active
          ? { background: GOLD.fg, color: "#fff" }
          : { background: "#fff", color: "var(--muted)", border: "1px solid var(--line)" }
      }
    >
      {children}
    </button>
  );
}

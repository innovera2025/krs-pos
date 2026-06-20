"use client";

// Shell-scoped error boundary. Because it lives inside the (shell) route group it
// renders INSIDE the persistent layout, so the forest NavRail stays mounted and the
// cashier can navigate to a healthy screen instead of losing the whole frame. Same
// Taste fallback + retry as the root boundary, sized to fill the main workspace.

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function ShellError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      className="flex h-full min-h-0 items-center justify-center p-6"
      style={{ background: "var(--bg)", color: "var(--ink)" }}
    >
      <div
        className="w-full max-w-[420px] rounded-[var(--r-xl)] border bg-white p-9 text-center"
        style={{ borderColor: "var(--line)", boxShadow: "var(--shadow)" }}
      >
        <div
          className="mx-auto mb-5 grid h-[64px] w-[64px] place-items-center rounded-[20px]"
          style={{ background: "var(--red-soft)", color: "var(--red)" }}
        >
          <AlertTriangle size={30} strokeWidth={2} />
        </div>
        <h1
          className="m-0 text-[22px] font-bold tracking-tight"
          style={{ color: "var(--ink)" }}
        >
          หน้านี้เกิดข้อผิดพลาด
        </h1>
        <p className="mt-2 text-[13.5px]" style={{ color: "var(--muted)" }}>
          ไม่สามารถแสดงหน้านี้ได้ · This screen failed to load
        </p>
        <p
          className="mx-auto mt-2.5 max-w-[320px] text-[12.5px] leading-relaxed"
          style={{ color: "var(--soft)" }}
        >
          ลองโหลดใหม่ หรือเปลี่ยนไปเมนูอื่นจากแถบด้านซ้าย
          <br />
          Try again, or pick another screen from the side rail.
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-6 inline-flex h-[48px] items-center justify-center gap-2.5 rounded-[var(--r-md)] px-7 text-[15px] font-bold text-white"
          style={{
            border: 0,
            background: "linear-gradient(180deg,#22b877,#11865a)",
            boxShadow: "0 12px 26px rgba(31,169,113,.24)",
          }}
        >
          <RotateCcw size={18} strokeWidth={2.4} />
          ลองใหม่ · Retry
        </button>
      </div>
    </div>
  );
}

"use client";

// Root error boundary (Next.js App Router error.tsx convention). Catches render/
// data errors that escape any nested boundary so the whole app never shows a blank
// crash. Taste-styled (forest/mint, IBM Plex via --font-sans) with a Thai-first
// message + a retry that calls reset() to re-render the failed segment.

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the error to the console for diagnosis (no telemetry wired yet —
    // real reporting is production-readiness).
    console.error(error);
  }, [error]);

  return (
    <div
      className="flex min-h-screen items-center justify-center p-6"
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
          เกิดข้อผิดพลาด
        </h1>
        <p className="mt-2 text-[13.5px]" style={{ color: "var(--muted)" }}>
          ระบบทำงานผิดพลาด · Something went wrong
        </p>
        <p
          className="mx-auto mt-2.5 max-w-[320px] text-[12.5px] leading-relaxed"
          style={{ color: "var(--soft)" }}
        >
          ลองใหม่อีกครั้ง หากยังเกิดปัญหาให้แจ้งผู้ดูแลระบบ
          <br />
          Please try again. Contact your administrator if this keeps happening.
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

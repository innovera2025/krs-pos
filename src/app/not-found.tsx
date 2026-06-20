// Global 404 (Next.js App Router not-found.tsx convention). A Server Component —
// no client state needed. Taste-styled (forest/mint, IBM Plex via --font-sans) with
// a Thai-first message and a link back to the POS checkout home.

import Link from "next/link";
import { Compass, ArrowRight } from "lucide-react";

export default function NotFound() {
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
          style={{ background: "var(--mint)", color: "var(--brand-2)" }}
        >
          <Compass size={30} strokeWidth={2} />
        </div>
        <div
          className="mono text-[40px] font-bold leading-none"
          style={{ color: "var(--forest)" }}
        >
          404
        </div>
        <h1
          className="mt-3 text-[20px] font-bold tracking-tight"
          style={{ color: "var(--ink)" }}
        >
          ไม่พบหน้าที่ต้องการ
        </h1>
        <p className="mt-2 text-[13.5px]" style={{ color: "var(--muted)" }}>
          Page not found · หน้านี้อาจถูกย้ายหรือไม่มีอยู่
        </p>
        <Link
          href="/pos"
          className="mt-6 inline-flex h-[48px] items-center justify-center gap-2.5 rounded-[var(--r-md)] px-7 text-[15px] font-bold text-white"
          style={{
            background: "linear-gradient(180deg,#22b877,#11865a)",
            boxShadow: "0 12px 26px rgba(31,169,113,.24)",
          }}
        >
          กลับหน้าขาย · Go to POS
          <ArrowRight size={18} strokeWidth={2.4} />
        </Link>
      </div>
    </div>
  );
}

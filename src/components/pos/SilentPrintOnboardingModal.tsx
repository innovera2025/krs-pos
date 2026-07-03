"use client";

import { Printer, Download, X } from "lucide-react";
import { Modal } from "@/components/Modal";

type SilentPrintOnboardingModalProps = {
  open: boolean;
  /** Temporary close (X / backdrop) — the modal may re-appear on the next load. */
  onClose: () => void;
  /** Permanent dismiss — sets the dismissed flag; the modal never re-appears. */
  onDismissPermanently: () => void;
};

/** A single setup step. */
type SetupStep = { th: string; en: string };

/** Setup steps — mirror what the krs-print-agent-win.zip release actually does:
 *  extract the zip on the Windows cashier PC, run setup-print-agent.bat
 *  (SmartScreen → Run anyway), and the agent auto-starts + prints receipts
 *  silently from then on. The shop runs Windows only. */
const STEPS: SetupStep[] = [
  {
    th: "ดาวน์โหลดไฟล์ zip (~22MB) แล้วแตกไฟล์ (Extract All) บนเครื่องแคชเชียร์ Windows",
    en: "Download the zip (~22MB) and extract it (Extract All) on the Windows cashier PC.",
  },
  {
    th: "ดับเบิลคลิก setup-print-agent.bat ในโฟลเดอร์ที่แตกไฟล์ (ถ้า SmartScreen เตือน → กด More info → Run anyway)",
    en: "Double-click setup-print-agent.bat in the extracted folder (if SmartScreen warns → More info → Run anyway).",
  },
  {
    th: "ตัวติดตั้งจะติดตั้ง KRS Print Agent ให้ทำงานอัตโนมัติ → เปิด POS ใหม่ ใบเสร็จจะพิมพ์เงียบทันที",
    en: "It installs the KRS Print Agent (auto-start) → reopen the POS and receipts print silently.",
  },
];

/** Download target: the packaged print-agent zip on the GitHub release. Served
 *  by GitHub (attachment) — no in-app static file / headers() rule involved. */
const DOWNLOAD = {
  href: "https://github.com/innovera2025/krs-pos/releases/download/print-agent-v1/krs-print-agent-win.zip",
  file: "krs-print-agent-win.zip",
  labelTh: "ดาวน์โหลดตัวติดตั้ง (Windows · ~22MB)",
};

/**
 * SilentPrintOnboardingModal (silent-print onboarding, Plan B). First-run bilingual
 * guide that explains why a print dialog appears, then offers the local KRS Print
 * Agent download (`krs-print-agent-win.zip` from the GitHub release) with the
 * matching setup steps. Windows-only — the shop's cashier PCs run Windows.
 *
 * Pure consumer of the shared {@link Modal} primitive (focus-trap, Escape,
 * aria-modal handled there). Suppression state lives in `@/lib/kioskMode`; this
 * component only renders and reports intent via `onClose` / `onDismissPermanently`.
 * KRS POS Taste language: forest-green/mint palette, IBM Plex Sans Thai (global),
 * rounded cards, hairline borders — mirrors AddUserModal's header/body/footer shape.
 */
export function SilentPrintOnboardingModal({
  open,
  onClose,
  onDismissPermanently,
}: SilentPrintOnboardingModalProps) {
  return (
    <Modal open={open} onClose={onClose} label="ตั้งค่าพิมพ์ใบเสร็จ">
      <div
        className="w-[min(480px,calc(100vw-32px))] rounded-[22px] bg-white"
        style={{ boxShadow: "var(--shadow)" }}
      >
        {/* Section 1 — Header (icon + Thai title + EN subtitle + close) */}
        <header
          className="flex items-center gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <span
            className="grid h-10 w-10 place-items-center rounded-[14px]"
            style={{ background: "var(--mint)", color: "var(--brand-2)" }}
          >
            <Printer size={20} strokeWidth={2} />
          </span>
          <div className="flex-1">
            <strong className="block text-[15px]">ตั้งค่าพิมพ์ใบเสร็จอัตโนมัติ</strong>
            <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
              Silent Receipt Printing Setup
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิด"
            className="grid h-9 w-9 place-items-center rounded-[12px] border"
            style={{ borderColor: "var(--line)", color: "var(--muted)" }}
          >
            <X size={18} strokeWidth={2} />
          </button>
        </header>

        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Section 2 — Explanation (Thai primary, EN muted) */}
          <div className="flex flex-col gap-2">
            <p className="m-0 text-[13px] leading-relaxed" style={{ color: "var(--ink)" }}>
              เมื่อกดยืนยันการชำระเงิน เบราว์เซอร์จะเปิดหน้าต่างสั่งพิมพ์ทุกครั้ง
              เพื่อให้ใบเสร็จพิมพ์ออกทันทีโดยไม่มีหน้าต่างเด้ง ต้องติดตั้งโปรแกรมช่วยพิมพ์
              (KRS Print Agent) บนเครื่องแคชเชียร์ ทำเพียงครั้งเดียวต่อเครื่อง
            </p>
            <p className="m-0 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              Browsers show a print dialog every time by default. To print receipts
              instantly with no dialog, install the KRS Print Agent on the cashier
              PC — done once per device.
            </p>
          </div>

          {/* Section 3 — Numbered step guide */}
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
            {STEPS.map((step, i) => (
              <li key={i} className="flex items-start gap-3">
                <span
                  className="mt-0.5 grid h-6 w-6 flex-shrink-0 place-items-center rounded-full text-[12px] font-bold"
                  style={{ background: "var(--mint)", color: "var(--brand-2)" }}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-snug" style={{ color: "var(--ink)" }}>
                    {step.th}
                  </span>
                  <span
                    className="mt-0.5 block text-[11px] leading-snug"
                    style={{ color: "var(--muted)" }}
                  >
                    {step.en}
                  </span>
                </span>
              </li>
            ))}
          </ol>

          {/* Section 4 — Download button (forest-green pill, primary action) */}
          <div className="flex flex-col gap-2">
            <a
              href={DOWNLOAD.href}
              download={DOWNLOAD.file}
              aria-label={`ดาวน์โหลดไฟล์ติดตั้ง ${DOWNLOAD.file}`}
              className="flex h-12 w-full items-center justify-center gap-2.5 rounded-[15px] text-[14px] font-bold text-white"
              style={{
                background: "linear-gradient(180deg,#22b877,#11865a)",
                boxShadow: "0 12px 26px rgba(31,169,113,.22)",
              }}
            >
              <Download size={18} strokeWidth={2.2} />
              {DOWNLOAD.labelTh}
            </a>

            {/* First-run security note (small, muted) */}
            <p className="m-0 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
              หากเห็นหน้าต่าง &lsquo;Windows protected your PC&rsquo; ให้กด &lsquo;More info&rsquo;
              แล้ว &lsquo;Run anyway&rsquo;
              <br />
              If Windows shows a security warning, click &lsquo;More info&rsquo; then
              &lsquo;Run anyway&rsquo;.
            </p>
          </div>
        </div>

        {/* Section 5 — Permanent dismiss (outlined, mint/forest border) */}
        <footer className="border-t px-5 py-4" style={{ borderColor: "var(--line)" }}>
          <button
            type="button"
            onClick={onDismissPermanently}
            className="h-11 w-full rounded-[14px] border bg-white text-[13px] font-semibold"
            style={{ borderColor: "var(--brand)", color: "var(--brand-2)" }}
          >
            ตั้งค่าเสร็จแล้ว · ไม่ต้องแสดงอีก&nbsp;&nbsp;/&nbsp;&nbsp;Setup complete — don&rsquo;t show
            again
          </button>
        </footer>
      </div>
    </Modal>
  );
}

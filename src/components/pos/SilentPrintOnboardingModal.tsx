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

/** The three setup steps (Thai-first, EN muted below). Kept as data so the list
 *  markup stays a single map and the copy is easy to audit against the plan. */
const SETUP_STEPS: { th: string; en: string }[] = [
  {
    th: "ตรวจสอบว่าติดตั้งเครื่องพิมพ์ XP-80C แล้ว และพิมพ์หน้าทดสอบของ Windows ได้",
    en: "Ensure the XP-80C thermal printer is installed and prints a Windows test page.",
  },
  {
    th: "ดาวน์โหลดและดับเบิลคลิกไฟล์ตั้งค่า (ปุ่มด้านล่าง) ทำเพียงครั้งเดียวต่อเครื่อง",
    en: "Download and double-click the setup file below. Run it once per PC.",
  },
  {
    th: "เปิด POS จากไอคอน 'KRS POS' บนเดสก์ท็อปเท่านั้น (อย่าเปิดจากเบราว์เซอร์ธรรมดา)",
    en: "Always open the POS from the 'KRS POS' desktop icon — never from a plain browser window.",
  },
];

/**
 * SilentPrintOnboardingModal (silent-print onboarding, Plan A). First-run bilingual
 * guide that explains why a print dialog appears, offers a one-click download of
 * `kiosk-print-setup.bat`, and walks the operator through the three setup steps.
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
              เพื่อให้ใบเสร็จพิมพ์ออกทันทีโดยไม่มีหน้าต่างเด้ง ต้องตั้งค่าเครื่องหนึ่งครั้ง
              ไฟล์ตั้งค่าจะสร้างไอคอนพิเศษที่เปิด POS แบบพิมพ์เงียบ ทำเพียงครั้งเดียวต่อเครื่อง
            </p>
            <p className="m-0 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              Browsers show a print dialog every time by default. To print receipts
              instantly with no dialog, each PC needs a one-time setup. The setup file
              creates a special shortcut that launches the POS with silent printing —
              done once per PC.
            </p>
          </div>

          {/* Section 3 — Numbered 3-step guide */}
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
            {SETUP_STEPS.map((step, i) => (
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
          <div className="flex flex-col gap-1.5">
            <a
              href="/kiosk-print-setup.bat"
              download="kiosk-print-setup.bat"
              aria-label="ดาวน์โหลดไฟล์ตั้งค่า kiosk-print-setup.bat"
              className="flex h-12 w-full items-center justify-center gap-2.5 rounded-[15px] text-[14px] font-bold text-white"
              style={{
                background: "linear-gradient(180deg,#22b877,#11865a)",
                boxShadow: "0 12px 26px rgba(31,169,113,.22)",
              }}
            >
              <Download size={18} strokeWidth={2.2} />
              ดาวน์โหลดตัวตั้งค่า&nbsp;&nbsp;/&nbsp;&nbsp;Download Setup File
            </a>

            {/* SmartScreen note (small, muted) */}
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

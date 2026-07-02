"use client";

import { useEffect, useState } from "react";
import { Printer, Download, X } from "lucide-react";
import { Modal } from "@/components/Modal";

type SilentPrintOnboardingModalProps = {
  open: boolean;
  /** Temporary close (X / backdrop) — the modal may re-appear on the next load. */
  onClose: () => void;
  /** Permanent dismiss — sets the dismissed flag; the modal never re-appears. */
  onDismissPermanently: () => void;
};

/** Which platform the operator is on. Detection is client-side only (see the
 *  useEffect below); 'other' means we could not tell — we then show the Windows
 *  view but expose BOTH switch links so either file is one click away. */
type OS = "windows" | "mac" | "other";

/** A single setup step. `code` (optional) renders as a small mono block for
 *  copy-pasteable Terminal commands (Mac Gatekeeper unquarantine). */
type SetupStep = { th: string; en: string; code?: string };

/** Windows steps — mirror what deploy/kiosk-print-setup.bat actually does:
 *  double-click the .bat (SmartScreen → Run anyway), it locks XP-80C as the
 *  default printer + creates the "KRS POS" desktop shortcut, then open the POS
 *  from that icon for silent printing. */
const WINDOWS_STEPS: SetupStep[] = [
  {
    th: "ดาวน์โหลดแล้วดับเบิลคลิกไฟล์ .bat (ถ้า SmartScreen เตือน → กด More info → Run anyway)",
    en: "Download and double-click the .bat file (if SmartScreen warns → More info → Run anyway).",
  },
  {
    th: "ไฟล์จะตั้งเครื่องพิมพ์ XP-80C เป็นค่าเริ่มต้น และสร้างไอคอน 'KRS POS' บนเดสก์ท็อป",
    en: "It sets XP-80C as the default printer and creates a 'KRS POS' desktop icon.",
  },
  {
    th: "เปิด POS จากไอคอน 'KRS POS' เท่านั้น → ใบเสร็จพิมพ์เงียบทันที",
    en: "Open the POS from the 'KRS POS' icon only → receipts print silently.",
  },
];

/** Mac steps — mirror what deploy/kiosk-print-setup-mac.command actually does:
 *  the printer must already exist in CUPS, so add it first; a downloaded
 *  .command is quarantined so chmod +x + xattr -d, then double-click; it sets
 *  the CUPS default + builds the "KRS POS" Desktop app for silent printing. */
const MAC_STEPS: SetupStep[] = [
  {
    th: "เพิ่มเครื่องพิมพ์ก่อนที่ System Settings > Printers & Scanners",
    en: "Add the printer first in System Settings > Printers & Scanners.",
  },
  {
    th: "เปิด Terminal รันสองคำสั่งนี้กับไฟล์ .command แล้วดับเบิลคลิก (ครั้งแรกคลิกขวา > Open)",
    en: "In Terminal run these on the .command file, then double-click it (first time: right-click > Open).",
    code: "chmod +x kiosk-print-setup-mac.command\nxattr -d com.apple.quarantine kiosk-print-setup-mac.command",
  },
  {
    th: "ไฟล์จะตั้งเครื่องพิมพ์เป็นค่าเริ่มต้น และสร้างแอป 'KRS POS' บน Desktop",
    en: "It sets the default printer and creates a 'KRS POS' app on the Desktop.",
  },
  {
    th: "เปิด POS จากแอป 'KRS POS' เท่านั้น → ใบเสร็จพิมพ์เงียบทันที",
    en: "Open the POS from the 'KRS POS' app only → receipts print silently.",
  },
];

/** Per-OS download target. Both files live in public/ and are force-downloaded
 *  by the next.config.mjs headers() rules. Keep paths in sync with those rules. */
const DOWNLOAD: Record<"windows" | "mac", { href: string; file: string; labelTh: string }> = {
  windows: {
    href: "/kiosk-print-setup.bat",
    file: "kiosk-print-setup.bat",
    labelTh: "ดาวน์โหลดตัวตั้งค่า (Windows)",
  },
  mac: {
    href: "/kiosk-print-setup-mac.command",
    file: "kiosk-print-setup-mac.command",
    labelTh: "ดาวน์โหลดตัวตั้งค่า (Mac)",
  },
};

/** navigator.userAgentData is not in the base DOM lib typings; narrow it here. */
type NavigatorUAData = Navigator & { userAgentData?: { platform?: string } };

/**
 * SilentPrintOnboardingModal (silent-print onboarding, Plan A). First-run bilingual
 * guide that explains why a print dialog appears, then — OS-aware — offers the
 * correct one-click setup file and matching steps: Windows (`kiosk-print-setup.bat`)
 * or macOS (`kiosk-print-setup-mac.command`). The OS is detected client-side; a
 * small manual toggle recovers from a wrong guess.
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
  // SSR-safe: default to 'windows' so server and first client render agree (no
  // hydration mismatch); the effect corrects it after mount from the real UA.
  const [os, setOs] = useState<OS>("windows");

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const uaData = (navigator as NavigatorUAData).userAgentData;
    // Prefer the modern high-entropy hint (e.g. "macOS"/"Windows"); fall back to
    // the classic userAgent string. Match case-insensitively across both.
    const hay = `${uaData?.platform ?? ""} ${navigator.userAgent ?? ""}`;
    if (/mac|macintosh/i.test(hay)) setOs("mac");
    else if (/windows/i.test(hay)) setOs("windows");
    else setOs("other");
  }, []);

  // 'other' falls back to the Windows view; only an explicit 'mac' shows Mac.
  const isMac = os === "mac";
  const steps = isMac ? MAC_STEPS : WINDOWS_STEPS;
  const dl = isMac ? DOWNLOAD.mac : DOWNLOAD.windows;

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
          {/* Section 2 — Explanation (Thai primary, EN muted) — OS-neutral */}
          <div className="flex flex-col gap-2">
            <p className="m-0 text-[13px] leading-relaxed" style={{ color: "var(--ink)" }}>
              เมื่อกดยืนยันการชำระเงิน เบราว์เซอร์จะเปิดหน้าต่างสั่งพิมพ์ทุกครั้ง
              เพื่อให้ใบเสร็จพิมพ์ออกทันทีโดยไม่มีหน้าต่างเด้ง ต้องตั้งค่าเครื่องหนึ่งครั้ง
              ไฟล์ตั้งค่าจะสร้างไอคอนพิเศษที่เปิด POS แบบพิมพ์เงียบ ทำเพียงครั้งเดียวต่อเครื่อง
            </p>
            <p className="m-0 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              Browsers show a print dialog every time by default. To print receipts
              instantly with no dialog, each device needs a one-time setup. The setup
              file creates a special shortcut that launches the POS with silent
              printing — done once per device.
            </p>
          </div>

          {/* Section 3 — Numbered OS-appropriate step guide */}
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
            {steps.map((step, i) => (
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
                  {step.code && (
                    <code
                      className="mono mt-1 block whitespace-pre-wrap break-all rounded-[8px] border px-2.5 py-1.5 text-[10.5px] leading-relaxed"
                      style={{
                        background: "var(--surface-2)",
                        borderColor: "var(--line)",
                        color: "var(--ink)",
                      }}
                    >
                      {step.code}
                    </code>
                  )}
                </span>
              </li>
            ))}
          </ol>

          {/* Section 4 — OS-aware download button (forest-green pill, primary action) */}
          <div className="flex flex-col gap-2">
            <a
              href={dl.href}
              download={dl.file}
              aria-label={`ดาวน์โหลดไฟล์ตั้งค่า ${dl.file}`}
              className="flex h-12 w-full items-center justify-center gap-2.5 rounded-[15px] text-[14px] font-bold text-white"
              style={{
                background: "linear-gradient(180deg,#22b877,#11865a)",
                boxShadow: "0 12px 26px rgba(31,169,113,.22)",
              }}
            >
              <Download size={18} strokeWidth={2.2} />
              {dl.labelTh}
            </a>

            {/* Manual OS toggle — recover from a wrong auto-detection. */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
              {os === "other" ? (
                <>
                  <button
                    type="button"
                    onClick={() => setOs("windows")}
                    className="underline underline-offset-2"
                    style={{ color: "var(--brand-2)" }}
                  >
                    ใช้ Windows? โหลดเวอร์ชัน Windows
                  </button>
                  <button
                    type="button"
                    onClick={() => setOs("mac")}
                    className="underline underline-offset-2"
                    style={{ color: "var(--brand-2)" }}
                  >
                    ใช้ Mac? โหลดเวอร์ชัน Mac
                  </button>
                </>
              ) : isMac ? (
                <button
                  type="button"
                  onClick={() => setOs("windows")}
                  className="underline underline-offset-2"
                  style={{ color: "var(--brand-2)" }}
                >
                  ใช้ Windows อยู่? โหลดเวอร์ชัน Windows
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setOs("mac")}
                  className="underline underline-offset-2"
                  style={{ color: "var(--brand-2)" }}
                >
                  ใช้ Mac อยู่? โหลดเวอร์ชัน Mac
                </button>
              )}
            </div>

            {/* OS-appropriate first-run security note (small, muted) */}
            {isMac ? (
              <p className="m-0 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                ครั้งแรก macOS อาจบล็อกไฟล์ที่ดาวน์โหลด (Gatekeeper) — คลิกขวาที่ไฟล์แล้วเลือก
                &lsquo;Open&rsquo;
                <br />
                First run, macOS may block the downloaded file (Gatekeeper) — right-click it
                and choose &lsquo;Open&rsquo;.
              </p>
            ) : (
              <p className="m-0 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                หากเห็นหน้าต่าง &lsquo;Windows protected your PC&rsquo; ให้กด &lsquo;More info&rsquo;
                แล้ว &lsquo;Run anyway&rsquo;
                <br />
                If Windows shows a security warning, click &lsquo;More info&rsquo; then
                &lsquo;Run anyway&rsquo;.
              </p>
            )}
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

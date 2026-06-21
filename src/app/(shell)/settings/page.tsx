"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Printer,
  SlidersHorizontal,
  AlertTriangle,
  Check,
} from "lucide-react";
import { useToast } from "@/components/ToastProvider";
import { AdminOnly } from "@/components/AdminOnly";
import type { ShopSettingsDTO } from "@/types";

/**
 * Shop Settings screen (Receipt print-size feature) — admin-only.
 *
 * Built in the Taste language (forest/mint, rounded cards, Thai-first microcopy)
 * because the Settings IA from `design/Simple POS.dc.html` has no mockup. Mirrors
 * the other admin screens (AdminOnly wrapper, header + brand-green action, card
 * surfaces with `--line`/`--shadow-sm`).
 *
 * The single "เครื่องพิมพ์ · Printer" card configures the thermal-receipt page
 * size: width = preset chips (58/80) + a free mm input (40–120); height = an Auto
 * toggle + an mm input shown when fixed (50–400). A live preview line summarizes
 * the choice, and Save PATCHes /api/settings (admin-gated).
 *
 * ⚠️ This client component does NOT import the NODE-only Zod schema
 * (`@/lib/schemas/shopSettings`). It POSTs raw values and surfaces the server's
 * `{ error, code: "VALIDATION" }` message; the server re-validates the bounds.
 */

/** Width bounds (mm) — mirror the server schema for client-side guidance. */
const WIDTH_MIN = 40;
const WIDTH_MAX = 120;
/** Fixed-height bounds (mm) — mirror the server schema. */
const HEIGHT_MIN = 50;
const HEIGHT_MAX = 400;
/** Common thermal presets surfaced as chips. */
const WIDTH_PRESETS = [58, 80] as const;
/** Default mm shown in the height input when switching from Auto → Fixed. */
const DEFAULT_FIXED_HEIGHT = 150;

type LoadState = "loading" | "ready" | "error";

export default function SettingsPage() {
  return (
    <AdminOnly>
      <SettingsScreen />
    </AdminOnly>
  );
}

function SettingsScreen() {
  const { showToast } = useToast();

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [saving, setSaving] = useState(false);

  // Form state. Width + height(mm) are kept as STRING drafts so the inputs can be
  // cleared while typing; they are parsed/validated at save time.
  const [widthDraft, setWidthDraft] = useState("80");
  const [heightAuto, setHeightAuto] = useState(true);
  const [heightDraft, setHeightDraft] = useState(String(DEFAULT_FIXED_HEIGHT));

  async function loadSettings() {
    setLoadState("loading");
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { settings: ShopSettingsDTO };
      const s = data.settings;
      setWidthDraft(String(s.receiptWidthMm));
      setHeightAuto(s.receiptHeightAuto);
      setHeightDraft(
        String(
          s.receiptHeightMm != null ? s.receiptHeightMm : DEFAULT_FIXED_HEIGHT
        )
      );
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }

  useEffect(() => {
    loadSettings();
  }, []);

  // Parsed width (NaN when empty/invalid). Drives preset-chip highlight + preview.
  const widthNum = useMemo(() => {
    const n = parseInt(widthDraft, 10);
    return Number.isFinite(n) ? n : NaN;
  }, [widthDraft]);

  const heightNum = useMemo(() => {
    const n = parseInt(heightDraft, 10);
    return Number.isFinite(n) ? n : NaN;
  }, [heightDraft]);

  // Client-side validity (server re-validates). Width must be in range; a FIXED
  // height must be a number in range. Auto height needs no mm value.
  const widthValid =
    Number.isInteger(widthNum) && widthNum >= WIDTH_MIN && widthNum <= WIDTH_MAX;
  const heightValid =
    heightAuto ||
    (Number.isInteger(heightNum) &&
      heightNum >= HEIGHT_MIN &&
      heightNum <= HEIGHT_MAX);
  const canSave = widthValid && heightValid && !saving;

  // Live preview: "กว้าง 80mm × สูงอัตโนมัติ" / "× สูง 150mm".
  const preview = useMemo(() => {
    const w = widthValid ? `${widthNum}mm` : "—";
    const h = heightAuto
      ? "สูงอัตโนมัติ"
      : heightValid
      ? `สูง ${heightNum}mm`
      : "สูง —";
    return `กว้าง ${w} × ${h}`;
  }, [widthValid, widthNum, heightAuto, heightValid, heightNum]);

  function selectPreset(mm: number) {
    setWidthDraft(String(mm));
  }

  function toggleAuto(next: boolean) {
    setHeightAuto(next);
    // When switching to Fixed with an empty/invalid draft, seed a sane default.
    if (!next && !(Number.isInteger(heightNum) && heightNum >= HEIGHT_MIN)) {
      setHeightDraft(String(DEFAULT_FIXED_HEIGHT));
    }
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiptWidthMm: widthNum,
          receiptHeightAuto: heightAuto,
          // Auto height ⇒ null (the server also forces this); fixed ⇒ the mm value.
          receiptHeightMm: heightAuto ? null : heightNum,
        }),
      });
      if (!res.ok) {
        let msg = "บันทึกการตั้งค่าไม่สำเร็จ";
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          /* keep default */
        }
        showToast(msg);
        return;
      }
      const data = (await res.json()) as { settings: ShopSettingsDTO };
      const s = data.settings;
      // Re-sync drafts from the saved (normalized) row so the UI reflects truth.
      setWidthDraft(String(s.receiptWidthMm));
      setHeightAuto(s.receiptHeightAuto);
      if (s.receiptHeightMm != null) setHeightDraft(String(s.receiptHeightMm));
      showToast("บันทึกการตั้งค่าแล้ว");
    } catch {
      showToast("บันทึกการตั้งค่าไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-auto p-[22px]">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3.5">
        <span
          aria-hidden="true"
          className="grid h-11 w-11 place-items-center rounded-[14px]"
          style={{ background: "var(--mint)", color: "var(--brand-2)" }}
        >
          <SlidersHorizontal size={20} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-[220px]">
          <h1 className="m-0 text-[24px] font-bold leading-[1.08] tracking-tight">
            ตั้งค่าร้านค้า
          </h1>
          <p className="mt-1 text-[12.5px]" style={{ color: "var(--muted)" }}>
            Shop Settings · ขนาดใบเสร็จและการพิมพ์
          </p>
        </div>
      </header>

      {loadState === "loading" ? (
        <div
          className="grid flex-1 place-items-center py-16 text-center text-[13px]"
          style={{ color: "var(--soft)" }}
        >
          กำลังโหลดการตั้งค่า…
        </div>
      ) : loadState === "error" ? (
        <div
          className="mx-auto flex max-w-[320px] flex-1 flex-col items-center justify-center gap-3 py-16 text-center"
          style={{ color: "var(--muted)" }}
        >
          <span
            className="grid h-[64px] w-[64px] place-items-center rounded-[22px]"
            style={{ background: "var(--red-soft)", color: "#dc2626" }}
          >
            <AlertTriangle size={28} strokeWidth={2} />
          </span>
          <strong className="text-[14px]" style={{ color: "var(--ink)" }}>
            โหลดการตั้งค่าไม่สำเร็จ
          </strong>
          <button
            type="button"
            onClick={loadSettings}
            className="h-10 rounded-[12px] border px-4 text-[13px] font-semibold"
            style={{ borderColor: "var(--line)" }}
          >
            ลองใหม่
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex max-w-[620px] flex-col gap-4"
        >
          {/* Printer card */}
          <section
            className="flex flex-col gap-5 rounded-[18px] border bg-white p-5"
            style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
          >
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="grid h-9 w-9 place-items-center rounded-[12px]"
                style={{ background: "var(--mint)", color: "var(--brand-2)" }}
              >
                <Printer size={18} strokeWidth={2} />
              </span>
              <div>
                <strong className="block text-[14.5px]">เครื่องพิมพ์</strong>
                <span
                  className="block text-[11.5px]"
                  style={{ color: "var(--muted)" }}
                >
                  Printer · ขนาดกระดาษใบเสร็จความร้อน
                </span>
              </div>
            </div>

            {/* Width */}
            <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
              <legend className="mb-0.5 p-0 text-[12.5px] font-semibold">
                ความกว้าง · Width
              </legend>
              <div className="flex flex-wrap items-center gap-2">
                {WIDTH_PRESETS.map((mm) => {
                  const active = widthNum === mm;
                  return (
                    <button
                      key={mm}
                      type="button"
                      onClick={() => selectPreset(mm)}
                      aria-pressed={active}
                      className="h-9 rounded-full border px-4 text-[12.5px] font-semibold transition"
                      style={{
                        borderColor: active ? "var(--brand)" : "var(--line)",
                        background: active ? "var(--brand)" : "#fff",
                        color: active ? "#fff" : "var(--ink)",
                      }}
                    >
                      {mm}mm
                    </button>
                  );
                })}
                <label className="flex items-center gap-2">
                  <span
                    className="text-[12px]"
                    style={{ color: "var(--muted)" }}
                  >
                    กำหนดเอง
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={WIDTH_MIN}
                    max={WIDTH_MAX}
                    value={widthDraft}
                    onChange={(e) => setWidthDraft(e.target.value)}
                    aria-label="ความกว้าง (มม.)"
                    aria-invalid={!widthValid}
                    className="h-9 w-[88px] rounded-[10px] border px-3 text-[13px]"
                    style={{
                      borderColor: widthValid ? "var(--line)" : "#fca5a5",
                    }}
                  />
                  <span
                    className="text-[12px]"
                    style={{ color: "var(--muted)" }}
                  >
                    mm
                  </span>
                </label>
              </div>
              {!widthValid && (
                <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                  ความกว้างต้องเป็น {WIDTH_MIN}–{WIDTH_MAX} มม.
                </span>
              )}
            </fieldset>

            {/* Height */}
            <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
              <legend className="mb-0.5 p-0 text-[12.5px] font-semibold">
                ความสูง · Height
              </legend>
              <label className="flex cursor-pointer items-center gap-2.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={heightAuto}
                  onClick={() => toggleAuto(!heightAuto)}
                  className="relative h-6 w-11 flex-shrink-0 rounded-full transition"
                  style={{
                    background: heightAuto ? "var(--brand)" : "#cbd5e1",
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
                    style={{ left: heightAuto ? 22 : 2 }}
                  />
                </button>
                <span className="text-[13px] font-semibold">
                  อัตโนมัติ · Auto
                </span>
                <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                  (ยาวตามเนื้อหาบิล)
                </span>
              </label>

              {!heightAuto && (
                <label className="flex items-center gap-2">
                  <span
                    className="text-[12px]"
                    style={{ color: "var(--muted)" }}
                  >
                    ความสูงคงที่
                  </span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={HEIGHT_MIN}
                    max={HEIGHT_MAX}
                    value={heightDraft}
                    onChange={(e) => setHeightDraft(e.target.value)}
                    aria-label="ความสูง (มม.)"
                    aria-invalid={!heightValid}
                    className="h-9 w-[100px] rounded-[10px] border px-3 text-[13px]"
                    style={{
                      borderColor: heightValid ? "var(--line)" : "#fca5a5",
                    }}
                  />
                  <span
                    className="text-[12px]"
                    style={{ color: "var(--muted)" }}
                  >
                    mm
                  </span>
                </label>
              )}
              {!heightValid && (
                <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                  ความสูงต้องเป็น {HEIGHT_MIN}–{HEIGHT_MAX} มม.
                </span>
              )}
            </fieldset>

            {/* Live preview */}
            <div
              className="flex items-center gap-2.5 rounded-[12px] px-3.5 py-3"
              style={{ background: "var(--surface-2)" }}
            >
              <span
                aria-hidden="true"
                className="grid h-8 w-8 place-items-center rounded-[10px]"
                style={{ background: "var(--mint)", color: "var(--brand-2)" }}
              >
                <Printer size={15} strokeWidth={2} />
              </span>
              <div className="flex flex-col">
                <span
                  className="text-[10.5px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--muted)" }}
                >
                  ตัวอย่างขนาดใบเสร็จ · Preview
                </span>
                <strong className="text-[13.5px]" style={{ color: "var(--ink)" }}>
                  {preview}
                </strong>
              </div>
            </div>
          </section>

          {/* Save */}
          <div className="flex items-center justify-end gap-2.5">
            <button
              type="submit"
              disabled={!canSave}
              className="flex h-11 items-center gap-2 rounded-[12px] px-5 text-[13.5px] font-bold text-white disabled:opacity-50"
              style={{ background: "var(--brand)", boxShadow: "var(--shadow-sm)" }}
            >
              <Check size={17} strokeWidth={2.5} />
              {saving ? "กำลังบันทึก…" : "บันทึกการตั้งค่า"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

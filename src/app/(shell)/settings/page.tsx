"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Printer,
  SlidersHorizontal,
  AlertTriangle,
  Check,
  Building2,
  Sparkles,
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

/**
 * Loyalty accent (loyalty program, Phase 1A) — a distinct gold/amber tone so the
 * "โปรแกรมสมาชิก / แต้มสะสม" card never reads as mint (promotions) or blue (tax).
 * Inline hex (not a CSS var) because these are loyalty-only, per the plan's palette.
 */
const GOLD = "#B45309";
const GOLD_BG = "#FFFBEB";
/** Earn-rate lower bound (mirrors the server Zod min). */
const EARN_MIN = 1;

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

  // Seller-identity drafts (seller-company-settings) — string drafts mirroring the
  // DB nullable fields ("" = empty/clear). NOTE: the form does NOT pre-fill from
  // ENV — a DB-null field shows blank, so saving blank leaves it null (ENV fallback
  // still applies in getSellerConfig). The owner must actively type to set DB values.
  const [sellerName, setSellerName] = useState("");
  const [sellerTaxId, setSellerTaxId] = useState("");
  const [sellerAddress, setSellerAddress] = useState("");
  const [sellerPhone, setSellerPhone] = useState("");
  const [sellerPosId, setSellerPosId] = useState("");
  const [sellerBranchCode, setSellerBranchCode] = useState("");
  const [sellerBranchLabel, setSellerBranchLabel] = useState("");

  // Loyalty program config (loyalty program, Phase 1A). `loyaltyEnabled` is the
  // master switch; the three numeric fields are STRING drafts (clearable while
  // typing, parsed at save). `pointValueBahtDraft` shows the point value in BAHT
  // (1 แต้ม = ฿X.XX) while the API stores + sends satang — converted at the boundary.
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(false);
  const [earnDraft, setEarnDraft] = useState("25");
  const [pointValueBahtDraft, setPointValueBahtDraft] = useState("0.10");
  const [minRedeemDraft, setMinRedeemDraft] = useState("0");

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
      // Seller drafts — null DB value → blank input.
      setSellerName(s.sellerName ?? "");
      setSellerTaxId(s.sellerTaxId ?? "");
      setSellerAddress(s.sellerAddress ?? "");
      setSellerPhone(s.sellerPhone ?? "");
      setSellerPosId(s.sellerPosId ?? "");
      setSellerBranchCode(s.sellerBranchCode ?? "");
      setSellerBranchLabel(s.sellerBranchLabel ?? "");
      // Loyalty drafts — satang → baht for the point-value display.
      setLoyaltyEnabled(s.loyaltyEnabled);
      setEarnDraft(String(s.earnBahtPerPoint));
      setPointValueBahtDraft((s.redeemPointValueSatang / 100).toFixed(2));
      setMinRedeemDraft(String(s.minRedeemPoints));
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

  // Loyalty parsed values (loyalty program, Phase 1A). Earn = integer baht/point
  // ≥ 1; point value is entered in BAHT → converted to satang int ≥ 0 (what the API
  // stores/sends); min redeem = integer ≥ 0. These mirror the server Zod bounds.
  const earnNum = parseInt(earnDraft, 10);
  const pointValueBahtNum = parseFloat(pointValueBahtDraft);
  const pointValueSatang = Number.isFinite(pointValueBahtNum)
    ? Math.round(pointValueBahtNum * 100)
    : NaN;
  const minRedeemNum = parseInt(minRedeemDraft, 10);
  const earnValid = Number.isInteger(earnNum) && earnNum >= EARN_MIN;
  const pointValueValid =
    Number.isInteger(pointValueSatang) && pointValueSatang >= 0;
  const minRedeemValid = Number.isInteger(minRedeemNum) && minRedeemNum >= 0;
  const loyaltyValid = earnValid && pointValueValid && minRedeemValid;

  const canSave =
    widthValid && heightValid && loyaltyValid && !saving;

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

  // §86/4 completeness for the status line — name + TIN + address must all be
  // non-empty (in the FORM). NOTE this reflects the DB-edit state only; an empty
  // form may still resolve via ENV fallback at issue time, so the copy is framed as
  // "ข้อมูลในระบบ" guidance, not an absolute block.
  const sellerComplete =
    sellerName.trim() !== "" &&
    sellerTaxId.trim() !== "" &&
    sellerAddress.trim() !== "";

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
          // Seller identity — sent as raw strings (incl. ""); the server trims and
          // converts "" → null. One PATCH carries both receipt-size + seller fields.
          sellerName,
          sellerTaxId,
          sellerAddress,
          sellerPhone,
          sellerPosId,
          sellerBranchCode,
          sellerBranchLabel,
          // Loyalty config — point value entered in baht, sent as satang int.
          loyaltyEnabled,
          earnBahtPerPoint: earnNum,
          redeemPointValueSatang: pointValueSatang,
          minRedeemPoints: minRedeemNum,
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
      // Seller drafts reflect the normalized row ("" cleared → null → blank).
      setSellerName(s.sellerName ?? "");
      setSellerTaxId(s.sellerTaxId ?? "");
      setSellerAddress(s.sellerAddress ?? "");
      setSellerPhone(s.sellerPhone ?? "");
      setSellerPosId(s.sellerPosId ?? "");
      setSellerBranchCode(s.sellerBranchCode ?? "");
      setSellerBranchLabel(s.sellerBranchLabel ?? "");
      // Loyalty drafts reflect the normalized row (satang → baht for display).
      setLoyaltyEnabled(s.loyaltyEnabled);
      setEarnDraft(String(s.earnBahtPerPoint));
      setPointValueBahtDraft((s.redeemPointValueSatang / 100).toFixed(2));
      setMinRedeemDraft(String(s.minRedeemPoints));
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

          {/* Seller Info card (seller-company-settings) — admin-editable company
              identity that feeds the thermal receipt + the §86/4 tax invoice. */}
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
                <Building2 size={18} strokeWidth={2} />
              </span>
              <div>
                <strong className="block text-[14.5px]">
                  ข้อมูลกิจการ · Seller Info
                </strong>
                <span
                  className="block text-[11.5px]"
                  style={{ color: "var(--muted)" }}
                >
                  ข้อมูลแสดงบนใบเสร็จและใบกำกับภาษี
                </span>
              </div>
            </div>

            {/* Name */}
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold">
                ชื่อกิจการ · Name
              </span>
              <input
                type="text"
                maxLength={200}
                value={sellerName}
                onChange={(e) => setSellerName(e.target.value)}
                placeholder="เช่น บริษัท เค.อาร์.เอส. จำกัด"
                className="h-10 rounded-[10px] border px-3 text-[13px]"
                style={{ borderColor: "var(--line)" }}
              />
            </label>

            {/* TIN */}
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold">
                เลขประจำตัวผู้เสียภาษี · TIN
              </span>
              <input
                type="text"
                inputMode="numeric"
                maxLength={13}
                value={sellerTaxId}
                onChange={(e) => setSellerTaxId(e.target.value)}
                placeholder="13 หลัก"
                className="h-10 rounded-[10px] border px-3 text-[13px]"
                style={{ borderColor: "var(--line)" }}
              />
              <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                ต้องมี 13 หลัก (เว้นว่างได้หากยังไม่ออกใบกำกับภาษี)
              </span>
            </label>

            {/* Address */}
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold">
                ที่อยู่ · Address
              </span>
              <textarea
                rows={3}
                maxLength={300}
                value={sellerAddress}
                onChange={(e) => setSellerAddress(e.target.value)}
                placeholder="ที่อยู่จดทะเบียนของกิจการ"
                className="rounded-[10px] border px-3 py-2 text-[13px] leading-[1.6]"
                style={{ borderColor: "var(--line)" }}
              />
            </label>

            {/* Phone + POS ID (two columns) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">
                  โทรศัพท์ · Phone
                </span>
                <input
                  type="text"
                  maxLength={50}
                  value={sellerPhone}
                  onChange={(e) => setSellerPhone(e.target.value)}
                  placeholder="เช่น 02-123-4567"
                  className="h-10 rounded-[10px] border px-3 text-[13px]"
                  style={{ borderColor: "var(--line)" }}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">
                  รหัส POS Terminal · POS ID
                </span>
                <input
                  type="text"
                  maxLength={50}
                  value={sellerPosId}
                  onChange={(e) => setSellerPosId(e.target.value)}
                  placeholder="เช่น POS-001"
                  className="h-10 rounded-[10px] border px-3 text-[13px]"
                  style={{ borderColor: "var(--line)" }}
                />
              </label>
            </div>

            {/* Branch code + label (two columns) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">
                  รหัสสาขา · Branch Code
                </span>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={5}
                  value={sellerBranchCode}
                  onChange={(e) => setSellerBranchCode(e.target.value)}
                  placeholder="00000 (สำนักงานใหญ่)"
                  className="h-10 rounded-[10px] border px-3 text-[13px]"
                  style={{ borderColor: "var(--line)" }}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">
                  ชื่อสาขา · Branch Label
                </span>
                <input
                  type="text"
                  maxLength={100}
                  value={sellerBranchLabel}
                  onChange={(e) => setSellerBranchLabel(e.target.value)}
                  placeholder="เช่น สำนักงานใหญ่"
                  className="h-10 rounded-[10px] border px-3 text-[13px]"
                  style={{ borderColor: "var(--line)" }}
                />
              </label>
            </div>

            {/* §86/4 completeness status line */}
            <div
              className="flex items-center gap-2.5 rounded-[12px] px-3.5 py-3"
              style={{
                background: sellerComplete ? "var(--mint)" : "var(--amber-soft, #fef3c7)",
              }}
            >
              <span
                aria-hidden="true"
                className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-[10px]"
                style={{
                  background: sellerComplete ? "#fff" : "#fff",
                  color: sellerComplete ? "var(--brand-2)" : "#b45309",
                }}
              >
                {sellerComplete ? (
                  <Check size={15} strokeWidth={2.5} />
                ) : (
                  <AlertTriangle size={15} strokeWidth={2} />
                )}
              </span>
              <strong
                className="text-[12.5px]"
                style={{ color: sellerComplete ? "var(--brand-2)" : "#92400e" }}
              >
                {sellerComplete
                  ? "ข้อมูลครบถ้วน — พร้อมออกใบกำกับภาษี"
                  : "ยังไม่ครบ — จะไม่สามารถออกใบกำกับภาษีได้ (เว้นแต่ตั้งค่าผ่าน ENV)"}
              </strong>
            </div>
          </section>

          {/* Loyalty card (loyalty program, Phase 1A) — the store's global member
              earn/redeem rate. Gold/amber accent keeps it distinct from mint
              (promotions) + blue (tax). Thai-first; string drafts + PATCH save. */}
          <section
            className="flex flex-col gap-5 rounded-[18px] border bg-white p-5"
            style={{ borderColor: "var(--line)", boxShadow: "var(--shadow-sm)" }}
          >
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="grid h-9 w-9 place-items-center rounded-[12px]"
                style={{ background: GOLD_BG, color: GOLD }}
              >
                <Sparkles size={18} strokeWidth={2} />
              </span>
              <div>
                <strong className="block text-[14.5px]">
                  โปรแกรมสมาชิก · Loyalty
                </strong>
                <span
                  className="block text-[11.5px]"
                  style={{ color: "var(--muted)" }}
                >
                  แต้มสะสม · อัตราได้แต้มและการแลกแต้ม
                </span>
              </div>
            </div>

            {/* Enable toggle */}
            <label className="flex cursor-pointer items-center gap-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={loyaltyEnabled}
                onClick={() => setLoyaltyEnabled((v) => !v)}
                className="relative h-6 w-11 flex-shrink-0 rounded-full transition"
                style={{ background: loyaltyEnabled ? GOLD : "#cbd5e1" }}
              >
                <span
                  aria-hidden="true"
                  className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
                  style={{ left: loyaltyEnabled ? 22 : 2 }}
                />
              </button>
              <span className="text-[13px] font-semibold">
                เปิดใช้งานโปรแกรมสมาชิก · Enable
              </span>
              <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                (สมาชิกสะสมแต้มทุกบิล)
              </span>
            </label>

            {/* Earn rate + point value (two columns) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">
                  จ่ายกี่บาทได้ 1 แต้ม · Earn rate
                </span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={EARN_MIN}
                    value={earnDraft}
                    onChange={(e) => setEarnDraft(e.target.value)}
                    aria-label="จ่ายกี่บาทได้ 1 แต้ม"
                    aria-invalid={!earnValid}
                    className="h-10 w-[110px] rounded-[10px] border px-3 text-[13px]"
                    style={{ borderColor: earnValid ? "var(--line)" : "#fca5a5" }}
                  />
                  <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                    บาท = 1 แต้ม
                  </span>
                </div>
                {!earnValid && (
                  <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                    อัตราได้แต้มต้องเป็นจำนวนเต็มไม่น้อยกว่า {EARN_MIN} บาท
                  </span>
                )}
              </label>

              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">
                  1 แต้ม = กี่บาท · Point value
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                    1 แต้ม = ฿
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    value={pointValueBahtDraft}
                    onChange={(e) => setPointValueBahtDraft(e.target.value)}
                    aria-label="1 แต้ม = กี่บาท"
                    aria-invalid={!pointValueValid}
                    className="h-10 w-[110px] rounded-[10px] border px-3 text-[13px]"
                    style={{
                      borderColor: pointValueValid ? "var(--line)" : "#fca5a5",
                    }}
                  />
                </div>
                {!pointValueValid && (
                  <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                    ค่าแต้มต้องไม่ติดลบ
                  </span>
                )}
              </label>
            </div>

            {/* Min redeem */}
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold">
                แลกขั้นต่ำ · Min redeem (แต้ม)
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={minRedeemDraft}
                  onChange={(e) => setMinRedeemDraft(e.target.value)}
                  aria-label="แลกขั้นต่ำกี่แต้ม"
                  aria-invalid={!minRedeemValid}
                  className="h-10 w-[110px] rounded-[10px] border px-3 text-[13px]"
                  style={{ borderColor: minRedeemValid ? "var(--line)" : "#fca5a5" }}
                />
                <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                  แต้ม (0 = ไม่มีขั้นต่ำ)
                </span>
              </div>
              {!minRedeemValid && (
                <span className="text-[11.5px]" style={{ color: "#b42318" }}>
                  ขั้นต่ำการแลกต้องเป็นจำนวนเต็มไม่ติดลบ
                </span>
              )}
            </label>

            {/* Status line — gold when enabled, neutral when off */}
            <div
              className="flex items-center gap-2.5 rounded-[12px] px-3.5 py-3"
              style={{ background: loyaltyEnabled ? GOLD_BG : "var(--surface-2)" }}
            >
              <span
                aria-hidden="true"
                className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-[10px]"
                style={{
                  background: "#fff",
                  color: loyaltyEnabled ? GOLD : "var(--muted)",
                }}
              >
                <Sparkles size={15} strokeWidth={2} />
              </span>
              <strong
                className="text-[12.5px]"
                style={{ color: loyaltyEnabled ? "#92400e" : "var(--muted)" }}
              >
                {loyaltyEnabled
                  ? `เปิดใช้งาน — จ่าย ฿${earnValid ? earnNum : "—"} ได้ 1 แต้ม · 1 แต้ม = ฿${pointValueValid ? (pointValueSatang / 100).toFixed(2) : "—"}`
                  : "ปิดใช้งาน — สมาชิกยังไม่สะสมแต้ม"}
              </strong>
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

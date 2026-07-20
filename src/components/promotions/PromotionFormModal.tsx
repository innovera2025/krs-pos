"use client";

import { useEffect, useMemo, useState } from "react";
import { BadgePercent, X, AlertTriangle } from "lucide-react";
import { Modal } from "@/components/Modal";
import { PromotionProductPicker } from "@/components/promotions/PromotionProductPicker";
import { PROMO_META, buyXGetYSummary } from "@/components/promotions/promotionMeta";
import { bangkokDateParts, bangkokDayWindow } from "@/lib/datetime";
import type { DiscountType, Product, PromotionDTO, PromotionType } from "@/types";

/**
 * The create/edit payload posted to the promotions API. MONEY is BAHT numbers
 * (2dp) named per the Public Contract CREATE schema (amountOff / fixedPrice /
 * minSubtotal) — the API converts baht → satang server-side. `type` is present
 * ONLY on create (it is immutable — editing a type means deactivating the old
 * promotion and creating a new one). `productIds` is omitted for BILL_THRESHOLD
 * (a whole-bill promotion, not product-scoped). Dates are ISO instants derived
 * from the Bangkok calendar dates the user picked.
 */
export type PromotionFormPayload = {
  name: string;
  type?: PromotionType;
  startsAt: string;
  endsAt: string | null;
  isActive: boolean;
  productIds?: string[];
  percentOff?: number;
  amountOff?: number;
  fixedPrice?: number;
  buyQty?: number;
  getQty?: number;
  getDiscountPercent?: number;
  getAmountOff?: number;
  minSubtotal?: number;
};

type PromotionFormModalProps = {
  open: boolean;
  /** When set, EDIT mode for this promotion (type locked); else CREATE mode. */
  editing: PromotionDTO | null;
  submitting: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (values: PromotionFormPayload) => void;
};

const TYPE_ORDER: PromotionType[] = [
  "PRODUCT_DISCOUNT",
  "FIXED_PRICE",
  "BUY_X_GET_Y",
  "BILL_THRESHOLD",
];

const MINT_CARD_BG = "#ecfdf5";
const MINT_CARD_BORDER = "#15a86d";

// ---- Bangkok calendar ⇄ ISO instant helpers (reuse lib/datetime) ------------
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
/** Today's Asia/Bangkok calendar date as `YYYY-MM-DD` (native date-input value). */
function todayBangkokDate(): string {
  const { y, m, d } = bangkokDateParts(new Date());
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
/** ISO instant → its Asia/Bangkok calendar date `YYYY-MM-DD`. */
function isoToBangkokDate(iso: string): string {
  const { y, m, d } = bangkokDateParts(new Date(iso));
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
/**
 * The stored `endsAt` is the EXCLUSIVE next-day bound; the INCLUSIVE end date the
 * user typed is the day one millisecond earlier (23:59:59.999 Bangkok of it).
 */
function isoEndToBangkokDate(iso: string): string {
  const { y, m, d } = bangkokDateParts(new Date(new Date(iso).getTime() - 1));
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
/** Bangkok calendar date `YYYY-MM-DD` → 00:00 Asia/Bangkok that day (ISO). */
function bangkokStartISO(dateStr: string): string {
  return bangkokDayWindow(new Date(dateStr + "T00:00:00Z")).startOfDay.toISOString();
}
/** Inclusive Bangkok end date → 00:00 Asia/Bangkok of the NEXT day (exclusive). */
function bangkokEndISO(dateStr: string): string {
  return bangkokDayWindow(
    new Date(dateStr + "T00:00:00Z")
  ).startOfNextDay.toISOString();
}
/** Integer-satang → 2dp baht STRING for a money input default (e.g. 1250 → "12.50"). */
function satangToBahtStr(satang: number): string {
  return (satang / 100).toFixed(2);
}

// ---- validation predicates --------------------------------------------------
function pctOk(v: number): boolean {
  return Number.isFinite(v) && v >= 1 && v <= 100;
}
/** > 0 and at most 2 decimal places (no float-drift baht). */
function bahtPosOk(v: number): boolean {
  return Number.isFinite(v) && v > 0 && Math.round(v * 100) === v * 100;
}

/**
 * Add / edit promotion form (promotions program, Phase 5). Structure mirrors
 * ProductFormModal (shared Modal primitive, header/body/footer). A 2×2 radio-card
 * type selector (LOCKED in edit mode) drives dynamic per-type fields. Money inputs
 * are mono + right-aligned + inputMode="decimal". Promotion accent = the MINT
 * family (#ecfdf5 / #15a86d / var(--brand)); the blue #eef4ff/#2563eb chrome stays
 * reserved for MANUAL discounts. Validation is derived booleans + a disabled
 * submit (no red-per-keystroke).
 */
export function PromotionFormModal({
  open,
  editing,
  submitting,
  error,
  onClose,
  onSubmit,
}: PromotionFormModalProps) {
  const isEdit = editing !== null;

  const [type, setType] = useState<PromotionType>("PRODUCT_DISCOUNT");
  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [productIds, setProductIds] = useState<string[]>([]);

  // Discount value + ฿/% mode SHARED by PRODUCT_DISCOUNT and BILL_THRESHOLD (only
  // one type is ever active, so sharing is safe).
  const [discountValue, setDiscountValue] = useState("");
  const [discountMode, setDiscountMode] = useState<DiscountType>("percent");

  // FIXED_PRICE
  const [fixedPrice, setFixedPrice] = useState("");

  // BUY_X_GET_Y — reward is one of ฟรี / ลด % / ลดบาท (ฟรี = getDiscountPercent 100).
  const [buyQty, setBuyQty] = useState("");
  const [getQty, setGetQty] = useState("");
  const [bogoMode, setBogoMode] = useState<"free" | "percent" | "amount">("free");
  const [bogoDiscountPct, setBogoDiscountPct] = useState("");
  const [bogoAmount, setBogoAmount] = useState("");

  // BILL_THRESHOLD minimum spend
  const [minSubtotal, setMinSubtotal] = useState("");

  // The picker's fetched product list, lifted here so FIXED_PRICE can price-check
  // the selection for the amber warning.
  const [pickerProducts, setPickerProducts] = useState<Product[]>([]);

  // Hydrate on open — from the editing row, or blank defaults on create.
  useEffect(() => {
    if (!open) return;
    setPickerProducts([]);
    if (editing) {
      setType(editing.type);
      setName(editing.name);
      setStartDate(editing.startsAt ? isoToBangkokDate(editing.startsAt) : todayBangkokDate());
      setEndDate(editing.endsAt ? isoEndToBangkokDate(editing.endsAt) : "");
      setIsActive(editing.isActive);
      setProductIds(editing.productIds ?? []);

      // Per-type config (satang → baht string for money inputs).
      if (editing.percentOff != null) {
        setDiscountMode("percent");
        setDiscountValue(String(editing.percentOff));
      } else if (editing.amountOffSatang != null) {
        setDiscountMode("amount");
        setDiscountValue(satangToBahtStr(editing.amountOffSatang));
      } else {
        setDiscountMode("percent");
        setDiscountValue("");
      }
      setFixedPrice(
        editing.fixedPriceSatang != null ? satangToBahtStr(editing.fixedPriceSatang) : ""
      );
      setBuyQty(editing.buyQty != null ? String(editing.buyQty) : "");
      setGetQty(editing.getQty != null ? String(editing.getQty) : "");
      // Reward hydration mirrors the engine's amount-first precedence.
      if (editing.getAmountOffSatang != null) {
        setBogoMode("amount");
        setBogoAmount(satangToBahtStr(editing.getAmountOffSatang));
        setBogoDiscountPct("");
      } else if (editing.getDiscountPercent != null && editing.getDiscountPercent < 100) {
        setBogoMode("percent");
        setBogoDiscountPct(String(editing.getDiscountPercent));
        setBogoAmount("");
      } else {
        setBogoMode("free");
        setBogoDiscountPct("");
        setBogoAmount("");
      }
      setMinSubtotal(
        editing.minSubtotalSatang != null ? satangToBahtStr(editing.minSubtotalSatang) : ""
      );
    } else {
      setType("PRODUCT_DISCOUNT");
      setName("");
      setStartDate(todayBangkokDate());
      setEndDate("");
      setIsActive(true);
      setProductIds([]);
      setDiscountValue("");
      setDiscountMode("percent");
      setFixedPrice("");
      setBuyQty("");
      setGetQty("");
      setBogoMode("free");
      setBogoDiscountPct("");
      setBogoAmount("");
      setMinSubtotal("");
    }
  }, [open, editing]);

  // ---- derived numbers + validity ----
  const dv = Number(discountValue);
  const fp = Number(fixedPrice);
  const ms = Number(minSubtotal);
  const bq = Number(buyQty);
  const gq = Number(getQty);
  const bogoPct = Number(bogoDiscountPct);
  const bogoAmt = Number(bogoAmount);
  // The BUY_X_GET_Y reward is valid iff the active mode's field is valid.
  const bogoRewardOk =
    bogoMode === "free" ||
    (bogoMode === "percent" && pctOk(bogoPct)) ||
    (bogoMode === "amount" && bahtPosOk(bogoAmt));

  const scoped = type !== "BILL_THRESHOLD";
  const productsOk = !scoped || productIds.length >= 1;

  const nameOk = name.trim().length > 0;
  const startOk = startDate.length > 0;
  const dateOk = endDate === "" || endDate >= startDate;
  // Threshold: a ฿ discount must be strictly less than the minimum spend.
  const thresholdAmountOverspend =
    type === "BILL_THRESHOLD" &&
    discountMode === "amount" &&
    bahtPosOk(dv) &&
    bahtPosOk(ms) &&
    dv >= ms;

  let typeOk = false;
  switch (type) {
    case "PRODUCT_DISCOUNT":
      typeOk =
        (discountMode === "percent" ? pctOk(dv) : bahtPosOk(dv)) && productsOk;
      break;
    case "FIXED_PRICE":
      typeOk = bahtPosOk(fp) && productsOk;
      break;
    case "BUY_X_GET_Y":
      typeOk =
        Number.isInteger(bq) &&
        bq >= 1 &&
        Number.isInteger(gq) &&
        gq >= 1 &&
        bogoRewardOk &&
        productsOk;
      break;
    case "BILL_THRESHOLD":
      typeOk =
        bahtPosOk(ms) &&
        (discountMode === "percent" ? pctOk(dv) : bahtPosOk(dv) && dv < ms);
      break;
  }

  const canSubmit = nameOk && startOk && dateOk && typeOk && !submitting;

  // FIXED_PRICE amber warning — special price ≥ a selected product's normal price.
  const selectedProducts = useMemo(
    () => pickerProducts.filter((p) => productIds.includes(p.id)),
    [pickerProducts, productIds]
  );
  const fixedPriceWarning =
    type === "FIXED_PRICE" &&
    bahtPosOk(fp) &&
    selectedProducts.some((p) => Number(p.price) <= fp);

  // BUY_X_GET_Y live preview line.
  const bogoPreview =
    Number.isInteger(bq) && bq >= 1 && Number.isInteger(gq) && gq >= 1 && bogoRewardOk
      ? buyXGetYSummary(
          bq,
          gq,
          bogoMode === "amount" ? null : bogoMode === "free" ? 100 : bogoPct,
          bogoMode === "amount" ? Math.round(bogoAmt * 100) : null
        )
      : "";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    const startsAt = bangkokStartISO(startDate);
    const endsAt = endDate ? bangkokEndISO(endDate) : null;

    const payload: PromotionFormPayload = {
      name: name.trim(),
      startsAt,
      endsAt,
      isActive,
    };
    // type is immutable — sent on create only.
    if (!isEdit) payload.type = type;
    // productIds only for product-scoped types.
    if (scoped) payload.productIds = productIds;

    switch (type) {
      case "PRODUCT_DISCOUNT":
        if (discountMode === "percent") payload.percentOff = dv;
        else payload.amountOff = dv;
        break;
      case "FIXED_PRICE":
        payload.fixedPrice = fp;
        break;
      case "BUY_X_GET_Y":
        payload.buyQty = bq;
        payload.getQty = gq;
        // Exactly one reward field — amount for ลดบาท, else percent (ฟรี = 100).
        if (bogoMode === "amount") payload.getAmountOff = bogoAmt;
        else payload.getDiscountPercent = bogoMode === "free" ? 100 : bogoPct;
        break;
      case "BILL_THRESHOLD":
        payload.minSubtotal = ms;
        if (discountMode === "percent") payload.percentOff = dv;
        else payload.amountOff = dv;
        break;
    }

    onSubmit(payload);
  }

  return (
    <Modal open={open} onClose={onClose} label={isEdit ? "แก้ไขโปรโมชัน" : "เพิ่มโปรโมชัน"}>
      <form
        onSubmit={handleSubmit}
        className="flex max-h-[86vh] w-[min(560px,calc(100vw-32px))] flex-col rounded-[22px] bg-white"
        style={{ boxShadow: "var(--shadow)" }}
      >
        {/* Header */}
        <header
          className="flex items-center gap-3 border-b px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <span
            className="grid h-10 w-10 place-items-center rounded-[14px]"
            style={{ background: MINT_CARD_BG, color: "var(--brand-2)" }}
          >
            <BadgePercent size={20} strokeWidth={2} />
          </span>
          <div className="flex-1">
            <strong className="block text-[15px]">
              {isEdit ? "แก้ไขโปรโมชัน" : "เพิ่มโปรโมชัน"}
            </strong>
            <span className="block text-[11.5px]" style={{ color: "var(--muted)" }}>
              {isEdit ? "Edit promotion" : "Add promotion"}
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

        {/* Body (scrolls) */}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
          {/* Type selector — 2×2 radio cards, locked in edit mode */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">ประเภทโปรโมชัน · Type</span>
            <div role="radiogroup" aria-label="ประเภทโปรโมชัน" className="grid grid-cols-2 gap-2.5">
              {TYPE_ORDER.map((t) => {
                const meta = PROMO_META[t];
                const Icon = meta.icon;
                const active = type === t;
                const locked = isEdit && !active;
                return (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={isEdit}
                    onClick={() => !isEdit && setType(t)}
                    className="flex items-start gap-2.5 rounded-[14px] border p-3 text-left transition disabled:cursor-not-allowed"
                    style={{
                      borderColor: active ? MINT_CARD_BORDER : "var(--line)",
                      background: active ? MINT_CARD_BG : "#fff",
                      opacity: locked ? 0.55 : 1,
                    }}
                  >
                    <span
                      className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-[10px]"
                      style={{
                        background: active ? "#fff" : "var(--surface-2)",
                        color: active ? "var(--brand-2)" : "var(--muted)",
                      }}
                    >
                      <Icon size={17} strokeWidth={2} />
                    </span>
                    <span className="min-w-0">
                      <span
                        className="block text-[13px] font-semibold"
                        style={{ color: active ? "var(--brand-2)" : "var(--ink)" }}
                      >
                        {meta.labelTh}
                      </span>
                      <span className="block text-[10.5px]" style={{ color: "var(--muted)" }}>
                        {meta.labelEn}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {isEdit && (
              <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                เปลี่ยนประเภทไม่ได้ · ต้องปิดโปรเดิมแล้วสร้างใหม่
              </span>
            )}
          </div>

          {/* Name */}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">ชื่อโปรโมชัน · Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น ลดกาแฟรับหน้าร้อน"
              autoComplete="off"
              className="h-11 rounded-[12px] border px-3 text-[14px]"
              style={{ borderColor: "var(--line)" }}
            />
            <span className="text-[11px]" style={{ color: "var(--muted)" }}>
              ชื่อนี้จะแสดงบนหน้าขายและใบเสร็จ
            </span>
          </label>

          {/* Dynamic per-type fields */}
          {type === "PRODUCT_DISCOUNT" && (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">มูลค่าส่วนลด · Discount</span>
                <div className="flex items-center gap-2.5">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder={discountMode === "percent" ? "10" : "0.00"}
                    className="mono h-11 flex-1 rounded-[12px] border px-3 text-right text-[14px]"
                    style={{ borderColor: "var(--line)" }}
                  />
                  <AmountPercentToggle mode={discountMode} onChange={setDiscountMode} />
                </div>
                <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                  ลดต่อชิ้น ทุกชิ้นที่เข้าเงื่อนไข
                </span>
              </div>
              <PromotionProductPicker
                value={productIds}
                onChange={setProductIds}
                onProductsLoaded={setPickerProducts}
              />
            </div>
          )}

          {type === "FIXED_PRICE" && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">ราคาพิเศษ (฿) · Special price</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={fixedPrice}
                  onChange={(e) => setFixedPrice(e.target.value)}
                  placeholder="0.00"
                  className="mono h-11 rounded-[12px] border px-3 text-right text-[14px]"
                  style={{ borderColor: "var(--line)" }}
                />
              </label>
              {fixedPriceWarning && (
                <p
                  className="m-0 flex items-start gap-2 rounded-[12px] px-3 py-2 text-[12px]"
                  style={{ background: "var(--accent-soft)", color: "#b45309" }}
                >
                  <AlertTriangle size={15} strokeWidth={2} className="mt-px flex-shrink-0" />
                  ราคาพิเศษสูงกว่าหรือเท่ากับราคาปกติของสินค้าบางรายการ
                </p>
              )}
              <PromotionProductPicker
                value={productIds}
                onChange={setProductIds}
                onProductsLoaded={setPickerProducts}
              />
            </div>
          )}

          {type === "BUY_X_GET_Y" && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] font-semibold">จำนวนที่ต้องซื้อ (X)</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={buyQty}
                    onChange={(e) => setBuyQty(e.target.value)}
                    placeholder="1"
                    className="mono h-11 rounded-[12px] border px-3 text-right text-[14px]"
                    style={{ borderColor: "var(--line)" }}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12.5px] font-semibold">จำนวนที่ได้รับสิทธิ์ (Y)</span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    value={getQty}
                    onChange={(e) => setGetQty(e.target.value)}
                    placeholder="1"
                    className="mono h-11 rounded-[12px] border px-3 text-right text-[14px]"
                    style={{ borderColor: "var(--line)" }}
                  />
                </label>
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">สิทธิ์ที่ได้รับ · Reward</span>
                <div className="flex flex-wrap items-center gap-2.5">
                  <div
                    className="flex rounded-[10px] border p-0.5"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <SegBtn active={bogoMode === "free"} onClick={() => setBogoMode("free")}>
                      ฟรี
                    </SegBtn>
                    <SegBtn active={bogoMode === "percent"} onClick={() => setBogoMode("percent")}>
                      ลด %
                    </SegBtn>
                    <SegBtn active={bogoMode === "amount"} onClick={() => setBogoMode("amount")}>
                      ลดบาท
                    </SegBtn>
                  </div>
                  {bogoMode === "percent" && (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={1}
                        max={100}
                        step="0.01"
                        inputMode="decimal"
                        value={bogoDiscountPct}
                        onChange={(e) => setBogoDiscountPct(e.target.value)}
                        placeholder="50"
                        className="mono h-11 w-[84px] rounded-[12px] border px-3 text-right text-[14px]"
                        style={{ borderColor: "var(--line)" }}
                      />
                      <span className="text-[13px] font-semibold" style={{ color: "var(--muted)" }}>
                        %
                      </span>
                    </div>
                  )}
                  {bogoMode === "amount" && (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        inputMode="decimal"
                        value={bogoAmount}
                        onChange={(e) => setBogoAmount(e.target.value)}
                        placeholder="20"
                        className="mono h-11 w-[96px] rounded-[12px] border px-3 text-right text-[14px]"
                        style={{ borderColor: "var(--line)" }}
                      />
                      <span className="text-[13px] font-semibold" style={{ color: "var(--muted)" }}>
                        ฿
                      </span>
                    </div>
                  )}
                </div>
                <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                  ลดต่อชิ้นสำหรับชิ้นที่ได้รับสิทธิ์
                </span>
              </div>

              {bogoPreview && (
                <span
                  className="inline-flex w-fit items-center rounded-full px-3 py-1 text-[12.5px] font-semibold"
                  style={{ background: "var(--mint)", color: "var(--brand-2)" }}
                >
                  {bogoPreview}
                </span>
              )}

              <PromotionProductPicker
                value={productIds}
                onChange={setProductIds}
                onProductsLoaded={setPickerProducts}
              />
            </div>
          )}

          {type === "BILL_THRESHOLD" && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">ยอดซื้อขั้นต่ำ (฿) · Minimum spend</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={minSubtotal}
                  onChange={(e) => setMinSubtotal(e.target.value)}
                  placeholder="0.00"
                  className="mono h-11 rounded-[12px] border px-3 text-right text-[14px]"
                  style={{ borderColor: "var(--line)" }}
                />
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-semibold">ส่วนลด · Discount</span>
                <div className="flex items-center gap-2.5">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(e.target.value)}
                    placeholder={discountMode === "percent" ? "10" : "0.00"}
                    className="mono h-11 flex-1 rounded-[12px] border px-3 text-right text-[14px]"
                    style={{ borderColor: "var(--line)" }}
                  />
                  <AmountPercentToggle mode={discountMode} onChange={setDiscountMode} />
                </div>
                {thresholdAmountOverspend && (
                  <span className="text-[11px]" style={{ color: "#b42318" }}>
                    ส่วนลดต้องน้อยกว่ายอดซื้อขั้นต่ำ
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[12px]" style={{ color: "var(--muted)" }}>
                  ขอบเขต · Scope
                </span>
                <span
                  className="inline-flex items-center rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                  style={{ background: "var(--mint)", color: "var(--brand-2)" }}
                >
                  ทั้งบิล
                </span>
              </div>
            </div>
          )}

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold">วันที่เริ่ม · Starts</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="h-11 rounded-[12px] border px-3 text-[14px]"
                style={{ borderColor: "var(--line)" }}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] font-semibold">วันที่สิ้นสุด · Ends</span>
              <input
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
                className="h-11 rounded-[12px] border px-3 text-[14px]"
                style={{ borderColor: "var(--line)" }}
              />
              <span className="text-[11px]" style={{ color: "var(--muted)" }}>
                เว้นว่าง = ไม่มีกำหนด
              </span>
            </label>
          </div>
          {!dateOk && (
            <span className="text-[11.5px]" style={{ color: "#b42318" }}>
              วันสิ้นสุดต้องไม่ก่อนวันเริ่ม
            </span>
          )}

          {/* Activate now */}
          <label className="flex cursor-pointer items-center gap-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={isActive}
              onClick={() => setIsActive((v) => !v)}
              className="relative h-6 w-11 flex-shrink-0 rounded-full transition"
              style={{ background: isActive ? "var(--brand)" : "#cbd5e1" }}
            >
              <span
                aria-hidden="true"
                className="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
                style={{ left: isActive ? 22 : 2 }}
              />
            </button>
            <span className="text-[13px] font-semibold">เปิดใช้งานทันที · Activate now</span>
          </label>

          {error && (
            <p
              role="alert"
              className="m-0 rounded-[12px] px-3 py-2 text-[12.5px]"
              style={{ background: "var(--red-soft)", color: "#b42318" }}
            >
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <footer
          className="flex justify-end gap-2.5 border-t px-5 py-4"
          style={{ borderColor: "var(--line)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="h-11 rounded-[12px] border px-4 text-[13.5px] font-semibold"
            style={{ borderColor: "var(--line)", color: "var(--ink)" }}
          >
            ยกเลิก
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="h-11 rounded-[12px] px-5 text-[13.5px] font-bold text-white disabled:opacity-50"
            style={{ background: "var(--brand)" }}
          >
            {submitting ? "กำลังบันทึก…" : isEdit ? "บันทึกการแก้ไข" : "เพิ่มโปรโมชัน"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/** Mint ฿/% segmented toggle for the discount value inputs. */
function AmountPercentToggle({
  mode,
  onChange,
}: {
  mode: DiscountType;
  onChange: (m: DiscountType) => void;
}) {
  return (
    <div className="flex rounded-[10px] border p-0.5" style={{ borderColor: "var(--line)" }}>
      {(["amount", "percent"] as DiscountType[]).map((m) => (
        <SegBtn key={m} active={mode === m} onClick={() => onChange(m)}>
          {m === "amount" ? "฿" : "%"}
        </SegBtn>
      ))}
    </div>
  );
}

/** One mint segment button (shared by the ฿/% + ฟรี/ลด% toggles). */
function SegBtn({
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
      aria-pressed={active}
      className="h-8 min-w-9 rounded-[8px] px-3 text-[13px] font-bold transition"
      style={
        active
          ? { background: "var(--mint)", color: "var(--brand-2)" }
          : { background: "transparent", color: "var(--muted)" }
      }
    >
      {children}
    </button>
  );
}

import {
  BadgePercent,
  Tag,
  Gift,
  ReceiptText,
  type LucideIcon,
} from "lucide-react";
import { money, formatSatang } from "@/lib/money";
import type { PromotionType } from "@/types";

/**
 * Per-type presentation meta for the promotions feature (promotions program,
 * Phase 5). Shared between the ADMIN screen (/promotions table + form) and — by
 * design — the POS cashier surfaces (Phase 7), so the label/icon/summary for a
 * promotion is written ONCE. All money formatting reuses lib/money (money /
 * formatSatang) so promotion amounts render exactly like every other baht value.
 *
 * Promotion accent = the MINT family (var(--brand)/#11865a). The blue #eef4ff /
 * #2563eb stays reserved for MANUAL discounts — never used for promotions.
 */

/** Thai-first label + English subcopy + Taste icon for each promotion type. */
export const PROMO_META: Record<
  PromotionType,
  { labelTh: string; labelEn: string; icon: LucideIcon }
> = {
  PRODUCT_DISCOUNT: {
    labelTh: "ลดราคาต่อสินค้า",
    labelEn: "Product discount",
    icon: BadgePercent,
  },
  FIXED_PRICE: {
    labelTh: "ราคาพิเศษ",
    labelEn: "Special price",
    icon: Tag,
  },
  BUY_X_GET_Y: {
    labelTh: "ซื้อครบรับส่วนลด/ฟรี",
    labelEn: "Buy X get Y",
    icon: Gift,
  },
  BILL_THRESHOLD: {
    labelTh: "ลดตามยอดบิล",
    labelEn: "Spend & save",
    icon: ReceiptText,
  },
};

/** Combined "ไทย · English" label (e.g. table chip tooltip / picker headers). */
export function promoTypeLabel(type: PromotionType): string {
  const m = PROMO_META[type];
  return `${m.labelTh} · ${m.labelEn}`;
}

/**
 * Structural shape the summary/badge formatters need — a subset compatible with
 * both `PromotionDTO` (admin) and the future POS `ActivePromotion` (Phase 7). All
 * money config is integer SATANG (matching the Public Contract), so formatting
 * goes through formatSatang.
 */
export type PromoLike = {
  type: PromotionType;
  percentOff?: number | null;
  amountOffSatang?: number | null;
  fixedPriceSatang?: number | null;
  buyQty?: number | null;
  getQty?: number | null;
  getDiscountPercent?: number | null;
  getAmountOffSatang?: number | null;
  minSubtotalSatang?: number | null;
};

/**
 * The BUY_X_GET_Y rule as human copy. Shared by the summary formatter AND the
 * form's live-preview line so the two never drift. The reward is EXACTLY ONE of a
 * percent (`getDiscountPercent`) or a ฿-per-unit amount (`getAmountOffSatang`):
 *  - amount (getAmountOffSatang set): "ซื้อ {X+Y} ลด {฿amount}/ชิ้น"
 *  - free (getDiscountPercent === 100): "ซื้อ {X} แถม {Y}"
 *  - discounted (< 100):                "ซื้อ {X+Y} ชิ้นที่ {X+1}[–{X+Y}] ลด {pct}%"
 */
export function buyXGetYSummary(
  buyQty: number,
  getQty: number,
  getDiscountPercent: number | null | undefined,
  getAmountOffSatang?: number | null
): string {
  if (getAmountOffSatang != null) {
    return `ซื้อ ${buyQty + getQty} ลด ${formatSatang(getAmountOffSatang)}/ชิ้น`;
  }
  if (getDiscountPercent != null && getDiscountPercent >= 100) {
    return `ซื้อ ${buyQty} แถม ${getQty}`;
  }
  const pct = getDiscountPercent ?? 0;
  const first = buyQty + 1;
  const last = buyQty + getQty;
  const nth = getQty > 1 ? `${first}–${last}` : `${first}`;
  return `ซื้อ ${buyQty + getQty} ชิ้นที่ ${nth} ลด ${pct}%`;
}

/**
 * The "ส่วนลด/เงื่อนไข" one-line summary shown in the admin table (mono) — e.g.
 * "−10%", "฿99.00", "ซื้อ 3 แถม 1", "ครบ ฿1,000.00 ลด ฿50.00". Defensive against
 * a missing field (returns "—") so a malformed row never throws in the table.
 */
export function promoSummary(p: PromoLike): string {
  switch (p.type) {
    case "PRODUCT_DISCOUNT":
      if (p.percentOff != null) return `−${trimPercent(p.percentOff)}%`;
      if (p.amountOffSatang != null) return `−${formatSatang(p.amountOffSatang)}`;
      return "—";
    case "FIXED_PRICE":
      return p.fixedPriceSatang != null ? formatSatang(p.fixedPriceSatang) : "—";
    case "BUY_X_GET_Y":
      if (
        p.buyQty != null &&
        p.getQty != null &&
        (p.getDiscountPercent != null || p.getAmountOffSatang != null)
      ) {
        return buyXGetYSummary(
          p.buyQty,
          p.getQty,
          p.getDiscountPercent,
          p.getAmountOffSatang
        );
      }
      return "—";
    case "BILL_THRESHOLD": {
      if (p.minSubtotalSatang == null) return "—";
      const cond = `ครบ ${formatSatang(p.minSubtotalSatang)}`;
      if (p.percentOff != null) return `${cond} ลด ${trimPercent(p.percentOff)}%`;
      if (p.amountOffSatang != null) return `${cond} ลด ${formatSatang(p.amountOffSatang)}`;
      return cond;
    }
    default:
      return "—";
  }
}

/**
 * A SHORT badge label for POS reuse (Phase 7 product-card / cart-line pills) —
 * tighter than the table summary. Threshold promotions have no per-product badge,
 * so this returns "" for BILL_THRESHOLD.
 */
export function promoBadgeLabel(p: PromoLike): string {
  switch (p.type) {
    case "PRODUCT_DISCOUNT":
      if (p.percentOff != null) return `−${trimPercent(p.percentOff)}%`;
      if (p.amountOffSatang != null) return `−${money(p.amountOffSatang / 100)}`;
      return "";
    case "FIXED_PRICE":
      return "ราคาพิเศษ";
    case "BUY_X_GET_Y":
      if (
        p.buyQty != null &&
        p.getQty != null &&
        (p.getDiscountPercent != null || p.getAmountOffSatang != null)
      ) {
        return buyXGetYSummary(
          p.buyQty,
          p.getQty,
          p.getDiscountPercent,
          p.getAmountOffSatang
        );
      }
      return "";
    case "BILL_THRESHOLD":
      return "";
    default:
      return "";
  }
}

/**
 * The reward-only label for a spend-&-save (BILL_THRESHOLD) promotion — the "ลดทันที
 * {reward}" tail of the POS threshold hint (Phase 7), WITHOUT the "ครบ …" condition
 * that `promoSummary` prepends. "฿50.00" for a flat amount, "10%" for a percentage.
 * Also usable for any percent/amount-shaped promo. "" when malformed (defensive).
 */
export function promoRewardLabel(p: PromoLike): string {
  if (p.percentOff != null) return `${trimPercent(p.percentOff)}%`;
  if (p.amountOffSatang != null) return formatSatang(p.amountOffSatang);
  return "";
}

/** Drop a trailing ".00"/".x0" so "10.00" → "10", "12.50" → "12.5" in labels. */
function trimPercent(pct: number): string {
  return String(Number(pct));
}

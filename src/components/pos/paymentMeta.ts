import {
  Banknote,
  Landmark,
  QrCode,
  CreditCard,
  FileCheck,
  HeartHandshake,
  Wallet,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { PayMethod } from "@/types";

/**
 * Shared payment-method metadata (Thai-first label + lucide icon).
 *
 * PAY_METHODS is the BUTTON SET shown in the payment modal — the six LIVE tender
 * methods that map 1:1 onto the KRS Receipt_Type codes (vendor 17-07-26):
 *   เงินสด(1) · โอนเงิน(2) · QR PromptPay(2) · บัตรเครดิต(4) · เช็ค(3) · ไทยช่วยไทย(5).
 * Layout stays 3×2. `เช็ค` uses FileCheck; `ไทยช่วยไทย` uses HeartHandshake.
 *
 * The legacy e-Wallet / อื่นๆ methods were RETIRED as buttons (they replaced by เช็ค /
 * ไทยช่วยไทย) but keep their label + icon below (RETIRED_METHODS) so historical
 * orders, sales history, Z-reports, and reprinted receipts still render correctly.
 */
export const PAY_METHODS: { key: PayMethod; label: string; icon: LucideIcon }[] = [
  { key: "cash", label: "เงินสด", icon: Banknote },
  { key: "transfer", label: "โอนเงิน", icon: Landmark },
  { key: "qr", label: "QR PromptPay", icon: QrCode },
  { key: "card", label: "บัตรเครดิต", icon: CreditCard },
  { key: "cheque", label: "เช็ค · Cheque", icon: FileCheck },
  { key: "thaichuaythai", label: "ไทยช่วยไทย", icon: HeartHandshake },
];

/**
 * Retired tender methods — no longer offered as buttons, but their label + icon are
 * still needed to render any pre-17-07-26 order (paymentType/PaymentLine.method =
 * EWALLET / OTHER). Merged into the label/icon lookup maps below.
 */
const RETIRED_METHODS: { key: PayMethod; label: string; icon: LucideIcon }[] = [
  { key: "ewallet", label: "e-Wallet", icon: Wallet },
  { key: "other", label: "อื่นๆ", icon: MoreHorizontal },
];

// Label/icon lookups cover BOTH the live buttons and the retired methods, so
// methodLabel/methodIcon resolve historical values too.
const ALL_METHODS = [...PAY_METHODS, ...RETIRED_METHODS];

const LABEL_BY_KEY: Record<PayMethod, string> = ALL_METHODS.reduce(
  (acc, m) => {
    acc[m.key] = m.label;
    return acc;
  },
  {} as Record<PayMethod, string>
);

const ICON_BY_KEY: Record<PayMethod, LucideIcon> = ALL_METHODS.reduce(
  (acc, m) => {
    acc[m.key] = m.icon;
    return acc;
  },
  {} as Record<PayMethod, LucideIcon>
);

/** Thai label for a method key (defaults to the key for unknown values). */
export function methodLabel(key: string): string {
  return LABEL_BY_KEY[key as PayMethod] ?? key;
}

/** lucide icon for a method key (defaults to the ellipsis "other" icon). */
export function methodIcon(key: string): LucideIcon {
  return ICON_BY_KEY[key as PayMethod] ?? MoreHorizontal;
}

/** Upper-case a UI method key for the API/Prisma PaymentType enum. */
export function methodToEnum(key: PayMethod): string {
  return key.toUpperCase();
}

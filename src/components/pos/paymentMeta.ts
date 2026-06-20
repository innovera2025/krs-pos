import {
  Banknote,
  Landmark,
  QrCode,
  CreditCard,
  Wallet,
  MoreHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { PayMethod } from "@/types";

/**
 * Shared payment-method metadata (Thai-first label + lucide icon) for the six
 * tender methods, mirroring the Simple POS source-of-truth methodLabel map and
 * the icon set referenced in the Phase 3 plan.
 */
export const PAY_METHODS: { key: PayMethod; label: string; icon: LucideIcon }[] = [
  { key: "cash", label: "เงินสด", icon: Banknote },
  { key: "transfer", label: "โอนเงิน", icon: Landmark },
  { key: "qr", label: "QR PromptPay", icon: QrCode },
  { key: "card", label: "บัตรเครดิต", icon: CreditCard },
  { key: "ewallet", label: "e-Wallet", icon: Wallet },
  { key: "other", label: "อื่นๆ", icon: MoreHorizontal },
];

const LABEL_BY_KEY: Record<PayMethod, string> = PAY_METHODS.reduce(
  (acc, m) => {
    acc[m.key] = m.label;
    return acc;
  },
  {} as Record<PayMethod, string>
);

const ICON_BY_KEY: Record<PayMethod, LucideIcon> = PAY_METHODS.reduce(
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

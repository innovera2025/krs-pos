/**
 * Shared types + presentation helpers for the /members loyalty surface (loyalty
 * program, Phase 1B). Points are plain integers (NO money/Decimal), so formatting is
 * a thousands-separated integer, never the baht `money()` helper.
 *
 * LOYALTY ACCENT = gold/amber (distinct from promo=mint, tax/manual=blue) so a points
 * figure is never mistaken for a discount. These are the tokens the plan pins.
 */

/** Gold/amber loyalty accent — foreground text, accent, and tint background. */
export const GOLD = {
  /** Points-figure text + strong accents. */
  fg: "#B45309",
  /** Brighter accent (active pill / focus). */
  accent: "#F59E0B",
  /** Soft tint background for points tiles / chips. */
  bg: "#FFFBEB",
} as const;

/** A member row as returned by GET /api/members (and the detail `member`). */
export type MemberRow = {
  id: string;
  name: string;
  phone: string | null;
  pointsBalance: number;
  memberSince: string | null;
  isMember: boolean;
};

/** One PointsTransaction ledger row (GET /api/members/[id]). */
export type PointsTxTypeValue = "EARN" | "REDEEM" | "ADJUST" | "REVERSAL";
export type LedgerEntry = {
  id: string;
  type: PointsTxTypeValue;
  points: number;
  balanceAfter: number;
  note: string | null;
  createdAt: string;
  orderId: string | null;
};

/** GET /api/members/[id] response shape. */
export type MemberDetail = {
  member: MemberRow;
  ledger: LedgerEntry[];
};

/** Thai label for each ledger movement kind. */
export const POINTS_TYPE_LABEL: Record<PointsTxTypeValue, string> = {
  EARN: "สะสมแต้ม",
  REDEEM: "ใช้แต้ม",
  ADJUST: "ปรับแต้ม",
  REVERSAL: "คืนแต้ม",
};

const THAI_DATE = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok",
  day: "numeric",
  month: "short",
  year: "numeric",
});

const THAI_DATETIME = new Intl.DateTimeFormat("th-TH", {
  timeZone: "Asia/Bangkok",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Bangkok short date (e.g. สมาชิกตั้งแต่). Null → em dash. */
export function fmtDate(iso: string | null): string {
  return iso ? THAI_DATE.format(new Date(iso)) : "—";
}

/** Bangkok short date+time for a ledger entry. */
export function fmtDateTime(iso: string): string {
  return THAI_DATETIME.format(new Date(iso));
}

/** Thousands-separated integer points (never the baht money helper). */
export function fmtPoints(n: number): string {
  return n.toLocaleString("en-US");
}

/** Signed points with an explicit leading + for a credit (a debit already has −). */
export function fmtSignedPoints(n: number): string {
  return n > 0 ? `+${fmtPoints(n)}` : fmtPoints(n);
}

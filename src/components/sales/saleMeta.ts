import type { OrderDTO, SaleStatus, SyncStatus } from "@/types";

/**
 * Status + sync badge metadata for Sales History, ported from the Simple POS
 * source-of-truth (statusMeta / syncMeta) into the Taste light palette. Each
 * badge is {label (Thai) + en + background + foreground + dot} so the table and
 * drawer render identically.
 */

export type BadgeMeta = {
  label: string;
  en: string;
  bg: string;
  fg: string;
  dot: string;
};

const STATUS_META: Partial<Record<SaleStatus, BadgeMeta>> = {
  COMPLETED: { label: "ชำระแล้ว", en: "Paid", bg: "#f0fdf4", fg: "#15803d", dot: "#16a34a" },
  REFUNDED: { label: "คืนเงิน", en: "Refunded", bg: "#fff7ed", fg: "#c2410c", dot: "#ea580c" },
  VOIDED: { label: "ยกเลิก", en: "Voided", bg: "#f8fafc", fg: "#64748b", dot: "#94a3b8" },
  PENDING: { label: "รอชำระ", en: "Pending", bg: "#eff6ff", fg: "#1d4ed8", dot: "#2563eb" },
  CANCELLED: { label: "ยกเลิกบิล", en: "Cancelled", bg: "#f8fafc", fg: "#64748b", dot: "#94a3b8" },
};

const SYNC_META: Record<SyncStatus, BadgeMeta> = {
  SYNCED: { label: "ซิงค์แล้ว", en: "Synced", bg: "#f0fdf4", fg: "#15803d", dot: "#16a34a" },
  PENDING: { label: "รอส่ง", en: "Pending", bg: "#eff6ff", fg: "#1d4ed8", dot: "#2563eb" },
  DAILY: { label: "สรุปรายวัน", en: "In daily", bg: "#f8fafc", fg: "#475569", dot: "#64748b" },
  FAILED: { label: "ส่งไม่สำเร็จ", en: "Failed", bg: "#fef2f2", fg: "#b91c1c", dot: "#dc2626" },
  SKIPPED: { label: "ข้าม", en: "Skipped", bg: "#faf5ff", fg: "#7c3aed", dot: "#a855f7" },
};

const STATUS_FALLBACK: BadgeMeta = {
  label: "ไม่ทราบ",
  en: "Unknown",
  bg: "#f8fafc",
  fg: "#64748b",
  dot: "#94a3b8",
};

export function statusMeta(status: SaleStatus): BadgeMeta {
  return STATUS_META[status] ?? STATUS_FALLBACK;
}

export function syncMeta(sync: SyncStatus): BadgeMeta {
  return SYNC_META[sync] ?? STATUS_FALLBACK;
}

/** Sales History filter chips (ported from Simple POS salesFilterDef). The "refunded"
 *  chip was removed (krs-void-writeback, 19-07-26 — no new refunds can be created); the
 *  REFUNDED badge (STATUS_META.REFUNDED) still renders for historical rows. */
export type SalesFilter =
  | "all"
  | "paid"
  | "voided"
  | "failed"
  | "tax";

export const SALES_FILTERS: { key: SalesFilter; label: string }[] = [
  { key: "all", label: "ทั้งหมด" },
  { key: "paid", label: "ชำระแล้ว" },
  { key: "voided", label: "ยกเลิก" },
  { key: "failed", label: "ซิงค์ล้มเหลว" },
  { key: "tax", label: "ขอใบกำกับ" },
];

/** Does an order pass the given filter chip? Mirrors Simple POS filter logic. */
export function matchesFilter(order: OrderDTO, filter: SalesFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "paid":
      return order.status === "COMPLETED";
    case "voided":
      return order.status === "VOIDED";
    case "failed":
      return order.syncStatus === "FAILED";
    case "tax":
      return order.taxRequested === true;
    default:
      return true;
  }
}

/** The "general customer" label when an order has no named customer (Phase 6). */
export const WALK_IN_LABEL = "ลูกค้าทั่วไป";

/**
 * Compact Bangkok datetime for the table/drawer (e.g. "16 มิ.ย. 13:58"),
 * matching the Simple POS `dt` field format.
 */
export function formatSaleTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("th-TH", {
    timeZone: "Asia/Bangkok",
    day: "2-digit",
    month: "short",
  });
  const time = d.toLocaleTimeString("th-TH", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${date} ${time}`;
}

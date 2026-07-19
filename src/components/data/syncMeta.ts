import type { SyncJobType, SyncJobStatus, SyncDirection } from "@/types";

/**
 * Sync-job badge + direction metadata for the KRS Data Link (/data) screen,
 * ported from the Simple POS source-of-truth (syncMeta / dirMeta / jobTypeLabel)
 * into the Taste light palette. Parallels components/sales/saleMeta.ts but keys on
 * the SyncJobStatus enum (PENDING/SYNCED/FAILED/RETRYING/SKIPPED) — note RETRYING
 * exists here but not in the Order SyncStatus.
 */

export type SyncBadgeMeta = {
  label: string;
  en: string;
  bg: string;
  fg: string;
  dot: string;
};

const SYNC_JOB_META: Record<SyncJobStatus, SyncBadgeMeta> = {
  SYNCED: { label: "ซิงค์แล้ว", en: "Synced", bg: "#f0fdf4", fg: "#15803d", dot: "#16a34a" },
  PENDING: { label: "รอส่ง", en: "Pending", bg: "#eff6ff", fg: "#1d4ed8", dot: "#2563eb" },
  FAILED: { label: "ส่งไม่สำเร็จ", en: "Failed", bg: "#fef2f2", fg: "#b91c1c", dot: "#dc2626" },
  RETRYING: { label: "กำลังลองใหม่", en: "Retrying", bg: "#fffbeb", fg: "#b45309", dot: "#d97706" },
  SKIPPED: { label: "ข้าม", en: "Skipped", bg: "#faf5ff", fg: "#7c3aed", dot: "#a855f7" },
};

const SYNC_JOB_FALLBACK: SyncBadgeMeta = {
  label: "ไม่ทราบ",
  en: "Unknown",
  bg: "#f8fafc",
  fg: "#64748b",
  dot: "#94a3b8",
};

export function syncJobMeta(status: SyncJobStatus): SyncBadgeMeta {
  return SYNC_JOB_META[status] ?? SYNC_JOB_FALLBACK;
}

/** Thai/EN label for a sync job kind (Simple POS jobTypeLabel). */
const JOB_TYPE_LABEL: Record<SyncJobType, string> = {
  SALE: "ขาย · Sale",
  REFUND: "คืนเงิน · Refund",
  STOCK: "สต็อก · Stock",
  PULL: "ดึงข้อมูล · Pull",
  TAX_INVOICE: "ใบกำกับภาษี · Tax invoice",
  STOCK_ADJ: "ปรับสต็อก · Stock adj.",
  RECEIVE: "รับสินค้าเข้า · Goods receipt",
  VOID: "ยกเลิกบิล · Void",
};

export function jobTypeLabel(type: SyncJobType): string {
  return JOB_TYPE_LABEL[type] ?? type;
}

/** Direction badge metadata (Simple POS dirMeta). */
export type DirectionMeta = {
  label: string;
  en: string;
  color: string;
  bg: string;
  /** lucide-style SVG path `d` for the inline arrow. */
  icon: string;
};

const DIRECTION_META: Record<SyncDirection, DirectionMeta> = {
  INSERT: {
    label: "ส่งขึ้น KRS",
    en: "INSERT",
    color: "#15803d",
    bg: "#f0fdf4",
    icon: "M12 19V5M5 12l7-7 7 7",
  },
  PULL: {
    label: "ดึงจาก KRS",
    en: "PULL",
    color: "#1d4ed8",
    bg: "#eff6ff",
    icon: "M12 5v14M19 12l-7 7-7-7",
  },
};

export function directionMeta(direction: SyncDirection): DirectionMeta {
  return (
    DIRECTION_META[direction] ?? {
      label: direction,
      en: "",
      color: "#64748b",
      bg: "#f1f5f9",
      icon: "",
    }
  );
}

/** Compact HH:MM (Asia/Bangkok) for the jobs-table time column; "—" when null. */
export function formatJobTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("th-TH", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
  });
}

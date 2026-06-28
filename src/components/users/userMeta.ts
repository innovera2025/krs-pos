import type { Role } from "@prisma/client";

/** A user as returned by the users API (NEVER includes password). */
export type UserDTO = {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  branchId: string;
  // Branch/Warehouse program (Phase 2): the user's assigned KRS WarehouseCode
  // (e.g. "WH01"), or null/absent = unassigned. The branch is DERIVED from the
  // Warehouse master (looked up by warehouseCode) for display — branchCode is never
  // stored on the user.
  warehouseCode?: string | null;
  createdAt: string;
  // Lockout state (auth Phase 3). `lockedUntil` is an ISO string when the account
  // is locked (null/absent otherwise); a value in the future means "Locked now".
  lockedUntil?: string | null;
  failedLoginAttempts?: number;
};

/** True when the user is currently locked out (lockedUntil is in the future). */
export function isLocked(user: Pick<UserDTO, "lockedUntil">): boolean {
  if (!user.lockedUntil) return false;
  const until = new Date(user.lockedUntil).getTime();
  return Number.isFinite(until) && until > Date.now();
}

/**
 * UI role mapping: Simple POS speaks seller/admin; the schema enum is
 * ADMIN/MANAGER/CASHIER. seller ↔ CASHIER, admin ↔ ADMIN (MANAGER unused).
 */
export type UiRole = "admin" | "seller";

/** Map a UI role to the Prisma Role enum value sent to the API. */
export function uiRoleToEnum(role: UiRole): Role {
  return role === "admin" ? "ADMIN" : "CASHIER";
}

/** Thai display label for a Prisma Role. */
export function roleLabel(role: Role): string {
  switch (role) {
    case "ADMIN":
      return "Admin · ผู้ดูแล";
    case "MANAGER":
      return "Manager · หัวหน้า";
    case "CASHIER":
    default:
      return "ผู้ขาย · Seller";
  }
}

/** Treat ADMIN/MANAGER as admin-tier for the filter chips; CASHIER as seller. */
export function isAdminTier(role: Role): boolean {
  return role === "ADMIN" || role === "MANAGER";
}

/**
 * Role-permission summary content for the two cards
 * (rolegate-seller-permissions / rolegate-admin-permissions).
 */
export const SELLER_PERMISSIONS = {
  allowed: ["ขายหน้าร้าน (POS)", "ดูประวัติการขาย", "ปิดรอบขาย (กะของตน)"],
  denied: ["จัดการสินค้า/สต็อก", "จัดการผู้ใช้และสิทธิ์", "เชื่อมข้อมูล KRS", "เอกสารออกแบบระบบ"],
};

export const ADMIN_PERMISSIONS = {
  allowed: [
    "ทุกสิทธิ์ของผู้ขาย",
    "จัดการสินค้า/สต็อก",
    "จัดการผู้ใช้และสิทธิ์",
    "เชื่อมข้อมูล KRS",
    "เอกสารออกแบบระบบ",
  ],
  denied: [],
};

/** Up-to-2-char initials for the avatar (Thai or Latin). */
export function initials(name: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join("");
  return Array.from(parts[0])[0] + Array.from(parts[1])[0];
}

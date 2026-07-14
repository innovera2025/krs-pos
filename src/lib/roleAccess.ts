import type { AppRole } from "@/components/RoleProvider";

/**
 * ROLE-GATE MAP (rolegate-seller-vs-admin) — single source of truth.
 *
 * Which roles may see/visit each nav key. Mirrors Simple POS's navAccess:
 *  - pos / sales / shift  → both seller + admin
 *  - data / products / users / settings → admin only
 *
 * This map is now enforced on BOTH boundaries:
 *  - server: the middleware `authorized` callback (src/auth.config.ts) calls
 *    `canAccess` with the session role → a seller is redirected off admin routes.
 *  - client: the NavRail filter + the AdminOnly page guard (UX).
 *
 * The Prisma role is collapsed to the AppRole used here via lib/authRole
 * (ADMIN/MANAGER → admin, CASHIER → seller).
 */
export const NAV_ACCESS: Record<string, AppRole[]> = {
  pos: ["admin", "seller"],
  sales: ["admin", "seller"],
  shift: ["admin", "seller"],
  data: ["admin"],
  products: ["admin"],
  promotions: ["admin"],
  users: ["admin"],
  settings: ["admin"],
};

/** True when `role` may access the given nav key (defaults to admin-only). */
export function canAccess(navKey: string, role: AppRole): boolean {
  const allowed = NAV_ACCESS[navKey] ?? ["admin"];
  return allowed.includes(role);
}

/**
 * STRICT-ADMIN nav keys (promotions program, owner decision D2).
 *
 * NAV_ACCESS collapses MANAGER → admin (see lib/authRole), so a MANAGER passes
 * `canAccess("promotions", "admin")`. Promotion management is ADMIN-ONLY, so these
 * keys carry an EXTRA gate on top of canAccess: the caller must additionally be a
 * strict Prisma `Role.ADMIN` (isStrictAdmin). A MANAGER is bounced like a seller.
 *
 * Edge-safe: a plain string Set, no new imports — this file is consumed by the
 * edge middleware / auth.config route gate which must stay Prisma/bcrypt-free.
 */
export const STRICT_ADMIN_NAV: ReadonlySet<string> = new Set(["promotions"]);

/**
 * Access check layering the strict-ADMIN requirement on top of `canAccess`.
 *
 * A nav key in STRICT_ADMIN_NAV additionally requires `isStrictAdmin` (true only
 * for Prisma Role.ADMIN — a MANAGER is false even though it maps to the admin
 * AppRole). Non-strict keys behave EXACTLY like `canAccess` (isStrictAdmin is
 * ignored), so existing routes are unaffected.
 */
export function canAccessStrict(
  navKey: string,
  role: AppRole,
  isStrictAdmin: boolean
): boolean {
  return canAccess(navKey, role) && (!STRICT_ADMIN_NAV.has(navKey) || isStrictAdmin);
}

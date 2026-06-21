import type { AppRole } from "@/components/RoleProvider";

/**
 * ROLE-GATE MAP (rolegate-seller-vs-admin) — single source of truth.
 *
 * Which roles may see/visit each nav key. Mirrors Simple POS's navAccess:
 *  - pos / sales / shift  → both seller + admin
 *  - data / products / users / docs → admin only
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
  users: ["admin"],
  docs: ["admin"],
};

/** True when `role` may access the given nav key (defaults to admin-only). */
export function canAccess(navKey: string, role: AppRole): boolean {
  const allowed = NAV_ACCESS[navKey] ?? ["admin"];
  return allowed.includes(role);
}

import type { AppRole } from "@/components/RoleProvider";

/**
 * ROLE-GATE MAP (rolegate-seller-vs-admin) — single source of truth.
 *
 * Which roles may see/visit each nav key. Access policy (owner decision 15-07-26,
 * which SUPERSEDES the promotions-program decision D2 "ADMIN-only promotions"):
 *  - pos / sales / shift / products / promotions → both seller (CASHIER) + admin
 *  - data / users / settings → admin only
 *
 * NOTE on `products` (view-only for seller): a CASHIER may now VIEW the products
 * page (it is in NAV_ACCESS), but every mutation affordance is hidden client-side
 * and the products mutation APIs stay `requireAdmin` (ADMIN+MANAGER). This map only
 * governs page/nav VISIBILITY, not write authorization.
 *
 * NOTE on `promotions`: promotion management is now open to EVERY signed-in role
 * (create/edit/activate/deactivate + the Report tab). Accountability is the AuditLog
 * (every mutation records the actor) plus the Z-report / per-promotion report.
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
  products: ["admin", "seller"],
  promotions: ["admin", "seller"],
  users: ["admin"],
  settings: ["admin"],
};

/** True when `role` may access the given nav key (defaults to admin-only). */
export function canAccess(navKey: string, role: AppRole): boolean {
  const allowed = NAV_ACCESS[navKey] ?? ["admin"];
  return allowed.includes(role);
}

/**
 * STRICT-ADMIN nav keys — an EXTRA gate layered on top of `canAccess`: a key in
 * this set additionally requires a strict Prisma `Role.ADMIN` (isStrictAdmin), so a
 * MANAGER (which maps to the admin AppRole) is bounced like a seller.
 *
 * CURRENTLY EMPTY. Promotions used to live here (promotions-program decision D2,
 * "ADMIN-only"), but the owner SUPERSEDED that on 15-07-26 — promotion management is
 * now open to every signed-in role, so `promotions` was removed. The set + the
 * `canAccessStrict` machinery are retained (not deleted) for a future owner-only
 * surface; an empty set means `canAccessStrict` behaves EXACTLY like `canAccess`.
 *
 * Edge-safe: a plain string Set, no new imports — this file is consumed by the
 * edge middleware / auth.config route gate which must stay Prisma/bcrypt-free.
 */
export const STRICT_ADMIN_NAV: ReadonlySet<string> = new Set<string>();

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

import type { AppRole } from "@/components/RoleProvider";

/**
 * ⚠️ DEMO ROLE-GATE MAP — NOT SECURITY (rolegate-seller-vs-admin).
 *
 * Which roles may see/visit each nav key. Mirrors Simple POS's navAccess:
 *  - pos / sales / shift  → both seller + admin
 *  - data / products / users / docs → admin only
 *
 * This drives the client NavRail filter and the admin page guard ONLY. It is
 * not an authorization boundary — the server does not enforce it.
 * TODO(production-readiness): enforce on the server via session role + route
 * middleware; this client map is for UX/demo only.
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

import { Role } from "@prisma/client";
import type { AppRole } from "@/components/RoleProvider";

/**
 * Single source of truth for mapping the Prisma `Role` enum to the UI `AppRole`
 * vocabulary (production-readiness Phase 1).
 *
 * Approved decision: **MANAGER is treated as admin** (sees the same admin nav
 * areas as ADMIN). CASHIER maps to seller.
 *
 *   ADMIN   → admin
 *   MANAGER → admin   ← approved decision
 *   CASHIER → seller
 *
 * Applied consistently on BOTH boundaries:
 *  - server: middleware `authorized` + the API admin guard (lib/auth.ts)
 *  - client: the session-backed RoleProvider (UX only)
 *
 * `roleAccess.NAV_ACCESS` stays the source of truth for *which* nav areas each
 * AppRole may reach; this function only collapses the 3 Prisma roles into the 2
 * AppRoles that NAV_ACCESS is keyed by.
 */
export function prismaRoleToAppRole(role: Role): AppRole {
  switch (role) {
    case Role.ADMIN:
    case Role.MANAGER:
      return "admin";
    case Role.CASHIER:
      return "seller";
    default:
      // Exhaustive guard: a new Prisma Role must be mapped explicitly. Defaulting
      // to the least-privileged "seller" is the safe fallback if one is missed.
      return "seller";
  }
}

/** True when the Prisma role is treated as an admin (ADMIN or MANAGER). */
export function isAdminRole(role: Role): boolean {
  return prismaRoleToAppRole(role) === "admin";
}

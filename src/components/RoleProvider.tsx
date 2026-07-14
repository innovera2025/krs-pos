"use client";

import { createContext, useContext } from "react";
import { useSession } from "next-auth/react";
import { prismaRoleToAppRole } from "@/lib/authRole";

/**
 * Session-backed role context (production-readiness Phase 1).
 *
 * The role is now DERIVED from the real Auth.js session (`useSession()`), not a
 * localStorage demo value. The Prisma role on the session is mapped to the UI
 * `AppRole` via `prismaRoleToAppRole` (ADMIN/MANAGER → admin, CASHIER → seller —
 * MANAGER is treated as admin per the approved decision).
 *
 * ⚠️ This client role still drives UX ONLY (the NavRail filter + the AdminOnly
 * page guard). The real authorization boundary is server-side: middleware
 * (`authorized`) + per-route `requireUser`/`requireAdmin`. A tampered client role
 * cannot grant access to a protected route or API.
 */

/** UI role vocabulary (Simple POS uses seller/admin). Maps from Prisma Role via
 * lib/authRole: admin ↔ ADMIN|MANAGER, seller ↔ CASHIER. */
export type AppRole = "admin" | "seller";

type RoleContextValue = {
  role: AppRole;
  /**
   * Promotions program (strict-ADMIN gate, decision D2): true ONLY for a real
   * Prisma Role.ADMIN — a MANAGER (which maps to the admin AppRole above) is
   * false. Drives the /promotions NavRail item + the `<AdminOnly strict>` guard.
   * false pre-hydration (session not yet resolved), same as the least-privileged
   * default, so a MANAGER never sees the promotions item flash.
   */
  isStrictAdmin: boolean;
  /** The logged-in user's display name, when available (shown in the NavRail). */
  userName: string | null;
  /**
   * Branch/Warehouse program (Phase 3): the logged-in user's KRS WarehouseCode
   * (or null when unassigned), read from the session. Inert plumbing for now — the
   * POS client consumes it for per-warehouse stock display in Phase 5.
   */
  warehouseCode: string | null;
  /**
   * Branch/Warehouse program (Phase 3): the branch DERIVED from the Warehouse
   * master (or null), read from the session. Consumed by Phase 4/5 client surfaces.
   */
  branchCode: string | null;
  // false until the session status is resolved (not "loading"). Guards
  // (AdminOnly) wait for this before trusting `role`, so a seller never sees an
  // admin screen flash while the session is still loading.
  hydrated: boolean;
};

const RoleContext = createContext<RoleContextValue | null>(null);

/** Least-privileged default until/unless the session says otherwise. */
const DEFAULT_ROLE: AppRole = "seller";

export function RoleProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();

  // `status` is "loading" | "authenticated" | "unauthenticated". We treat the
  // role as known once it is no longer loading.
  const hydrated = status !== "loading";

  const role: AppRole = session?.user?.role
    ? prismaRoleToAppRole(session.user.role)
    : DEFAULT_ROLE;

  // Promotions program (decision D2): strict-ADMIN is the RAW Prisma role being
  // ADMIN — NOT the collapsed AppRole (which folds MANAGER in). null/undefined
  // session → false (least-privileged, matches pre-hydration).
  const isStrictAdmin = session?.user?.role === "ADMIN";

  const userName = session?.user?.name ?? null;

  // Branch/Warehouse program (Phase 3): surface the user's warehouse + derived
  // branch from the session so the POS client can scope stock display in Phase 5.
  // null when unassigned or before the session resolves.
  const warehouseCode = session?.user?.warehouseCode ?? null;
  const branchCode = session?.user?.branchCode ?? null;

  return (
    <RoleContext.Provider
      value={{ role, isStrictAdmin, userName, warehouseCode, branchCode, hydrated }}
    >
      {children}
    </RoleContext.Provider>
  );
}

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext);
  if (!ctx) {
    throw new Error("useRole must be used within a RoleProvider");
  }
  return ctx;
}

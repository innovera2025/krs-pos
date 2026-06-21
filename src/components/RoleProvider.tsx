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
  /** The logged-in user's display name, when available (shown in the NavRail). */
  userName: string | null;
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

  const userName = session?.user?.name ?? null;

  return (
    <RoleContext.Provider value={{ role, userName, hydrated }}>
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

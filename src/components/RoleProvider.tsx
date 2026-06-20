"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

/**
 * ⚠️ DEMO ROLE STUB — NOT SECURITY.
 *
 * This client-side role state mirrors Simple POS's demo role-switcher. It drives
 * the NavRail filter and the admin page guards for a faithful client demo only.
 *
 * It is NOT authentication or authorization:
 *  - the role lives in localStorage and is fully user-controllable/bypassable,
 *  - the server APIs do NOT enforce roles (any caller can hit them),
 *  - a "seller" can still reach an admin route by URL (the guard only redirects
 *    the client UI; it is not a security boundary).
 *
 * TODO(production-readiness): real auth/session + server-side RBAC + route
 * middleware. The session role (not this localStorage value) becomes the source
 * of truth, and every admin API/route is enforced on the server.
 */

/** UI role vocabulary (Simple POS uses seller/admin). Maps to Prisma Role:
 * admin ↔ ADMIN, seller ↔ CASHIER (MANAGER unused for now). */
export type AppRole = "admin" | "seller";

type RoleContextValue = {
  role: AppRole;
  setRole: (role: AppRole) => void;
  // false until the persisted role has been read from localStorage on the
  // client. Guards (AdminOnly) must wait for this before trusting `role`, so a
  // seller never sees an admin screen flash on a direct load/refresh.
  hydrated: boolean;
};

const RoleContext = createContext<RoleContextValue | null>(null);

const STORAGE_KEY = "krspos.demoRole";
const DEFAULT_ROLE: AppRole = "admin";

function isAppRole(v: unknown): v is AppRole {
  return v === "admin" || v === "seller";
}

export function RoleProvider({ children }: { children: React.ReactNode }) {
  // Start from the default on both server and first client render to avoid a
  // hydration mismatch; hydrate the persisted value in an effect below.
  const [role, setRoleState] = useState<AppRole>(DEFAULT_ROLE);
  // false on server + first client render; flips true after the effect reads
  // the stored role. No hydration mismatch: both initial renders see false.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isAppRole(stored)) setRoleState(stored);
    } catch {
      /* localStorage unavailable (private mode / SSR) — keep the default */
    }
    setHydrated(true);
  }, []);

  const setRole = useCallback((next: AppRole) => {
    setRoleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* persistence is best-effort for the demo */
    }
  }, []);

  return (
    <RoleContext.Provider value={{ role, setRole, hydrated }}>
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

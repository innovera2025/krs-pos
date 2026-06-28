import type { Role } from "@prisma/client";
import type { DefaultSession } from "next-auth";

/**
 * Auth.js v5 type augmentation (production-readiness Phase 1).
 *
 * Adds the two server-authoritative fields we put on the JWT + session:
 *  - `id`   — the User.id (cuid), used as the order's cashierId
 *  - `role` — the Prisma Role (ADMIN | MANAGER | CASHIER), used for server RBAC
 *
 * The Prisma `Role` enum is the single source of truth for the role vocabulary;
 * the UI `AppRole` (admin | seller) is a *mapped* view derived from it
 * (ADMIN/MANAGER → admin, CASHIER → seller), never stored on the token.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      /**
       * Branch/Warehouse program (Phase 3): the user's KRS WarehouseCode (e.g.
       * "WH01"), or null when unassigned. Copied from the JWT in the (edge-safe)
       * session callback — NO DB read there.
       */
      warehouseCode?: string | null;
      /**
       * Branch/Warehouse program (Phase 3): the branch DERIVED from the Warehouse
       * master (WH→branch is 1:1 in KRS), or null. NEVER stored on User — always
       * derived from the Warehouse table in src/auth.ts.
       */
      branchCode?: string | null;
    } & DefaultSession["user"];
  }

  /** The object returned from `authorize()` — carries role onto the jwt callback. */
  interface User {
    role: Role;
    /**
     * Force-logout baseline (auth Phase 3). Carried from authorize() so the jwt
     * callback can stamp it onto the token; an admin bumping the DB value
     * invalidates every existing JWT for the user on its next request.
     */
    tokenVersion?: number;
    /**
     * Branch/Warehouse program (Phase 3): the user's KRS WarehouseCode (or null),
     * carried from authorize() so the jwt callback can stamp it onto the token.
     */
    warehouseCode?: string | null;
    /**
     * Branch/Warehouse program (Phase 3): branch derived from the Warehouse master
     * inside authorize(), carried to the jwt callback. Null when unassigned.
     */
    branchCode?: string | null;
  }
}

// The JWT interface is declared in @auth/core/jwt (next-auth/jwt just
// re-exports it). Augment the source module so the added members merge onto the
// real interface rather than a re-export view.
declare module "@auth/core/jwt" {
  interface JWT {
    /** User.id (cuid). Mirrors `token.sub` but kept explicit for clarity. */
    id?: string;
    role?: Role;
    /**
     * Force-logout baseline (auth Phase 3). Stamped at sign-in; the jwt callback
     * re-reads the DB value each request and invalidates the token when they
     * diverge (an admin bumped tokenVersion).
     */
    tokenVersion?: number;
    /**
     * Last time the jwt callback ran the DB liveness re-check (epoch ms, perf
     * optimization). Used to THROTTLE that re-check to once per
     * SESSION_REVALIDATE_MS instead of every request. Optional: a token minted
     * before this field existed has it undefined → treated as "due" so the next
     * request runs a full check and stamps it.
     */
    lastCheckedAt?: number;
    /**
     * Branch/Warehouse program (Phase 3): the user's KRS WarehouseCode (or null).
     * Stamped at sign-in and refreshed on the throttled liveness re-read so a
     * mid-shift reassignment propagates within SESSION_REVALIDATE_MS.
     */
    warehouseCode?: string | null;
    /**
     * Branch/Warehouse program (Phase 3): branch DERIVED from the Warehouse master
     * (single source of truth), stamped + refreshed alongside warehouseCode. Null
     * when unassigned.
     */
    branchCode?: string | null;
  }
}

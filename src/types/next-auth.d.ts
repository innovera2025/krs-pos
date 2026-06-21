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
  }
}

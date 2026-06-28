import type { NextAuthConfig } from "next-auth";
import { canAccess } from "@/lib/roleAccess";
import { prismaRoleToAppRole } from "@/lib/authRole";

/**
 * Edge-safe Auth.js v5 config (production-readiness Phase 1).
 *
 * This half of the config contains ONLY things that are safe to run in the Edge
 * runtime (middleware): callbacks, pages, session strategy. It deliberately does
 * NOT import the Credentials provider, Prisma, or bcrypt — those are Node-only
 * and live in `src/auth.ts`. `middleware.ts` imports this config (via auth.ts's
 * re-export) so the route gate stays edge-compatible.
 *
 * ⚠️ Defense-in-depth: the `authorized` callback here is a UX redirect gate only
 * (it decides whether middleware lets a request through to a page). The REAL
 * authorization boundary is the per-route-handler `auth()` / `requireUser` /
 * `requireAdmin` checks in the API routes — middleware is bypassable in theory
 * and must never be the only gate.
 */

/**
 * The shell route prefixes that require an authenticated session.
 *
 * Exported as the single source of truth: the middleware (src/middleware.ts)
 * reuses this (via navKeyForPath) to enforce the route gate INSIDE its
 * `auth((req) => …)` callback. In this Auth.js v5 build the callback's returned
 * NextResponse WINS over the `authorized` callback's `return false`, so the gate
 * cannot live in `authorized` alone — both stay wired to these same prefixes.
 */
export const PROTECTED_PREFIXES = [
  "/pos",
  "/sales",
  "/shift",
  "/data",
  "/products",
  "/users",
  "/settings",
];

/** Map a (shell) pathname to its NAV_ACCESS key, or null if not a nav route. */
export function navKeyForPath(pathname: string): string | null {
  for (const prefix of PROTECTED_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix + "/")) {
      return prefix.slice(1); // "/users" → "users"
    }
  }
  return null;
}

export const authConfig: NextAuthConfig = {
  // JWT sessions (no Session table needed). 12h default lifetime.
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 },
  pages: { signIn: "/login" },
  // Providers are attached in src/auth.ts (Node runtime); kept empty here so the
  // edge config stays free of Prisma/bcrypt.
  providers: [],
  callbacks: {
    /**
     * Expose id + role on the client session (read by useSession / the role
     * provider). `token.sub` is the user id; `token.role` is set in the jwt
     * callback (src/auth.ts).
     */
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      if (token.role) session.user.role = token.role;
      // Branch/Warehouse program (Phase 3): copy the warehouse + derived branch
      // from the token onto the client session. PURE field copy — NO DB read here
      // (this file is imported by the EDGE middleware and must stay prisma-free).
      // null is meaningful (unassigned user), so copy it through unconditionally.
      session.user.warehouseCode = token.warehouseCode ?? null;
      session.user.branchCode = token.branchCode ?? null;
      return session;
    },

    /**
     * Middleware route gate (UX redirect only — NOT the security boundary).
     *
     * ⚠️ NOTE on the callback wrapper form: middleware.ts uses
     * `auth((req) => { … return NextResponse.next(); })`. In this Auth.js v5
     * build the callback's RETURNED NextResponse wins over this `authorized`
     * result — so when middleware short-circuits with a NextResponse, this
     * callback's `return false` is NOT applied. The EFFECTIVE gate therefore
     * lives inside the middleware callback (which reuses navKeyForPath /
     * canAccess / prismaRoleToAppRole). This `authorized` callback is kept as
     * correct, belt-and-braces defense-in-depth (e.g. if the wrapper form is
     * ever removed) — it is intentionally NOT deleted.
     *
     * - Always allow non-protected paths (/login, /api/auth/*, assets are
     *   excluded by the matcher, but this is belt-and-braces).
     * - Require a signed-in user for any protected (shell) prefix.
     * - For admin-only nav areas (data/products/users/settings) additionally require
     *   the mapped role to satisfy NAV_ACCESS; a seller hitting an admin route is
     *   redirected to /pos (a route they can access) instead of /login.
     */
    authorized({ auth, request }) {
      const { pathname } = request.nextUrl;
      const navKey = navKeyForPath(pathname);

      // Not a protected route → always allow.
      if (!navKey) return true;

      // Protected route but no session → redirect to /login (Auth.js uses
      // pages.signIn + appends the callbackUrl automatically).
      if (!auth?.user) return false;

      // Authenticated: enforce the nav-access map by mapped role. If this role
      // may not access the nav key, bounce to /pos (a route every role can
      // reach) rather than the login page.
      const appRole = prismaRoleToAppRole(auth.user.role);
      if (!canAccess(navKey, appRole)) {
        const posUrl = new URL("/pos", request.nextUrl);
        return Response.redirect(posUrl);
      }

      return true;
    },
  },
};

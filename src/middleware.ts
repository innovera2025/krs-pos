import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

// Security-review FIX B: build the middleware NextAuth instance from the EDGE-SAFE
// `authConfig` (src/auth.config.ts) ONLY — never from `@/auth` (the Node config),
// which pulls in Prisma + bcrypt + the DB-querying jwt callback. Bundling those
// into the Edge runtime makes every authenticated protected-route navigation 500
// (Prisma cannot run in Edge). `authConfig` has NO Prisma/bcrypt — only the
// edge-safe `authorized`/`session` callbacks + empty providers. The JWT (role/sub)
// is stamped by the Node-side jwt callback at sign-in, so the edge gate reads role
// from the token with NO DB call. The per-request `isActive` liveness re-check
// stays in the Node `@/auth` jwt callback (still enforced at the API layer via
// requireUser/requireAdmin), so deactivated users remain blocked.
export const { auth: middleware } = NextAuth(authConfig);

/**
 * Route gate middleware (production-readiness Phase 1).
 *
 * Auth.js runs the edge-safe `authorized` callback (src/auth.config.ts) for every
 * matched request and redirects unauthenticated users to /login (with a
 * callbackUrl) and seller→admin-route attempts to /pos.
 *
 * ⚠️ Prerequisite: this app is on Next 14.2.35, which patches CVE-2025-29927
 * (the `x-middleware-subrequest` middleware-auth-bypass). Do NOT downgrade below
 * 14.2.25. Even so, middleware is treated as a UX redirect only — the real
 * authorization boundary is the per-route-handler auth() checks in the APIs.
 *
 * The matcher EXCLUDES /api/auth (Auth.js endpoints), /login (the sign-in page,
 * else a redirect loop), /_next (build assets), and common static files
 * (favicon, images, fonts) so those are never gated.
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except:
     *  - api/auth (Auth.js endpoints)
     *  - login (the sign-in page itself)
     *  - _next/static, _next/image (Next build/image assets)
     *  - favicon.ico and common static asset extensions
     */
    "/((?!api/auth|login|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|ttf)$).*)",
  ],
};

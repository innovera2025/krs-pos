import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig, navKeyForPath } from "@/auth.config";
import { canAccess } from "@/lib/roleAccess";
import { prismaRoleToAppRole } from "@/lib/authRole";

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
const { auth } = NextAuth(authConfig);

// Phase 3 observability — per-request correlation id (D1/middleware).
//
// The `auth((req) => {...})` wrapper form is used (NOT `export const middleware =
// auth` directly) to attach an `x-request-id` to every matched request.
//
// ⚠️ AUTH-GATE FIX: in this Auth.js v5 build, a NextResponse RETURNED from this
// callback WINS over the `authorized` callback's result — so the `authorized`
// callback's `return false` (the /login redirect) is NEVER applied while this
// wrapper returns `NextResponse.next()`. (The earlier comment claiming "returning
// falsy lets Auth.js apply the authorized redirect" was WRONG for this form: this
// callback always returns a NextResponse, so Auth.js never short-circuits and
// unauthenticated users reached protected pages with a 200.) The route gate is
// therefore enforced EXPLICITLY here, BEFORE the x-request-id logic, reusing the
// SAME helpers as `authorized` (navKeyForPath / canAccess / prismaRoleToAppRole)
// so the two stay in lock-step. The `authorized` callback is kept as
// belt-and-braces defense-in-depth.
//
// EDGE-SAFE: this uses ONLY `crypto.randomUUID()` + the Web URL/NextResponse APIs
// (all available in the Edge runtime) plus the PURE helpers above (navKeyForPath,
// canAccess, prismaRoleToAppRole — no Node/Prisma/pino imports). It does NOT
// import pino or the Node-only `@/lib/requestContext` / `@/lib/logger` modules, so
// the edge bundle stays free of Node libs. The Node route handlers re-read the
// header via runWithRequestId(req, ...) to seed their AsyncLocalStorage context.
//
// The id is REUSED from an inbound `x-request-id` (so an upstream proxy/gateway id
// is honored end-to-end) else freshly minted. It is propagated to the downstream
// Node handler via the forwarded REQUEST headers and echoed on the RESPONSE header
// so clients/log aggregators can correlate the round-trip.
export const middleware = auth((req) => {
  // --- Route gate (enforced HERE — see the ⚠️ note above) ----------------------
  // `req.auth` is the session (stamped by the Node-side jwt callback at sign-in);
  // reading it requires NO DB call, so this stays edge-safe.
  const { pathname } = req.nextUrl;
  const navKey = navKeyForPath(pathname);
  if (navKey) {
    // Protected route, no session → redirect to /login with a callbackUrl so the
    // user returns to the page they wanted after signing in.
    if (!req.auth?.user) {
      const loginUrl = new URL("/login", req.nextUrl);
      loginUrl.searchParams.set("callbackUrl", pathname + req.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
    // Authenticated but this role can't access the nav area → bounce to /pos
    // (a route every role can reach) rather than the login page.
    const appRole = prismaRoleToAppRole(req.auth.user.role);
    if (!canAccess(navKey, appRole)) {
      return NextResponse.redirect(new URL("/pos", req.nextUrl));
    }
  }

  // --- Allowed through: attach the correlation id (unchanged) -------------------
  const incoming = req.headers.get("x-request-id");
  const requestId =
    incoming && incoming.length > 0 ? incoming : crypto.randomUUID();

  // Forward the id to the Node route handlers via the request headers.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-request-id", requestId);

  // NextResponse.next() with the mutated request headers passes the id downstream;
  // echoing it on the response header surfaces it to the caller. This runs only on
  // the allowed-through path (the gate above has already returned a redirect for
  // any denied request).
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("x-request-id", requestId);
  return res;
});

/**
 * Route gate middleware (production-readiness Phase 1).
 *
 * For every matched request the middleware callback above enforces the route gate
 * directly (reusing navKeyForPath / canAccess / prismaRoleToAppRole from the
 * edge-safe config): unauthenticated users hitting a protected (shell) prefix are
 * redirected to /login (with a callbackUrl) and seller→admin-route attempts are
 * bounced to /pos. The gate runs in the callback (NOT via the `authorized`
 * callback) because in this Auth.js v5 build the callback's returned NextResponse
 * wins over the `authorized` result — see the ⚠️ note on the middleware callback.
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

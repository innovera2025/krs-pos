import NextAuth from "next-auth";
import { NextResponse } from "next/server";
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
const { auth } = NextAuth(authConfig);

// Phase 3 observability — per-request correlation id (D1/middleware).
//
// The `auth((req) => {...})` wrapper form is used (NOT `export const middleware =
// auth` directly) for ONE reason: to attach an `x-request-id` to every matched
// request WITHOUT changing the auth gate. Returning `undefined`/falsy from this
// callback lets Auth.js apply its OWN authorized-callback result (the redirect to
// /login or /pos), so the existing auth redirect/authorized behavior is preserved
// EXACTLY — we only intervene to add the header on the allowed-through path.
//
// EDGE-SAFE: this uses ONLY `crypto.randomUUID()` (a Web API available in the Edge
// runtime) + NextResponse. It does NOT import pino or the Node-only
// `@/lib/requestContext` / `@/lib/logger` modules, so the edge bundle stays free
// of Node libs. The Node route handlers re-read this header via
// runWithRequestId(req, ...) to seed their AsyncLocalStorage logging context.
//
// The id is REUSED from an inbound `x-request-id` (so an upstream proxy/gateway id
// is honored end-to-end) else freshly minted. It is propagated to the downstream
// Node handler via the forwarded REQUEST headers and echoed on the RESPONSE header
// so clients/log aggregators can correlate the round-trip.
export const middleware = auth((req) => {
  const incoming = req.headers.get("x-request-id");
  const requestId =
    incoming && incoming.length > 0 ? incoming : crypto.randomUUID();

  // Forward the id to the Node route handlers via the request headers.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-request-id", requestId);

  // NextResponse.next() with the mutated request headers passes the id downstream;
  // echoing it on the response header surfaces it to the caller. This runs only
  // when the request is allowed through — when the authorized callback denies the
  // request, Auth.js short-circuits with its redirect BEFORE this callback body is
  // used, so the auth gate is untouched.
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("x-request-id", requestId);
  return res;
});

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

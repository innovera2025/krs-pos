import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/auth.config";
import {
  isRateLimited,
  recordFailure,
  clearAttempts,
} from "@/lib/rateLimit";

/**
 * Security-review FIX D: fixed dummy bcrypt hash used to defeat a user-enumeration
 * timing oracle. When the email is NOT found we still run bcrypt.compare against
 * this hash, so the unknown-email path costs the same as the wrong-password path
 * (an attacker can't distinguish "no such account" from "bad password" by timing).
 * Computed once at module load (cost 12, matching the seed/auth cost).
 */
const DUMMY_HASH = bcrypt.hashSync("invalid-password-placeholder", 12);

/**
 * Auth.js v5 — full (Node-runtime) config (production-readiness Phase 1).
 *
 * Security model (cash POS — highest-stakes surface):
 *  - Credentials provider: email + password, verified with bcrypt.compare.
 *  - Passwords are bcrypt hashes (cost 12); the hash is NEVER selected into the
 *    returned user object, never logged, never sent to the client.
 *  - JWT session (httpOnly + Secure + SameSite cookie — Auth.js defaults),
 *    signed with AUTH_SECRET.
 *  - `isActive` is enforced TWICE:
 *      1. at sign-in time, in `authorize` (an inactive user cannot log in), and
 *      2. on EVERY request, in the `jwt` callback (re-reads isActive from the DB
 *         by token.sub so a deactivation takes effect promptly despite the JWT
 *         being self-contained — without this, a stolen/old token for a now
 *         deactivated user would stay valid until expiry).
 *
 * Edge-safe callbacks (session/authorized) + pages + session strategy live in
 * src/auth.config.ts so middleware can import them without pulling in Prisma or
 * bcrypt. This module merges that config with the Node-only Credentials provider
 * and the DB-backed jwt callback.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        // Validate presence + shape at the boundary (never trust the client).
        const email =
          typeof credentials?.email === "string"
            ? credentials.email.trim().toLowerCase()
            : "";
        const password =
          typeof credentials?.password === "string" ? credentials.password : "";
        if (email.length === 0 || password.length === 0) return null;

        // Rate-limit key = ip:email (auth Phase 2). ip:email (not ip-only, which
        // would lock out a shared store terminal; not email-only, which would let
        // an attacker lock a victim from anywhere). `headers()` is async in this
        // Next version — await it. x-forwarded-for may be a comma list; take the
        // first (client) hop.
        const ip =
          (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ??
          "unknown";
        const rateKey = `${ip}:${email}`;

        // Locked out: short-circuit BEFORE the DB lookup + bcrypt. Surface a
        // distinct code so the client shows a "try again later" message.
        // NOTE: Auth.js v5's CredentialsSignin constructor force-sets
        // `code = "credentials"` AFTER super(), so a constructor arg is ignored —
        // assign `.code` AFTER construction (it overrides) → redirect carries
        // error=CredentialsSignin&code=RATE_LIMITED.
        if (isRateLimited(rateKey)) {
          const err = new CredentialsSignin();
          err.code = "RATE_LIMITED";
          throw err;
        }

        // Select ONLY what we need, including the password hash for verification.
        // The hash is used locally for bcrypt.compare and is NEVER returned.
        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            password: true,
            isActive: true,
          },
        });

        // Security-review FIX D: ALWAYS run bcrypt.compare so the unknown-email
        // path costs the same as the wrong-password path (no enumeration timing
        // oracle). When the user is missing we compare against the fixed
        // DUMMY_HASH; the result is irrelevant because the `!user` check below
        // still rejects. Return null on ANY of: no user / bad password /
        // inactive — a single generic outcome so we never enumerate which
        // accounts exist or are suspended.
        const ok = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);
        if (!user || !ok || !user.isActive) {
          // Count the failed attempt against the live window (rate-limit).
          recordFailure(rateKey);
          return null;
        }

        // Success — clear the failure counter for this key so a legit user is
        // never penalized after eventually signing in.
        clearAttempts(rateKey);

        // The returned object becomes `user` in the jwt callback. The password
        // hash is deliberately excluded.
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        };
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    /**
     * jwt callback (Node runtime — has DB access).
     *
     * - On sign-in (`user` present): stamp id + role onto the token.
     * - On EVERY call: re-read isActive from the DB by token.sub. If the user no
     *   longer exists or is now inactive, blank out `sub`/`role` so the
     *   `authorized` callback (which requires `auth.user`) treats the request as
     *   unauthenticated → the user is redirected to /login on the next protected
     *   navigation, and API `requireUser` returns 401. This makes deactivation
     *   take effect promptly even though the JWT itself is self-contained.
     */
    async jwt({ token, user }) {
      // Initial sign-in: persist id + role from the authorize() result.
      if (user) {
        token.sub = user.id;
        token.id = user.id;
        token.role = user.role;
      }

      // Per-request liveness re-check. token.sub is the user id.
      if (token.sub) {
        const fresh = await prisma.user.findUnique({
          where: { id: token.sub },
          select: { isActive: true, role: true },
        });
        if (!fresh || !fresh.isActive) {
          // Invalidate the token: drop identity so authorized()/requireUser fail.
          delete token.sub;
          delete token.id;
          delete token.role;
          return token;
        }
        // Keep the role fresh too (e.g. an admin demotion takes effect promptly).
        token.role = fresh.role;
      }

      return token;
    },
  },
});

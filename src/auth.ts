import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { headers } from "next/headers";
import bcrypt from "bcryptjs";
import { AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
// Anchor the fail-fast env validation to the auth module too (Node-only). Auth.js
// requires AUTH_SECRET to sign the JWT session; importing env here makes a missing/
// short secret throw at boot rather than silently fail at first session access.
// NEVER import this from src/auth.config.ts (edge) — only from this Node module.
import "@/lib/env";
import { authConfig } from "@/auth.config";
import {
  isRateLimited,
  recordFailure,
  clearAttempts,
} from "@/lib/rateLimit";
import { logAudit } from "@/lib/auditLog";

/**
 * Account-lockout policy (auth Phase 3). After LOCKOUT_THRESHOLD consecutive
 * failed sign-ins for an EXISTING user, the account is locked for LOCKOUT_MS;
 * the lock auto-expires (or an admin clears it). This is the PERSISTENT layer
 * (DB-backed, per-account) that complements the in-memory per-IP:email rate
 * limiter (burst protection that resets on restart).
 */
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_MS = 15 * 60 * 1000;

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

        // Best-effort client IP for the audit trail (first x-forwarded-for hop).
        const auditIp = ip === "unknown" ? null : ip;

        // (1) In-memory rate-limit (burst / per-IP:email): short-circuit BEFORE
        // the DB lookup + bcrypt. Surface a distinct code so the client shows a
        // "try again later" message.
        // NOTE: Auth.js v5's CredentialsSignin constructor force-sets
        // `code = "credentials"` AFTER super(), so a constructor arg is ignored —
        // assign `.code` AFTER construction (it overrides) → redirect carries
        // error=CredentialsSignin&code=RATE_LIMITED.
        if (isRateLimited(rateKey)) {
          await logAudit({
            action: AuditAction.LOGIN_RATE_LIMITED,
            actorEmail: email,
            ip: auditIp,
          });
          const err = new CredentialsSignin();
          err.code = "RATE_LIMITED";
          throw err;
        }

        // (2) DB lookup. Select ONLY what we need, including the password hash
        // for verification and the lockout/version fields. The hash is used
        // locally for bcrypt.compare and is NEVER returned.
        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            password: true,
            isActive: true,
            failedLoginAttempts: true,
            lockedUntil: true,
            tokenVersion: true,
          },
        });

        // (3) Security-review FIX D: ALWAYS run bcrypt.compare so the
        // unknown-email path costs the same as the wrong-password path (no
        // enumeration timing oracle). When the user is missing we compare against
        // the fixed DUMMY_HASH; the result is irrelevant because the checks below
        // still reject. Run bcrypt BEFORE the lock-decision so a locked account
        // costs the same as an unlocked one (no timing oracle on lock state).
        const ok = await bcrypt.compare(password, user?.password ?? DUMMY_HASH);

        const now = new Date();

        // (4) Lockout: an existing user whose lock has not yet expired is
        // rejected with a distinct ACCOUNT_LOCKED code (bcrypt already ran above,
        // so this branch is constant-time relative to a normal failure). The lock
        // auto-expires once `lockedUntil` passes.
        if (user && user.lockedUntil && user.lockedUntil > now) {
          recordFailure(rateKey);
          await logAudit({
            action: AuditAction.LOGIN_FAILURE,
            actorId: user.id,
            actorEmail: user.email,
            ip: auditIp,
            detail: JSON.stringify({ reason: "locked" }),
          });
          const err = new CredentialsSignin();
          err.code = "ACCOUNT_LOCKED";
          throw err;
        }

        // (5) Auth failure (no user / bad password / inactive). Return null on
        // ANY of these — a single generic outcome so we never enumerate which
        // accounts exist or are suspended.
        if (!user || !ok || !user.isActive) {
          // Count the failed attempt against the live in-memory window.
          recordFailure(rateKey);

          // Persistent per-account counter: advance ONLY on a real password
          // failure for an EXISTING user (`user && !ok`). A correct password
          // against an INACTIVE user (`ok === true` but `!isActive`) is still
          // rejected (null below) but MUST NOT increment/lock — otherwise a user
          // who was never going to be admitted can self-lock and pollute the
          // audit with spurious ACCOUNT_LOCKED. An unknown email has no row to
          // update. At the threshold, set the lock window.
          //
          // Persistent lockout counter (AWAITED). The increment + lockedUntil
          // MUST be committed before this user's NEXT sign-in reads them (step 4
          // above) — otherwise the lock never becomes visible and the control
          // silently fails to engage. An earlier fire-and-forget variant traded
          // this determinism away to shave a DB-write timing oracle; the e2e
          // proved the lockout then failed to engage under fast cadence (the
          // increment had not committed before the next attempt's read), so we
          // await here.
          //
          // Residual timing oracle (accepted LOW): this awaited UPDATE makes an
          // existing-user password failure cost one extra PK-indexed write vs an
          // unknown email. That delta is sub-millisecond and sits far below the
          // ~tens-of-ms bcrypt.compare that runs identically on BOTH paths
          // (DUMMY_HASH, FIX D) and dominates the timing profile; the per-IP:email
          // rate limit (15/10min) further caps any probing. The atomic
          // `{ increment: 1 }` keeps the counter correct; the threshold decision
          // uses the value read at login above (single-store: failed sign-ins for
          // one account are effectively sequential, so no lost-update race).
          if (user && !ok) {
            const nextAttempts = user.failedLoginAttempts + 1;
            const reachedThreshold = nextAttempts >= LOCKOUT_THRESHOLD;
            const lockedUntil = reachedThreshold
              ? new Date(now.getTime() + LOCKOUT_MS)
              : null;
            try {
              await prisma.user.update({
                where: { id: user.id },
                data: {
                  failedLoginAttempts: { increment: 1 },
                  ...(reachedThreshold ? { lockedUntil } : {}),
                },
              });
            } catch (e) {
              // Never let a counter-update failure break the (already-failed)
              // login path; the generic null below still rejects.
              console.error("lockout counter update failed:", e);
            }
            if (reachedThreshold) {
              await logAudit({
                action: AuditAction.ACCOUNT_LOCKED,
                actorId: user.id,
                actorEmail: user.email,
                ip: auditIp,
                detail: JSON.stringify({
                  attempts: nextAttempts,
                  lockedUntil: lockedUntil?.toISOString() ?? null,
                }),
              });
            }
          }

          await logAudit({
            action: AuditAction.LOGIN_FAILURE,
            actorId: user?.id ?? null,
            actorEmail: email,
            ip: auditIp,
            detail: JSON.stringify({
              reason: !user ? "unknown" : !ok ? "bad_password" : "inactive",
            }),
          });
          return null;
        }

        // (6) Success — reset the persistent counter + clear the live in-memory
        // window so a legit user is never penalized after eventually signing in.
        try {
          if (user.failedLoginAttempts !== 0 || user.lockedUntil !== null) {
            await prisma.user.update({
              where: { id: user.id },
              data: { failedLoginAttempts: 0, lockedUntil: null },
            });
          }
        } catch (e) {
          // A reset failure must not block a valid sign-in.
          console.error("lockout counter reset failed:", e);
        }
        clearAttempts(rateKey);

        await logAudit({
          action: AuditAction.LOGIN_SUCCESS,
          actorId: user.id,
          actorEmail: user.email,
          ip: auditIp,
        });

        // The returned object becomes `user` in the jwt callback. The password
        // hash is deliberately excluded. `tokenVersion` is carried so the jwt
        // callback can stamp it onto the token for force-logout-all.
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          tokenVersion: user.tokenVersion,
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
      // Initial sign-in: persist id + role + tokenVersion from the authorize()
      // result. The stamped tokenVersion is the force-logout baseline.
      if (user) {
        token.sub = user.id;
        token.id = user.id;
        token.role = user.role;
        token.tokenVersion = user.tokenVersion;
      }

      // Per-request liveness re-check. token.sub is the user id. The same single
      // query also fetches tokenVersion for the force-logout check (no extra DB
      // round-trip).
      if (token.sub) {
        const fresh = await prisma.user.findUnique({
          where: { id: token.sub },
          select: { isActive: true, role: true, tokenVersion: true },
        });
        if (!fresh || !fresh.isActive) {
          // Invalidate the token: drop identity so authorized()/requireUser fail.
          delete token.sub;
          delete token.id;
          delete token.role;
          delete token.tokenVersion;
          return token;
        }
        // Force-logout-all: if an admin bumped the user's tokenVersion, this
        // token's stamped version is now stale → invalidate it (same path as an
        // inactive user) so the next request is unauthenticated.
        if (fresh.tokenVersion !== token.tokenVersion) {
          delete token.sub;
          delete token.id;
          delete token.role;
          delete token.tokenVersion;
          return token;
        }
        // Keep the role fresh too (e.g. an admin demotion takes effect promptly).
        token.role = fresh.role;
      }

      return token;
    },
  },
  /**
   * Auth.js events (auth Phase 3). Best-effort LOGOUT audit on sign-out; the
   * token (when present) carries the actor id/role. Never throws (logAudit is
   * best-effort).
   */
  events: {
    async signOut(message) {
      // `message` is a union: { session } for DB sessions, { token } for JWT. We
      // use JWT, so read the actor from the token when available.
      const token =
        "token" in message && message.token ? message.token : null;
      const actorId =
        token && typeof token.sub === "string" ? token.sub : null;
      const actorEmail =
        token && typeof token.email === "string" ? token.email : null;
      await logAudit({
        action: AuditAction.LOGOUT,
        actorId,
        actorEmail,
      });
    },
  },
});

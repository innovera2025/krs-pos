// NODE-ONLY. Shared constant-time bearer-secret check for the KRS machine-to-machine
// trigger endpoints (auto-sync / dispatch / rt-poll). Extracted so the realtime poller
// (krs-realtime-inbound P1) reuses the SAME hardened comparison the auto-sync route
// already ships, rather than a 3rd hand-rolled copy. Imported only by Node-runtime route
// code.
//
// ⚠️ SECURITY — these endpoints are the codebase's machine-auth paths; the bearer secret
// IS the authentication (there is no user session in a cron context). Hardening:
//   - The provided token is compared to the configured secret in CONSTANT TIME
//     (crypto.timingSafeEqual) to deny a timing oracle on the secret.
//   - A length mismatch short-circuits to false WITHOUT calling timingSafeEqual (which
//     throws on unequal-length buffers); the length is not the secret (secrets are min 32
//     chars).
//   - The token / secret are NEVER logged, echoed, or returned by this helper or its
//     callers. All auth failures collapse to a single generic 401 at the call site (no
//     "missing header" vs "wrong secret" distinction an attacker could probe).

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time bearer-secret check. Returns true ONLY when `authHeader` is
 * `Bearer <token>` and `<token>` equals `secret`.
 *
 * - Returns false when the header is absent / malformed / not `Bearer ` / empty token.
 * - A length mismatch short-circuits to false before timingSafeEqual.
 * - When lengths match, timingSafeEqual does a constant-time compare so the caller leaks
 *   no timing signal about how many leading bytes were correct.
 */
export function bearerMatches(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const token = authHeader.slice(prefix.length);
  if (token.length === 0) return false;

  const tokenBuf = Buffer.from(token, "utf8");
  const secretBuf = Buffer.from(secret, "utf8");
  // Unequal lengths can never be equal; bail before timingSafeEqual (which throws on a
  // length mismatch). The length is not secret (the secret is min 32 chars).
  if (tokenBuf.length !== secretBuf.length) return false;
  return timingSafeEqual(tokenBuf, secretBuf);
}

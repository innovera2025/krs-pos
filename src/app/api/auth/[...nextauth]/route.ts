import { handlers } from "@/auth";

/**
 * Auth.js v5 catch-all route handler (production-readiness Phase 1).
 *
 * Exposes the sign-in / callback / session / CSRF / sign-out endpoints under
 * /api/auth/*. The Credentials sign-in POST is what the wired /login form calls
 * via `signIn("credentials", ...)`. Runs in the Node runtime (Prisma + bcrypt).
 */
export const { GET, POST } = handlers;

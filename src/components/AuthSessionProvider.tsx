"use client";

import { SessionProvider } from "next-auth/react";

/**
 * Thin client wrapper around Auth.js's <SessionProvider> (production-readiness
 * Phase 1) so the root layout can stay a Server Component while still providing
 * the session context that `useSession()` (and the session-backed RoleProvider)
 * read on the client.
 */
export function AuthSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SessionProvider>{children}</SessionProvider>;
}

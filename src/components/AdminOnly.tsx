"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useRole } from "@/components/RoleProvider";

/**
 * ⚠️ CLIENT-ONLY ADMIN GUARD — NOT SECURITY.
 *
 * Wraps an admin-only screen (/products, /users, and ready for /data, /docs):
 * if the demo role is "seller" it redirects to /pos and renders nothing.
 *
 * This is purely a client-side UX redirect and is fully bypassable (a seller can
 * still load the route by URL; the server returns the page either way). It is NOT
 * an authorization boundary.
 * TODO(production-readiness): real auth/session + server-side RBAC + route
 * middleware that rejects unauthorized requests before the page renders.
 */
export function AdminOnly({ children }: { children: React.ReactNode }) {
  // Hooks stay unconditional (called every render) regardless of branch below.
  const { role, hydrated } = useRole();
  const router = useRouter();
  const allowed = role === "admin";

  useEffect(() => {
    // Only redirect once the real role is known. Redirecting on the pre-hydration
    // default would be wrong, and rendering before hydration would let a seller's
    // admin screen mount (and fire its mount-effect fetch) for one frame.
    if (hydrated && !allowed) router.replace("/pos");
  }, [hydrated, allowed, router]);

  // Neutral placeholder until hydration: server + first client render both show
  // null → no hydration mismatch, and no admin screen/fetch flashes for a seller.
  if (!hydrated) return null;
  if (!allowed) return null;
  return <>{children}</>;
}

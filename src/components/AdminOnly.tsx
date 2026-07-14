"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useRole } from "@/components/RoleProvider";

/**
 * CLIENT ADMIN GUARD — UX layer over the real server boundary.
 *
 * Wraps an admin-only screen (/products, /users, /data):
 * if the session-derived role is "seller" it redirects to /pos and renders
 * nothing.
 *
 * This is a client-side UX redirect for a clean experience. The ACTUAL
 * authorization boundary is server-side: middleware (`authorized`) already
 * bounces a seller off an admin route before this mounts, and the admin APIs are
 * guarded by `requireAdmin`. A seller can no longer reach admin data by URL or by
 * tampering with the client role.
 *
 * `strict` (promotions program, decision D2): when set, the screen is ADMIN-ONLY
 * in the strict sense — a MANAGER (which normally maps to the admin AppRole) is
 * ALSO bounced. Used by /promotions, which the strict-ADMIN middleware gate
 * already blocks server-side; this keeps the client UX in lock-step.
 */
export function AdminOnly({
  children,
  strict = false,
}: {
  children: React.ReactNode;
  strict?: boolean;
}) {
  // Hooks stay unconditional (called every render) regardless of branch below.
  const { role, isStrictAdmin, hydrated } = useRole();
  const router = useRouter();
  const allowed = strict ? isStrictAdmin : role === "admin";

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

import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/authRole";

/**
 * Per-route-handler authorization helpers (production-readiness Phase 1).
 *
 * ⚠️ This is the REAL authorization boundary (defense-in-depth). Middleware is a
 * UX redirect only; every protected API MUST call one of these in its handler so
 * an unauthenticated/unauthorized request is rejected even if middleware is
 * bypassed.
 *
 * Each helper returns EITHER a `{ session }` success object OR a `{ response }`
 * carrying a ready-to-return NextResponse (401/403). Callers do:
 *
 *   const gate = await requireAdmin();
 *   if ("response" in gate) return gate.response;
 *   const { session } = gate;  // session.user.id / session.user.role available
 *
 * Branch/Warehouse program (Phase 3): the returned `session.user` ALSO carries the
 * caller's `warehouseCode` (KRS WarehouseCode, or null when unassigned) and the
 * DERIVED `branchCode` (from the Warehouse master, or null) — stamped onto the JWT
 * in src/auth.ts and copied onto the session in src/auth.config.ts. The returned
 * shape is unchanged (still `{ session }`); these are additive fields on
 * `session.user` that Phase 4 checkout reads as `gate.session.user.warehouseCode`
 * / `gate.session.user.branchCode`.
 *
 * The jwt callback already invalidates tokens for deactivated/removed users, so a
 * non-null session here implies a live, active user.
 */

type AuthOk = { session: Session };
type AuthFail = { response: NextResponse };
type AuthResult = AuthOk | AuthFail;

/** Require any authenticated (live, active) user. 401 otherwise. */
export async function requireUser(): Promise<AuthResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      response: NextResponse.json(
        { error: "กรุณาเข้าสู่ระบบ", code: "UNAUTHENTICATED" },
        { status: 401 }
      ),
    };
  }
  return { session };
}

/**
 * Require an authenticated user whose mapped role is admin (ADMIN or MANAGER —
 * MANAGER is treated as admin per the approved decision). 401 if not signed in,
 * 403 if signed in but not an admin.
 */
export async function requireAdmin(): Promise<AuthResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      response: NextResponse.json(
        { error: "กรุณาเข้าสู่ระบบ", code: "UNAUTHENTICATED" },
        { status: 401 }
      ),
    };
  }
  if (!isAdminRole(session.user.role)) {
    return {
      response: NextResponse.json(
        { error: "ต้องเป็นผู้ดูแลระบบ", code: "FORBIDDEN" },
        { status: 403 }
      ),
    };
  }
  return { session };
}

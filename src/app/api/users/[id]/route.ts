import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma, AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";

// AUTH (production-readiness Phase 1 + auth Phase 3): every variant below
// requires an authenticated ADMIN (or MANAGER, treated as admin). The
// per-handler `requireAdmin` check is the real authorization boundary
// (defense-in-depth).

const USER_PUBLIC_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  branchId: true,
  createdAt: true,
  // Lockout state (auth Phase 3) for the Users UI. Password hash NEVER selected.
  lockedUntil: true,
  failedLoginAttempts: true,
} as const;

/** Minimum password length accepted on an admin reset (auth Phase 3). */
const MIN_PASSWORD_LEN = 8;
/**
 * Maximum password length (production-readiness Phase 1, theme #3). bcrypt truncates
 * at 72 BYTES — a longer reset password would authenticate using only its first 72
 * chars (silent mis-feature) and waste CPU at BCRYPT_COST=12. Reject at the boundary.
 */
const MAX_PASSWORD_LEN = 72;
/** bcrypt cost factor — matches the seed/auth cost (12). */
const BCRYPT_COST = 12;

type PatchUserBody = {
  isActive?: unknown;
  password?: unknown;
  action?: unknown;
};

/**
 * PATCH /api/users/[id] — multi-variant admin user mutation (auth Phase 3).
 * Exactly one variant is honored per request, selected by the body shape:
 *
 *   { isActive: boolean }      — activate / deactivate (no destructive delete).
 *   { password: string }       — admin reset of the user's password (min 8).
 *   { action: "forceLogout" }  — bump tokenVersion → revoke all the user's JWTs.
 *   { action: "unlock" }       — clear failedLoginAttempts + lockedUntil.
 *
 * An unrecognized shape → 400 BAD_VARIANT. The password hash is never selected
 * or returned by any branch.
 */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;
  const { session } = gate;

  const { id } = params;
  if (typeof id !== "string" || id.length === 0) {
    return NextResponse.json(
      { error: "Missing user id", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  let body: PatchUserBody;
  try {
    body = (await req.json()) as PatchUserBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const auditCtx = {
    actorId: session.user.id,
    actorEmail: session.user.email ?? null,
    targetType: "User" as const,
    targetId: id,
  };

  // --- variant: activate / deactivate ---
  if (typeof body.isActive === "boolean") {
    try {
      const user = await prisma.user.update({
        where: { id },
        // Reactivation also CLEARS any stale lockout state so a re-enabled user
        // is never greeted by a lock left over from before deactivation. The
        // deactivate path (isActive:false) leaves the counter/lock untouched.
        data: {
          isActive: body.isActive,
          ...(body.isActive
            ? { failedLoginAttempts: 0, lockedUntil: null }
            : {}),
        },
        select: USER_PUBLIC_SELECT,
      });
      await logAudit({
        ...auditCtx,
        action: body.isActive
          ? AuditAction.USER_ACTIVATED
          : AuditAction.USER_DEACTIVATED,
        ip: await ipFromHeaders(),
      });
      return NextResponse.json(user);
    } catch (err) {
      return handlePatchError(err);
    }
  }

  // --- variant: admin password reset ---
  if (typeof body.password === "string") {
    if (body.password.length < MIN_PASSWORD_LEN) {
      return NextResponse.json(
        { error: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร", code: "BAD_PASSWORD" },
        { status: 400 }
      );
    }
    // Max-length cap (theme #3): bcrypt truncates at 72 bytes — reject longer.
    if (body.password.length > MAX_PASSWORD_LEN) {
      return NextResponse.json(
        {
          error: "รหัสผ่านยาวเกินไป (สูงสุด 72 ตัวอักษร)",
          code: "BAD_PASSWORD",
        },
        { status: 400 }
      );
    }
    let passwordHash: string;
    try {
      passwordHash = await bcrypt.hash(body.password, BCRYPT_COST);
    } catch (err) {
      console.error("PATCH /api/users/[id] password hash failed:", err);
      return NextResponse.json(
        { error: "Could not update user", code: "INTERNAL" },
        { status: 500 }
      );
    }
    try {
      const user = await prisma.user.update({
        where: { id },
        data: { password: passwordHash },
        select: USER_PUBLIC_SELECT,
      });
      await logAudit({
        ...auditCtx,
        action: AuditAction.PASSWORD_CHANGED,
        ip: await ipFromHeaders(),
      });
      return NextResponse.json(user);
    } catch (err) {
      return handlePatchError(err);
    }
  }

  // --- variant: force-logout-all (bump tokenVersion) ---
  if (body.action === "forceLogout") {
    try {
      const user = await prisma.user.update({
        where: { id },
        data: { tokenVersion: { increment: 1 } },
        select: USER_PUBLIC_SELECT,
      });
      await logAudit({
        ...auditCtx,
        action: AuditAction.SESSION_REVOKED,
        ip: await ipFromHeaders(),
      });
      return NextResponse.json(user);
    } catch (err) {
      return handlePatchError(err);
    }
  }

  // --- variant: unlock (clear lockout state) ---
  if (body.action === "unlock") {
    try {
      const user = await prisma.user.update({
        where: { id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
        select: USER_PUBLIC_SELECT,
      });
      await logAudit({
        ...auditCtx,
        action: AuditAction.ACCOUNT_UNLOCKED,
        ip: await ipFromHeaders(),
      });
      return NextResponse.json(user);
    } catch (err) {
      return handlePatchError(err);
    }
  }

  // No recognized variant.
  return NextResponse.json(
    {
      error:
        "body must be one of {isActive}, {password}, {action:'forceLogout'}, {action:'unlock'}",
      code: "BAD_VARIANT",
    },
    { status: 400 }
  );
}

/** Map a Prisma error from any PATCH variant to a typed JSON response. */
function handlePatchError(err: unknown): NextResponse {
  // Record-not-found → typed 404.
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2025"
  ) {
    return NextResponse.json(
      { error: "User not found", code: "NOT_FOUND" },
      { status: 404 }
    );
  }
  console.error("PATCH /api/users/[id] failed:", err);
  return NextResponse.json(
    { error: "Could not update user", code: "INTERNAL" },
    { status: 500 }
  );
}

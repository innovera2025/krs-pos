import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma, AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

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
  // Branch/Warehouse program (Phase 2): the user's assigned KRS WarehouseCode
  // (null = unassigned). Branch is DERIVED from the Warehouse master for display.
  warehouseCode: true,
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
/**
 * Maximum display-name length on an edit. Mirrors POST /api/users (which caps at
 * 200) so the create and rename paths agree on the same bound.
 */
const MAX_NAME_LEN = 200;

type PatchUserBody = {
  isActive?: unknown;
  password?: unknown;
  action?: unknown;
  // Branch/Warehouse program (Phase 2): assign (string) or clear (null) the user's
  // KRS WarehouseCode.
  warehouseCode?: unknown;
  // Edit-display-name variant: the user's new `name` (trimmed/validated below).
  name?: unknown;
};

/**
 * PATCH /api/users/[id] — multi-variant admin user mutation (auth Phase 3).
 * Exactly one variant is honored per request, selected by the body shape:
 *
 *   { isActive: boolean }      — activate / deactivate (no destructive delete).
 *   { password: string }       — admin reset of the user's password (min 8).
 *   { action: "forceLogout" }  — bump tokenVersion → revoke all the user's JWTs.
 *   { action: "unlock" }       — clear failedLoginAttempts + lockedUntil.
 *   { warehouseCode: string | null }
 *                              — assign (validated against the Warehouse master)
 *                                or clear (null) the user's KRS WarehouseCode
 *                                (Branch/Warehouse program, Phase 2).
 *   { name: string }           — rename the user's display name (trimmed, non-empty,
 *                                max 200). Display-name only — never touches
 *                                email/role/auth/stock.
 *
 * An unrecognized shape → 400 BAD_VARIANT. The password hash is never selected
 * or returned by any branch.
 */
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  return runWithRequestId(req, async () => {
  // Start time for the success request-log line (D3 — mutation route).
  const startedAt = Date.now();
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

  // Success request-log line (D3 — mutation route). One line per successful PATCH
  // variant; no PII (no email/name/password) — variant + status + duration only.
  // requestId/method/path arrive via the logger mixin + these fields.
  const logSuccess = (variant: string) =>
    logger.info(
      { method: "PATCH", path: "/api/users/[id]", status: 200, variant, durationMs: Date.now() - startedAt },
      "user updated"
    );

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
      logSuccess(body.isActive ? "activate" : "deactivate");
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
      logger.error({ err }, "PATCH /api/users/[id] password hash failed");
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
      logSuccess("password-reset");
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
      logSuccess("forceLogout");
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
      logSuccess("unlock");
      return NextResponse.json(user);
    } catch (err) {
      return handlePatchError(err);
    }
  }

  // --- variant: assign / clear warehouse (Branch/Warehouse program, Phase 2) ---
  // Body { warehouseCode: string | null }. A non-null value MUST exist in the
  // Warehouse master (never trust the client); null (or an empty/whitespace string)
  // clears the assignment. Inert downstream — nothing in checkout/auth/session/stock
  // reads it yet (Phase 3+). branchCode is DERIVED from the Warehouse table for
  // display and is never stored here.
  if (
    "warehouseCode" in body &&
    (typeof body.warehouseCode === "string" || body.warehouseCode === null)
  ) {
    const raw =
      typeof body.warehouseCode === "string" ? body.warehouseCode.trim() : "";
    const warehouseCode = raw.length > 0 ? raw : null;
    if (warehouseCode !== null) {
      const wh = await prisma.warehouse.findUnique({
        where: { warehouseCode },
        select: { warehouseCode: true },
      });
      if (!wh) {
        return NextResponse.json(
          { error: "ไม่พบคลังที่เลือก", code: "UNKNOWN_WAREHOUSE" },
          { status: 400 }
        );
      }
    }
    try {
      const user = await prisma.user.update({
        where: { id },
        data: { warehouseCode },
        select: USER_PUBLIC_SELECT,
      });
      logSuccess("warehouse");
      return NextResponse.json(user);
    } catch (err) {
      return handlePatchError(err);
    }
  }

  // --- variant: edit display name ---
  // Body { name: string }. Renames the user's display `name` only. Trimmed +
  // non-empty + bounded (mirrors the POST /api/users create rule) — NEVER trust the
  // raw client value beyond the validated, trimmed name. Does not touch
  // email/role/auth/session/stock.
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (name.length === 0) {
      return NextResponse.json(
        { error: "กรุณากรอกชื่อผู้ใช้", code: "NAME_REQUIRED" },
        { status: 400 }
      );
    }
    if (name.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: "ชื่อผู้ใช้ยาวเกินไป", code: "NAME_TOO_LONG" },
        { status: 400 }
      );
    }
    try {
      const user = await prisma.user.update({
        where: { id },
        data: { name },
        select: USER_PUBLIC_SELECT,
      });
      logSuccess("name");
      return NextResponse.json(user);
    } catch (err) {
      return handlePatchError(err);
    }
  }

  // No recognized variant.
  return NextResponse.json(
    {
      error:
        "body must be one of {isActive}, {password}, {action:'forceLogout'}, {action:'unlock'}, {warehouseCode}, {name}",
      code: "BAD_VARIANT",
    },
    { status: 400 }
  );
  });
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
  logger.error({ err }, "PATCH /api/users/[id] failed");
  return NextResponse.json(
    { error: "Could not update user", code: "INTERNAL" },
    { status: 500 }
  );
}

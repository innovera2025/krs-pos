import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma, Role, AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/** Minimum password length accepted at create/reset (auth Phase 3). */
const MIN_PASSWORD_LEN = 8;
/**
 * Maximum password length (production-readiness Phase 1, theme #3). bcrypt silently
 * truncates input at 72 BYTES — a password longer than this would authenticate using
 * only its first 72 chars (a silent security mis-feature) and costs extra CPU at
 * BCRYPT_COST=12. Reject (→ 400 BAD_PASSWORD) at the boundary instead.
 */
const MAX_PASSWORD_LEN = 72;
/**
 * Maximum username length. The login identifier is stored in the `User.email`
 * column (kept for the @unique constraint — no migration), but the value is now a
 * free-form username, not required to be an email. 254 (RFC 5321's max email
 * length) is reused as a generous upper bound.
 */
const MAX_EMAIL_LEN = 254;
/** bcrypt cost factor — matches the seed/auth cost (12). */
const BCRYPT_COST = 12;

// AUTH (production-readiness Phase 1): these routes require an authenticated
// ADMIN (or MANAGER, treated as admin). The per-handler `requireAdmin` check is
// the real authorization boundary (defense-in-depth) — a non-admin gets 403, an
// anonymous caller 401, even if middleware is bypassed.

// Fields safe to return to the client. The `password` column is NEVER selected
// or returned by any handler here.
const USER_PUBLIC_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  branchId: true,
  // Branch/Warehouse program (Phase 2): the user's assigned KRS WarehouseCode
  // (null = unassigned). The branch is DERIVED from the Warehouse master for
  // display — branchCode is never stored here.
  warehouseCode: true,
  createdAt: true,
  // Lockout state (auth Phase 3) so the Users UI can show a "Locked" badge and a
  // contextual Unlock action. The password hash is NEVER selected here.
  lockedUntil: true,
  failedLoginAttempts: true,
} as const;

// GET /api/users — list users (password never selected/returned). Admin-only.
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    try {
      const users = await prisma.user.findMany({
        select: USER_PUBLIC_SELECT,
        orderBy: { createdAt: "desc" },
      });
      return NextResponse.json(users);
    } catch (err) {
      logger.error({ err }, "GET /api/users failed");
      return NextResponse.json(
        { error: "Could not list users", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

type CreateUserBody = {
  name?: unknown;
  email?: unknown;
  role?: unknown;
  password?: unknown;
  // Branch/Warehouse program (Phase 2): optional KRS WarehouseCode assignment.
  warehouseCode?: unknown;
};

function isRole(v: unknown): v is Role {
  return typeof v === "string" && (Object.values(Role) as string[]).includes(v);
}

// POST /api/users — create a user with a real (hashed) password. Admin-only.
// Set-password Option 1: the admin sets the user's initial password at create
// time (auth Phase 3) — replaces the old non-functional placeholder password.
// Returns the created user WITHOUT the password hash.
export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;

  let body: CreateUserBody;
  try {
    body = (await req.json()) as CreateUserBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // --- input boundary validation ---
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0) {
    return NextResponse.json(
      { error: "กรุณากรอกชื่อผู้ใช้", code: "NAME_REQUIRED" },
      { status: 400 }
    );
  }
  if (name.length > 200) {
    return NextResponse.json(
      { error: "ชื่อผู้ใช้ยาวเกินไป", code: "NAME_TOO_LONG" },
      { status: 400 }
    );
  }

  // Username (stored in the `email` column — see note above). Normalize to
  // lowercase so create + sign-in agree: authorize() looks up with
  // `.trim().toLowerCase()`, so the stored value MUST also be lowercased here or
  // a username with any uppercase would never match at login. Validate as
  // non-empty within the generous length bound; format is intentionally free-form.
  const email =
    typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (email.length === 0 || email.length > MAX_EMAIL_LEN) {
    return NextResponse.json(
      { error: "กรุณากรอกชื่อผู้ใช้", code: "BAD_EMAIL" },
      { status: 422 }
    );
  }

  if (!isRole(body.role)) {
    return NextResponse.json(
      { error: "บทบาทไม่ถูกต้อง", code: "BAD_ROLE" },
      { status: 422 }
    );
  }
  const role: Role = body.role;

  // Set-password Option 1: the admin sets the user's initial password now. The
  // raw password is validated, hashed (never stored or logged in the clear), and
  // the hash is never selected back out.
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < MIN_PASSWORD_LEN) {
    return NextResponse.json(
      {
        error: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร",
        code: "BAD_PASSWORD",
      },
      { status: 400 }
    );
  }
  // Max-length cap (theme #3): bcrypt truncates at 72 bytes — reject longer to avoid
  // the silent "only the first 72 chars matter" mis-feature + excess hashing CPU.
  if (password.length > MAX_PASSWORD_LEN) {
    return NextResponse.json(
      {
        error: "รหัสผ่านยาวเกินไป (สูงสุด 72 ตัวอักษร)",
        code: "BAD_PASSWORD",
      },
      { status: 400 }
    );
  }

  // Branch/Warehouse program (Phase 2): optional warehouse assignment. Empty /
  // absent = unassigned (stored null). When provided, the value MUST exist in the
  // Warehouse master — NEVER trust the client. Validated here (before the bcrypt
  // hash) so an unknown code fails cheaply. branchCode is DERIVED from the
  // Warehouse table for display; it is never stored on the user.
  const warehouseCodeRaw =
    typeof body.warehouseCode === "string" ? body.warehouseCode.trim() : "";
  const warehouseCode = warehouseCodeRaw.length > 0 ? warehouseCodeRaw : null;
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

  let passwordHash: string;
  try {
    passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  } catch (err) {
    logger.error({ err }, "POST /api/users password hash failed");
    return NextResponse.json(
      { error: "Could not create user", code: "INTERNAL" },
      { status: 500 }
    );
  }

  try {
    const user = await prisma.user.create({
      data: {
        name,
        email,
        role,
        isActive: true,
        password: passwordHash,
        // Phase 2: validated above against the Warehouse master (null = unassigned).
        warehouseCode,
      },
      select: USER_PUBLIC_SELECT,
    });

    // Best-effort audit AFTER the create commits (never blocks the response,
    // never logs the password).
    await logAudit({
      action: AuditAction.USER_CREATED,
      actorId: gate.session.user.id,
      actorEmail: gate.session.user.email ?? null,
      ip: await ipFromHeaders(),
      targetType: "User",
      targetId: user.id,
      detail: JSON.stringify({ email: user.email, role: user.role }),
    });

    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    // Unique-constraint (duplicate email) → typed 409.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "ชื่อผู้ใช้นี้ถูกใช้งานแล้ว", code: "EMAIL_TAKEN" },
        { status: 409 }
      );
    }
    logger.error({ err }, "POST /api/users failed");
    return NextResponse.json(
      { error: "Could not create user", code: "INTERNAL" },
      { status: 500 }
    );
  }
  });
}

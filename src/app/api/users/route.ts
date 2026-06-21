import { NextResponse } from "next/server";
import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

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
  createdAt: true,
} as const;

// GET /api/users — list users (password never selected/returned). Admin-only.
export async function GET() {
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;

  try {
    const users = await prisma.user.findMany({
      select: USER_PUBLIC_SELECT,
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(users);
  } catch (err) {
    console.error("GET /api/users failed:", err);
    return NextResponse.json(
      { error: "Could not list users", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

type CreateUserBody = {
  name?: unknown;
  email?: unknown;
  role?: unknown;
};

// Email shape check — same loose pattern as the Simple POS add-user form.
// (Strict RFC validation is owned by the production-readiness program.)
const EMAIL_RE = /.+@.+\..+/;

function isRole(v: unknown): v is Role {
  return typeof v === "string" && (Object.values(Role) as string[]).includes(v);
}

/**
 * Generate a non-functional placeholder password for a demo user.
 *
 * There is no auth/credential flow yet, but the schema requires a non-null
 * password. This value is intentionally NOT a usable credential and is never
 * returned to the client.
 *
 * TODO(production-readiness): hash a real password + force a set-on-first-login
 * flow. Never store a plaintext credential.
 */
function placeholderPassword(): string {
  const rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `!set-on-first-login-${rand}`;
}

// POST /api/users — create a user (returns the created user WITHOUT password).
// Admin-only.
export async function POST(req: Request) {
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

  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "อีเมลไม่ถูกต้อง", code: "BAD_EMAIL" },
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

  try {
    const user = await prisma.user.create({
      data: {
        name,
        email,
        role,
        isActive: true,
        // Placeholder — not a real credential (see placeholderPassword).
        password: placeholderPassword(),
      },
      select: USER_PUBLIC_SELECT,
    });
    return NextResponse.json(user, { status: 201 });
  } catch (err) {
    // Unique-constraint (duplicate email) → typed 409.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "อีเมลนี้ถูกใช้งานแล้ว", code: "EMAIL_TAKEN" },
        { status: 409 }
      );
    }
    console.error("POST /api/users failed:", err);
    return NextResponse.json(
      { error: "Could not create user", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

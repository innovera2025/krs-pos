import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// ⚠️ RBAC / auth is NOT enforced here. There is no session yet, so any caller
// can toggle a user's active state. CLIENT DEMO surface, not secured.
// TODO(production-readiness): real auth/session + server-side RBAC + route
// middleware (only an authenticated ADMIN may mutate users).

const USER_PUBLIC_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  isActive: true,
  branchId: true,
  createdAt: true,
} as const;

type PatchUserBody = { isActive?: unknown };

// PATCH /api/users/[id] — activate/deactivate a user (no destructive delete).
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
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

  if (typeof body.isActive !== "boolean") {
    return NextResponse.json(
      { error: "isActive must be a boolean", code: "BAD_ACTIVE" },
      { status: 400 }
    );
  }

  try {
    const user = await prisma.user.update({
      where: { id },
      data: { isActive: body.isActive },
      select: USER_PUBLIC_SELECT,
    });
    return NextResponse.json(user);
  } catch (err) {
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
}

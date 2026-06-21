import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";

// AUTH (production-readiness Phase 1): activating/deactivating a user requires an
// authenticated ADMIN (or MANAGER, treated as admin). The per-handler
// `requireAdmin` check is the real authorization boundary (defense-in-depth).

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
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;

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

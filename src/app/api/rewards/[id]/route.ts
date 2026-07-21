import { NextResponse } from "next/server";
import { Prisma, AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser, requireAdmin } from "@/lib/auth";
import { RewardPatchBodySchema } from "@/lib/schemas/reward";
import { parseBody } from "@/lib/schemas/_shared";
import { serializeReward } from "@/lib/rewardSerialize";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * Single-reward read + update (loyalty program, Phase 3A — CONFIG side only).
 *
 * GET is `requireUser` (any signed-in role may read a reward). PATCH is `requireAdmin`
 * (rewards are money-adjacent config — the write boundary is ADMIN+MANAGER), audited.
 *
 * There is deliberately NO DELETE handler: the app DB role `krs_app` has no DELETE
 * privilege (the HeldBill / Promotion precedent), so "removing" a reward is a soft delete
 * — `PATCH { isActive: false }` — audited as REWARD_DEACTIVATED.
 */

/** The product projection the reward serializer needs (current name + price + active). */
const REWARD_PRODUCT_SELECT = {
  id: true,
  name: true,
  price: true,
  isActive: true,
} satisfies Prisma.ProductSelect;

// GET /api/rewards/[id] — read one reward (+ resolved product). Any signed-in user.
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    const { id } = params;
    if (typeof id !== "string" || id.length === 0) {
      return NextResponse.json(
        { error: "Missing reward id", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    try {
      const reward = await prisma.reward.findUnique({ where: { id } });
      if (!reward) {
        return NextResponse.json(
          { error: "ไม่พบของรางวัล", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      const product = await prisma.product.findUnique({
        where: { id: reward.productId },
        select: REWARD_PRODUCT_SELECT,
      });
      return NextResponse.json(serializeReward(reward, product));
    } catch (err) {
      logger.error({ err }, "GET /api/rewards/[id] failed");
      return NextResponse.json(
        { error: "ไม่สามารถโหลดของรางวัลได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

// PATCH /api/rewards/[id] — partial update / soft-delete toggle. ADMIN-only, audited.
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    const { id } = params;
    if (typeof id !== "string" || id.length === 0) {
      return NextResponse.json(
        { error: "Missing reward id", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    const parsed = parseBody(RewardPatchBodySchema, raw);
    if ("response" in parsed) return parsed.response;
    const { data } = parsed;

    // Load the existing row first — its current isActive governs the audit transition,
    // and its productId is the fallback snapshot when the patch doesn't change it.
    const existing = await prisma.reward.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "ไม่พบของรางวัล", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Re-validate a changed productId against the DB (must exist + be active), same as
    // create. An unchanged productId is not re-checked (a product may have been
    // deactivated after the reward was created — that is Phase 3B's concern, not an edit
    // blocker here).
    if (data.productId !== undefined && data.productId !== existing.productId) {
      const product = await prisma.product.findUnique({
        where: { id: data.productId },
        select: { id: true, isActive: true },
      });
      if (!product || !product.isActive) {
        return NextResponse.json(
          { error: "ไม่พบสินค้า หรือสินค้าถูกปิดการขาย", code: "UNKNOWN_PRODUCT" },
          { status: 422 }
        );
      }
    }

    // Assemble the partial update — only provided fields are set.
    const update: Prisma.RewardUpdateInput = {};
    if (data.name !== undefined) update.name = data.name;
    if (data.pointsCost !== undefined) update.pointsCost = data.pointsCost;
    if (data.productId !== undefined) update.productId = data.productId;
    if (data.isActive !== undefined) update.isActive = data.isActive;

    const changedFields = Object.keys(update);
    if (changedFields.length === 0) {
      return NextResponse.json(
        { error: "ไม่มีข้อมูลให้แก้ไข", code: "NO_FIELDS" },
        { status: 400 }
      );
    }

    // Audit action from the isActive transition (soft-delete toggle vs plain edit).
    let auditAction: AuditAction = AuditAction.REWARD_UPDATED;
    if (data.isActive !== undefined && data.isActive !== existing.isActive) {
      auditAction = data.isActive
        ? AuditAction.REWARD_ACTIVATED
        : AuditAction.REWARD_DEACTIVATED;
    }

    try {
      const updated = await prisma.reward.update({ where: { id }, data: update });

      // Resolve the (possibly newly-set) product for the response snapshot.
      const product = await prisma.product.findUnique({
        where: { id: updated.productId },
        select: REWARD_PRODUCT_SELECT,
      });

      // Best-effort audit AFTER commit — changed field NAMES only (no values).
      await logAudit({
        action: auditAction,
        actorId: gate.session.user.id,
        actorEmail: gate.session.user.email ?? null,
        ip: await ipFromHeaders(),
        targetType: "Reward",
        targetId: updated.id,
        detail: JSON.stringify({ fields: changedFields }),
      });

      return NextResponse.json(serializeReward(updated, product));
    } catch (err) {
      // Row vanished between load and update (defensive; no hard DELETE exists).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        return NextResponse.json(
          { error: "ไม่พบของรางวัล", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      logger.error({ err }, "PATCH /api/rewards/[id] failed");
      return NextResponse.json(
        { error: "ไม่สามารถแก้ไขของรางวัลได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

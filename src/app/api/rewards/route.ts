import { NextResponse } from "next/server";
import { Prisma, AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser, requireAdmin } from "@/lib/auth";
import { RewardPostBodySchema } from "@/lib/schemas/reward";
import { parseBody } from "@/lib/schemas/_shared";
import { serializeReward } from "@/lib/rewardSerialize";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * Reward catalog management + POS-feed API (loyalty program, Phase 3A — CONFIG side only).
 *
 * AUTH: rewards are money-adjacent config (they give a product away for points), so every
 * MUTATION is `requireAdmin` (ADMIN + MANAGER, mirroring the promotions D2-ADMIN stance).
 * READS are `requireUser` — the POS (Phase 3B) needs to read active rewards, and any
 * signed-in role may list them (the admin management tab is gated client-side + the write
 * routes reject a non-admin). Accountability is the audit log.
 *
 * GET dual-mode (mirrors `/api/promotions`):
 *  - default    → ALL rewards (admin list).
 *  - ?view=pos  → only `isActive` rewards (the POS redeem feed, Phase 3B).
 * Each reward resolves its `productId` (a plain-String snapshot, NO FK) to the product's
 * CURRENT name + 2dp price at read time; a soft-deleted product yields `product: null`.
 */

// This route branches on searchParams (?view=pos), so it is inherently dynamic.
export const dynamic = "force-dynamic";

/** The product projection the reward serializer needs (current name + price + active). */
const REWARD_PRODUCT_SELECT = {
  id: true,
  name: true,
  price: true,
  isActive: true,
} satisfies Prisma.ProductSelect;

/**
 * Resolve the product snapshot for a list of rewards in ONE query (no N+1): collect the
 * distinct productIds, fetch them, and build an id→product map for the serializer.
 */
async function productMapFor(
  rewards: { productId: string }[]
): Promise<Map<string, Prisma.ProductGetPayload<{ select: typeof REWARD_PRODUCT_SELECT }>>> {
  const ids = Array.from(new Set(rewards.map((r) => r.productId)));
  if (ids.length === 0) return new Map();
  const products = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: REWARD_PRODUCT_SELECT,
  });
  return new Map(products.map((p) => [p.id, p]));
}

// GET /api/rewards
//  - ?view=pos → requireUser; only active rewards (the POS redeem feed, Phase 3B).
//  - default   → requireUser; ALL rewards (admin management list).
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    const { searchParams } = new URL(req.url);
    const view = searchParams.get("view");
    const posView = view === "pos";

    try {
      const rewards = await prisma.reward.findMany({
        where: posView ? { isActive: true } : {},
        orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      });
      const products = await productMapFor(rewards);
      return NextResponse.json(
        rewards.map((r) => serializeReward(r, products.get(r.productId) ?? null))
      );
    } catch (err) {
      logger.error({ err }, "GET /api/rewards failed");
      return NextResponse.json(
        { error: "ไม่สามารถโหลดของรางวัลได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

// POST /api/rewards — create a reward. ADMIN-only (requireAdmin), audited.
export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    const parsed = parseBody(RewardPostBodySchema, raw);
    if ("response" in parsed) return parsed.response;
    const { data } = parsed;

    // Authoritative product check (never trust the client): the gift product must exist
    // AND be active. A missing / inactive id → 422 UNKNOWN_PRODUCT (you cannot give away
    // a discontinued product). The row is reused as the serializer snapshot below.
    const product = await prisma.product.findUnique({
      where: { id: data.productId },
      select: REWARD_PRODUCT_SELECT,
    });
    if (!product || !product.isActive) {
      return NextResponse.json(
        { error: "ไม่พบสินค้า หรือสินค้าถูกปิดการขาย", code: "UNKNOWN_PRODUCT" },
        { status: 422 }
      );
    }

    try {
      const created = await prisma.reward.create({
        data: {
          name: data.name,
          pointsCost: data.pointsCost,
          productId: data.productId,
          isActive: data.isActive,
        },
      });

      // Best-effort audit AFTER the create commits (never blocks/rolls back).
      await logAudit({
        action: AuditAction.REWARD_CREATED,
        actorId: gate.session.user.id,
        actorEmail: gate.session.user.email ?? null,
        ip: await ipFromHeaders(),
        targetType: "Reward",
        targetId: created.id,
        detail: JSON.stringify({
          name: created.name,
          pointsCost: created.pointsCost,
          productId: created.productId,
        }),
      });

      return NextResponse.json(serializeReward(created, product), { status: 201 });
    } catch (err) {
      logger.error({ err }, "POST /api/rewards failed");
      return NextResponse.json(
        { error: "ไม่สามารถสร้างของรางวัลได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

import { NextResponse } from "next/server";
import { Prisma, PromotionType, AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { PromotionCreateSchema } from "@/lib/schemas/promotion";
import { parseBody } from "@/lib/schemas/_shared";
import {
  serializeAdminPromotion,
  serializePosPromotion,
} from "@/lib/promotionSerialize";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * Promotion management + POS-feed API (promotions program, Phase 4).
 *
 * AUTH (owner decision 15-07-26 — SUPERSEDES the old D2 "ADMIN-only" gate): the
 * management surface is open to EVERY signed-in role (CASHIER/MANAGER/ADMIN) — list,
 * create, and edit all use `requireUser`. Accountability is the audit log: every
 * mutation records the actor via `logAudit` (unchanged). `GET ?view=pos` is also
 * `requireUser` (any authenticated user may read it to price the cart); it returns
 * only the client-safe `ActivePromotion` DTO of the CURRENTLY-EFFECTIVE promotions.
 *
 * Money is validated in baht by the Zod schema and converted to integer satang HERE
 * (`Math.round(v * 100)`) before it hits the satang Int columns. `percentOff` is stored
 * in the Decimal(5,2) column as a plain number.
 */

/** Baht → integer satang (schema already guarantees ≤ 2 decimals). */
function toSatang(baht: number): number {
  return Math.round(baht * 100);
}

/** True when `v` is a valid PromotionType enum value (for the ?type= filter). */
function isPromotionType(v: string): v is PromotionType {
  return (Object.values(PromotionType) as string[]).includes(v);
}

// GET /api/promotions
//  - ?view=pos  → requireUser; currently-effective promotions as ActivePromotion[].
//  - default    → requireUser; ALL rows (full admin DTO) + ?active= / ?type= filters.
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const { searchParams } = new URL(req.url);
    const view = searchParams.get("view");

    // --- POS feed: any authenticated user, effective promotions only ---
    if (view === "pos") {
      const gate = await requireUser();
      if ("response" in gate) return gate.response;

      try {
        // A promotion is effective iff isActive AND (startsAt is null OR <= now) AND
        // (endsAt is null OR > now) — the half-open [startsAt, endsAt) window the
        // schema documents. Clock-based filtering lives HERE (fetch boundary); the
        // engine that consumes ActivePromotion[] stays clock-free.
        const now = new Date();
        const rows = await prisma.promotion.findMany({
          where: {
            isActive: true,
            AND: [
              { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
              { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
            ],
          },
          orderBy: { createdAt: "desc" },
        });
        return NextResponse.json(rows.map(serializePosPromotion));
      } catch (err) {
        logger.error({ err }, "GET /api/promotions?view=pos failed");
        return NextResponse.json(
          { error: "ไม่สามารถโหลดโปรโมชันได้", code: "INTERNAL" },
          { status: 500 }
        );
      }
    }

    // --- Management view: any signed-in user, all rows + optional filters ---
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    // Optional ?active=true|false — an unknown value is a 400, not a silent ignore.
    const activeParam = searchParams.get("active");
    let activeFilter: boolean | undefined;
    if (activeParam !== null) {
      if (activeParam === "true") activeFilter = true;
      else if (activeParam === "false") activeFilter = false;
      else {
        return NextResponse.json(
          { error: "ค่า active ไม่ถูกต้อง", code: "BAD_ACTIVE" },
          { status: 400 }
        );
      }
    }

    // Optional ?type=<PromotionType> — validated at the boundary (400 BAD_TYPE).
    const typeParam = searchParams.get("type");
    let typeFilter: PromotionType | undefined;
    if (typeParam !== null) {
      if (!isPromotionType(typeParam)) {
        return NextResponse.json(
          { error: "ประเภทโปรโมชันไม่ถูกต้อง", code: "BAD_TYPE" },
          { status: 400 }
        );
      }
      typeFilter = typeParam;
    }

    try {
      const rows = await prisma.promotion.findMany({
        where: {
          ...(activeFilter !== undefined ? { isActive: activeFilter } : {}),
          ...(typeFilter ? { type: typeFilter } : {}),
        },
        orderBy: { createdAt: "desc" },
      });
      return NextResponse.json(rows.map(serializeAdminPromotion));
    } catch (err) {
      logger.error({ err }, "GET /api/promotions failed");
      return NextResponse.json(
        { error: "ไม่สามารถโหลดโปรโมชันได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

// POST /api/promotions — create a promotion. Any signed-in user (audited).
export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
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

    const parsed = parseBody(PromotionCreateSchema, raw);
    if ("response" in parsed) return parsed.response;
    const { data } = parsed;

    // --- Route-level coded guards AFTER a successful parse (repo convention) ---

    // Date-window ordering: only when BOTH bounds are present. `startsAt` must be
    // strictly before `endsAt` (endsAt is exclusive per the schema).
    const startsAt = data.startsAt ? new Date(data.startsAt) : null;
    const endsAt = data.endsAt ? new Date(data.endsAt) : null;
    if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
      return NextResponse.json(
        { error: "วันที่เริ่มต้องมาก่อนวันที่สิ้นสุด", code: "BAD_DATE_WINDOW" },
        { status: 400 }
      );
    }

    // Product-existence for the line-level types (1-3). Scoping INACTIVE products is
    // allowed (no isActive filter). Compare the distinct requested ids against the
    // rows that actually exist → 422 UNKNOWN_PRODUCT on any dangling id.
    if (data.type !== "BILL_THRESHOLD") {
      const uniqueIds = Array.from(new Set(data.productIds));
      const found = await prisma.product.findMany({
        where: { id: { in: uniqueIds } },
        select: { id: true },
      });
      if (found.length !== uniqueIds.length) {
        return NextResponse.json(
          { error: "พบสินค้าที่ไม่มีอยู่ในระบบ", code: "UNKNOWN_PRODUCT" },
          { status: 422 }
        );
      }
    }

    // --- Assemble the create payload (baht → satang here) ---
    const common = {
      name: data.name,
      code: data.code,
      type: data.type,
      // undefined → DB default (true). A provided boolean is honored.
      isActive: data.isActive,
      startsAt,
      endsAt,
    };

    let createData: Prisma.PromotionCreateInput;
    switch (data.type) {
      case "PRODUCT_DISCOUNT":
        createData = {
          ...common,
          productIds: Array.from(new Set(data.productIds)),
          percentOff: data.percentOff ?? null,
          amountOffSatang: data.amountOff != null ? toSatang(data.amountOff) : null,
        };
        break;
      case "FIXED_PRICE":
        createData = {
          ...common,
          productIds: Array.from(new Set(data.productIds)),
          fixedPriceSatang: toSatang(data.fixedPrice),
        };
        break;
      case "BUY_X_GET_Y":
        // Reward is EXACTLY ONE of getDiscountPercent (%/ฟรี) or getAmountOff (฿ off
        // per rewarded unit) — the Zod XOR guarantees it; store the counterpart null.
        createData = {
          ...common,
          productIds: Array.from(new Set(data.productIds)),
          buyQty: data.buyQty,
          getQty: data.getQty,
          getDiscountPercent: data.getDiscountPercent ?? null,
          getAmountOffSatang:
            data.getAmountOff != null ? toSatang(data.getAmountOff) : null,
        };
        break;
      case "BILL_THRESHOLD":
        createData = {
          ...common,
          minSubtotalSatang: toSatang(data.minSubtotal),
          percentOff: data.percentOff ?? null,
          amountOffSatang: data.amountOff != null ? toSatang(data.amountOff) : null,
        };
        break;
      default: {
        // Exhaustiveness guard: a new PromotionType must be handled explicitly.
        // Unreachable — the discriminated union has exactly these four members.
        const _exhaustive: never = data;
        throw new Error(`Unhandled promotion type: ${String(_exhaustive)}`);
      }
    }

    try {
      const created = await prisma.promotion.create({ data: createData });

      // Best-effort audit AFTER the create commits (never blocks/rolls back).
      await logAudit({
        action: AuditAction.PROMOTION_CREATED,
        actorId: gate.session.user.id,
        actorEmail: gate.session.user.email ?? null,
        ip: await ipFromHeaders(),
        targetType: "Promotion",
        targetId: created.id,
        detail: JSON.stringify({ name: created.name, type: created.type }),
      });

      return NextResponse.json(serializeAdminPromotion(created), { status: 201 });
    } catch (err) {
      // Unique-constraint on `code` → typed 409.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return NextResponse.json(
          { error: "รหัสโปรโมชันนี้ถูกใช้งานแล้ว", code: "CODE_TAKEN" },
          { status: 409 }
        );
      }
      logger.error({ err }, "POST /api/promotions failed");
      return NextResponse.json(
        { error: "ไม่สามารถสร้างโปรโมชันได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

import { NextResponse } from "next/server";
import { Prisma, PromotionType, AuditAction } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { PromotionPatchSchema } from "@/lib/schemas/promotion";
import { parseBody } from "@/lib/schemas/_shared";
import { serializeAdminPromotion } from "@/lib/promotionSerialize";
import { logAudit, ipFromHeaders } from "@/lib/auditLog";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * Single-promotion read + update (promotions program, Phase 4). Open to EVERY
 * signed-in role via `requireUser` (owner decision 15-07-26 — SUPERSEDES the old D2
 * "ADMIN-only" gate); each mutation is attributed to the actor via logAudit.
 *
 * There is deliberately NO DELETE handler: the app DB role `krs_app` has no DELETE
 * privilege (HeldBill precedent), so "removing" a promotion is a soft delete —
 * `PATCH { isActive: false }` — audited as PROMOTION_DEACTIVATED.
 *
 * The promotion `type` is IMMUTABLE (change type = deactivate old + create new); a
 * client-sent `type` is rejected with TYPE_IMMUTABLE. Because Zod strips unknown keys,
 * that check is done on the RAW body before parsing.
 */

/** Baht → integer satang (schema already guarantees ≤ 2 decimals). */
function toSatang(baht: number): number {
  return Math.round(baht * 100);
}

/** Every per-type value field the PATCH schema can carry. */
const ALL_VALUE_FIELDS = [
  "productIds",
  "percentOff",
  "amountOff",
  "fixedPrice",
  "buyQty",
  "getQty",
  "getDiscountPercent",
  "minSubtotal",
] as const;

/**
 * The value fields LEGAL for each promotion type. A PATCH that carries a value field
 * outside its row's type is rejected (BAD_FIELD_FOR_TYPE) — you cannot, e.g., set a
 * `fixedPrice` on a PRODUCT_DISCOUNT.
 */
const VALUE_FIELDS_BY_TYPE: Record<PromotionType, ReadonlySet<string>> = {
  PRODUCT_DISCOUNT: new Set(["productIds", "percentOff", "amountOff"]),
  FIXED_PRICE: new Set(["productIds", "fixedPrice"]),
  BUY_X_GET_Y: new Set([
    "productIds",
    "buyQty",
    "getQty",
    "getDiscountPercent",
  ]),
  BILL_THRESHOLD: new Set(["minSubtotal", "percentOff", "amountOff"]),
};

// GET /api/promotions/[id] — read one promotion (full admin DTO). Any signed-in user.
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
        { error: "Missing promotion id", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    try {
      const row = await prisma.promotion.findUnique({ where: { id } });
      if (!row) {
        return NextResponse.json(
          { error: "ไม่พบโปรโมชัน", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      return NextResponse.json(serializeAdminPromotion(row));
    } catch (err) {
      logger.error({ err }, "GET /api/promotions/[id] failed");
      return NextResponse.json(
        { error: "ไม่สามารถโหลดโปรโมชันได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

// PATCH /api/promotions/[id] — partial update / soft-delete toggle. Any signed-in user (audited).
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    const { id } = params;
    if (typeof id !== "string" || id.length === 0) {
      return NextResponse.json(
        { error: "Missing promotion id", code: "BAD_REQUEST" },
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

    // `type` is immutable. Zod would silently strip it, so detect it on the RAW body
    // and reject before parsing.
    if (
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      "type" in (raw as Record<string, unknown>)
    ) {
      return NextResponse.json(
        {
          error: "เปลี่ยนประเภทไม่ได้ ให้ปิดตัวเก่าและสร้างใหม่",
          code: "TYPE_IMMUTABLE",
        },
        { status: 400 }
      );
    }

    const parsed = parseBody(PromotionPatchSchema, raw);
    if ("response" in parsed) return parsed.response;
    const { data } = parsed;

    // Load the existing row first — its type governs which value fields are legal,
    // and its current values feed the merged date-window check.
    const existing = await prisma.promotion.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "ไม่พบโปรโมชัน", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    // Reject value fields that do not belong to the existing type.
    const allowed = VALUE_FIELDS_BY_TYPE[existing.type];
    for (const field of ALL_VALUE_FIELDS) {
      if (field in data && !allowed.has(field)) {
        return NextResponse.json(
          {
            error: "ฟิลด์นี้ใช้กับประเภทโปรโมชันนี้ไม่ได้",
            code: "BAD_FIELD_FOR_TYPE",
          },
          { status: 400 }
        );
      }
    }

    // Date-window ordering on the MERGED (existing ⊕ patch) window.
    const mergedStartsAt =
      "startsAt" in data
        ? data.startsAt
          ? new Date(data.startsAt)
          : null
        : existing.startsAt;
    const mergedEndsAt =
      "endsAt" in data
        ? data.endsAt
          ? new Date(data.endsAt)
          : null
        : existing.endsAt;
    if (
      mergedStartsAt &&
      mergedEndsAt &&
      mergedStartsAt.getTime() >= mergedEndsAt.getTime()
    ) {
      return NextResponse.json(
        { error: "วันที่เริ่มต้องมาก่อนวันที่สิ้นสุด", code: "BAD_DATE_WINDOW" },
        { status: 400 }
      );
    }

    // Re-validate a provided productIds set against the DB (inactive allowed).
    if ("productIds" in data && data.productIds) {
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

    // Assemble the partial update (baht → satang here). Only provided fields are set.
    const update: Prisma.PromotionUpdateInput = {};
    if (data.name !== undefined) update.name = data.name;
    // code Variant A: key present ⇒ update; explicit null OR trimmed-empty ⇒ clear.
    if ("code" in data) {
      update.code = data.code && data.code.length > 0 ? data.code : null;
    }
    if (data.isActive !== undefined) update.isActive = data.isActive;
    if ("startsAt" in data) update.startsAt = mergedStartsAt;
    if ("endsAt" in data) update.endsAt = mergedEndsAt;
    if ("productIds" in data && data.productIds) {
      update.productIds = Array.from(new Set(data.productIds));
    }
    if (data.percentOff !== undefined) update.percentOff = data.percentOff;
    if (data.amountOff !== undefined) {
      update.amountOffSatang = toSatang(data.amountOff);
    }
    if (data.fixedPrice !== undefined) {
      update.fixedPriceSatang = toSatang(data.fixedPrice);
    }
    if (data.buyQty !== undefined) update.buyQty = data.buyQty;
    if (data.getQty !== undefined) update.getQty = data.getQty;
    if (data.getDiscountPercent !== undefined) {
      update.getDiscountPercent = data.getDiscountPercent;
    }
    if (data.minSubtotal !== undefined) {
      update.minSubtotalSatang = toSatang(data.minSubtotal);
    }

    const changedFields = Object.keys(update);
    if (changedFields.length === 0) {
      return NextResponse.json(
        { error: "ไม่มีข้อมูลให้แก้ไข", code: "NO_FIELDS" },
        { status: 400 }
      );
    }

    // Audit action from the isActive transition (soft-delete toggle vs plain edit).
    let auditAction: AuditAction = AuditAction.PROMOTION_UPDATED;
    if (data.isActive !== undefined && data.isActive !== existing.isActive) {
      auditAction = data.isActive
        ? AuditAction.PROMOTION_ACTIVATED
        : AuditAction.PROMOTION_DEACTIVATED;
    }

    try {
      const updated = await prisma.promotion.update({
        where: { id },
        data: update,
      });

      // Best-effort audit AFTER commit — changed field NAMES only (no values).
      await logAudit({
        action: auditAction,
        actorId: gate.session.user.id,
        actorEmail: gate.session.user.email ?? null,
        ip: await ipFromHeaders(),
        targetType: "Promotion",
        targetId: updated.id,
        detail: JSON.stringify({ fields: changedFields }),
      });

      return NextResponse.json(serializeAdminPromotion(updated));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // Unique-constraint on `code`.
        if (err.code === "P2002") {
          return NextResponse.json(
            { error: "รหัสโปรโมชันนี้ถูกใช้งานแล้ว", code: "CODE_TAKEN" },
            { status: 409 }
          );
        }
        // Row vanished between load and update (defensive; no hard DELETE exists).
        if (err.code === "P2025") {
          return NextResponse.json(
            { error: "ไม่พบโปรโมชัน", code: "NOT_FOUND" },
            { status: 404 }
          );
        }
      }
      logger.error({ err }, "PATCH /api/promotions/[id] failed");
      return NextResponse.json(
        { error: "ไม่สามารถแก้ไขโปรโมชันได้", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

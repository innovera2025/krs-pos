import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { HeldBillPostBodySchema } from "@/lib/schemas/held-bill";
import { parseBody } from "@/lib/schemas/_shared";
import { bahtToSatang, computeTotals } from "@/lib/pricing";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";
import type { HeldBillCartSnapshot, HeldBillDTO } from "@/types";

// GET reads no searchParams but is per-cashier session-dependent, so it must never be
// statically cached — force on-demand rendering.
export const dynamic = "force-dynamic";

// The Prisma HeldBill row shape returned by create/findMany (cartJson is JsonValue).
type HeldBillRow = {
  id: string;
  label: string;
  cartJson: Prisma.JsonValue;
  customerId: string | null;
  discountType: string;
  discountValue: number;
  taxRequested: boolean;
  createdById: string;
  branchId: string;
  createdAt: Date;
};

/**
 * Map a persisted HeldBill row to its wire DTO. `itemCount` (Σ line quantities),
 * `customerName`, and `totalSatang` are derived/echoed for the held-bills list display;
 * `cartJson` is cast back to the typed snapshot the POS replays on resume. The cart's
 * own totalSatang is not recomputed here (the snapshot is display-only — checkout
 * recomputes authoritatively on resume), so the value captured at park time is passed
 * through via `totalSatang`.
 */
function toHeldBillDTO(row: HeldBillRow, totalSatang: number): HeldBillDTO {
  const cartJson = row.cartJson as unknown as HeldBillCartSnapshot;
  const itemCount = cartJson.items.reduce((sum, i) => sum + i.quantity, 0);
  return {
    id: row.id,
    label: row.label,
    customerId: row.customerId,
    customerName: cartJson.customer?.name ?? null,
    discountType: row.discountType === "percent" ? "percent" : "amount",
    discountValue: row.discountValue,
    taxRequested: row.taxRequested,
    itemCount,
    totalSatang,
    createdById: row.createdById,
    branchId: row.branchId,
    createdAt: row.createdAt.toISOString(),
    cartJson,
  };
}

// POST /api/held-bills — park the current cart as a held bill (พักบิล).
//
// AUTH: requireUser — parking a bill is a cashier action at /pos; any authenticated
// active session is the correct gate. The created row is scoped to the cashier
// (createdById = session.user.id) so it is only ever visible to its owner.
//
// Validation: HeldBillPostBodySchema asserts the snapshot SHAPE at the parse boundary.
// The snapshot is display/restore only — checkout recomputes all money/stock on resume,
// so no price/total here is trusted as authority. `totalSatang` is echoed back for the
// list display.
export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;
    const { session } = gate;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    const parsed = parseBody(HeldBillPostBodySchema, raw);
    if ("response" in parsed) return parsed.response;
    const {
      label,
      cartJson,
      customerId,
      discountType,
      discountValue,
      taxRequested,
      totalSatang,
    } = parsed.data;

    try {
      // Explicit Prisma data (no body spread). `createdById` is taken from the SESSION
      // (never the client) so a cashier can only create bills under their own identity.
      // `branchId` keeps its schema default (BR-01): the session carries the KRS
      // `branchCode` (a DIFFERENT namespace that must never be conflated with the POS
      // `branchId`), so there is no session-derived POS branch to use here.
      const created = await prisma.heldBill.create({
        data: {
          label,
          cartJson: cartJson as unknown as Prisma.InputJsonValue,
          customerId: customerId ?? null,
          discountType,
          discountValue,
          taxRequested,
          createdById: session.user.id,
        },
      });
      return NextResponse.json(toHeldBillDTO(created, totalSatang), {
        status: 201,
      });
    } catch (err) {
      logger.error({ err }, "POST /api/held-bills failed");
      return NextResponse.json(
        { error: "Could not hold bill", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

// GET /api/held-bills — list the CURRENT cashier's parked bills (พักบิล), oldest first
// (the order they were parked). Scoped per-cashier (createdById = session.user.id) so a
// cashier never sees another's held bill.
//
// AUTH: requireUser — mirrors POST.
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;
    const { session } = gate;

    try {
      const rows = await prisma.heldBill.findMany({
        // `resolvedAt: null` lists only ACTIVE held bills — soft-deleted (discarded or
        // consumed-on-resume) rows carry a non-null resolvedAt and are excluded.
        where: { createdById: session.user.id, resolvedAt: null },
        orderBy: { createdAt: "asc" },
      });
      // The list total (totalSatang) is recomputed from the snapshot via the SAME pure
      // pricing engine the cart uses, so the listed total exactly matches the bill total
      // captured at park time — including the bill-level discount (discountType/Value) —
      // without a stored aggregate column. Display-only: checkout recomputes money/stock
      // authoritatively from live DB prices when the bill is resumed.
      const dtos = rows.flatMap((row) => {
        const cart = row.cartJson as unknown as HeldBillCartSnapshot;
        // Per-row guard (M2): a single malformed cartJson (not an object with an
        // `items` array) must not throw and hide ALL of this cashier's bills. Skip the
        // bad row (logged) and keep the good ones rather than 500-ing the whole list.
        if (!cart || !Array.isArray(cart.items)) {
          logger.warn(
            { heldBillId: row.id },
            "GET /api/held-bills: skipping held bill with malformed cartJson"
          );
          return [];
        }
        const totals = computeTotals(
          cart.items.map((i) => ({
            priceSatang: bahtToSatang(i.productPrice),
            qty: i.quantity,
            lineDiscountSatang: i.lineDiscountSatang,
          })),
          {
            type: row.discountType === "percent" ? "percent" : "amount",
            value: Number.isFinite(row.discountValue) ? row.discountValue : 0,
          }
        );
        return [toHeldBillDTO(row, totals.totalSatang)];
      });
      return NextResponse.json(dtos);
    } catch (err) {
      logger.error({ err }, "GET /api/held-bills failed");
      return NextResponse.json(
        { error: "Could not load held bills", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

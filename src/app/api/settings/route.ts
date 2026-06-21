import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, requireAdmin } from "@/lib/auth";
import { ShopSettingsPatchBodySchema } from "@/lib/schemas/shopSettings";
import { parseBody } from "@/lib/schemas/_shared";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";
import type { ShopSettingsDTO } from "@/types";

/**
 * Store-level receipt print-size settings API (Receipt print-size feature).
 *
 *  GET   — requireUser. The CASHIER must read the configured size to print the
 *          thermal receipt, so any authenticated active session is the correct
 *          gate (NOT admin). UPSERT-ON-READ with schema defaults so the endpoint
 *          always returns a valid size even before a seed runs.
 *  PATCH — requireAdmin. Only an admin changes the size. Zod-validated (width
 *          40–120, fixed height 50–400 nullable, auto bool); when `receiptHeightAuto`
 *          is true the route FORCES `receiptHeightMm = null` before the upsert.
 *
 * Storage is the `ShopSettings` singleton (`id: "singleton"`). Both verbs operate
 * on that one row. Errors use the established `{ error, code }` contract.
 */

/** The single ShopSettings row id (singleton). */
const SINGLETON_ID = "singleton";

/** Project only the receipt-size fields the DTO exposes (singleton metadata —
 *  createdAt/updatedAt — is internal and not returned to the client). */
const SETTINGS_SELECT = {
  receiptWidthMm: true,
  receiptHeightAuto: true,
  receiptHeightMm: true,
} as const;

/** Wrap the projected row in the `{ settings }` response envelope. */
function toResponse(row: ShopSettingsDTO) {
  return { settings: row };
}

// GET /api/settings — read the receipt-size singleton (upsert-on-read).
//
// AUTH: requireUser — the cashier reads this to size the printed receipt; the
// payload is non-sensitive store config, but it must not be anonymous.
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    try {
      // Upsert-on-read: create the singleton with schema defaults if missing so
      // the endpoint always returns a usable size even on a fresh, unseeded DB.
      // `update: {}` is a no-op when the row already exists (idempotent read).
      const settings = await prisma.shopSettings.upsert({
        where: { id: SINGLETON_ID },
        update: {},
        create: { id: SINGLETON_ID },
        select: SETTINGS_SELECT,
      });
      return NextResponse.json(toResponse(settings));
    } catch (err) {
      logger.error({ err }, "GET /api/settings failed");
      return NextResponse.json(
        { error: "Could not load settings", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

// PATCH /api/settings — update the receipt-size singleton. Admin-only.
//
// AUTH: requireAdmin — only an admin changes the store's receipt size. The
// per-handler guard is the real authorization boundary (defense-in-depth).
export async function PATCH(req: Request) {
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

    const parsed = parseBody(ShopSettingsPatchBodySchema, raw);
    if ("response" in parsed) return parsed.response;
    const { receiptWidthMm, receiptHeightAuto } = parsed.data;

    // Cross-field normalization: AUTO height ⇒ no fixed mm. Forcing null here keeps
    // the stored row self-consistent regardless of a stale `receiptHeightMm` the
    // client may have sent alongside auto=true.
    const receiptHeightMm = receiptHeightAuto ? null : parsed.data.receiptHeightMm;

    try {
      const settings = await prisma.shopSettings.upsert({
        where: { id: SINGLETON_ID },
        update: { receiptWidthMm, receiptHeightAuto, receiptHeightMm },
        create: {
          id: SINGLETON_ID,
          receiptWidthMm,
          receiptHeightAuto,
          receiptHeightMm,
        },
        select: SETTINGS_SELECT,
      });
      return NextResponse.json(toResponse(settings));
    } catch (err) {
      logger.error({ err }, "PATCH /api/settings failed");
      return NextResponse.json(
        { error: "Could not save settings", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
// Per-item VAT kill switch (per-item-vat program) — surfaced READ-ONLY to the POS client
// so its on-screen pricing math + the receipt VAT breakdown match the server. This is a
// server-read of the validated env, NOT a DB column.
import { env } from "@/lib/env";
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

/** Project the receipt-size + seller-identity fields the DTO exposes (singleton
 *  metadata — createdAt/updatedAt — is internal and not returned to the client).
 *  The seller fields (seller-company-settings) feed the Settings form + the
 *  thermal-receipt header; null = "not set in DB" (getSellerConfig falls back to
 *  ENV for the resolved tax-invoice block). */
const SETTINGS_SELECT = {
  receiptWidthMm: true,
  receiptHeightAuto: true,
  receiptHeightMm: true,
  sellerName: true,
  sellerTaxId: true,
  sellerAddress: true,
  sellerPhone: true,
  sellerPosId: true,
  sellerBranchCode: true,
  sellerBranchLabel: true,
  // Loyalty program config (loyalty program, Phase 1A) — surfaced so the Settings
  // loyalty card can hydrate and the checkout/redeem paths (Phase 1B/2) can read the
  // active earn/redeem rate.
  loyaltyEnabled: true,
  earnBahtPerPoint: true,
  redeemPointValueSatang: true,
  minRedeemPoints: true,
} as const;

/** Wrap the projected DB row in the `{ settings }` response envelope, injecting the
 *  per-item-VAT flag (per-item-vat program). `perItemVatEnabled` is a RUNTIME read of the
 *  env (owner-operated kill switch), NOT a `ShopSettings` column — so it is added here for
 *  BOTH GET and PATCH from a single place. The POS client reads it to keep its on-screen
 *  VAT/total math + the receipt VAT breakdown in lock-step with the server recompute. */
function toResponse(row: Omit<ShopSettingsDTO, "perItemVatEnabled">) {
  return {
    settings: {
      ...row,
      perItemVatEnabled: env.PER_ITEM_VAT_ENABLED === "true",
    } satisfies ShopSettingsDTO,
  };
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

    // Seller-identity normalization (seller-company-settings). `undefined` = field
    // not sent in this PATCH → Prisma SKIPS it (value unchanged). An empty/blank
    // string = "clear this field" → stored as `null` so storage stays consistent
    // (null = not set; empty string is never persisted), mirroring how
    // `receiptHeightMm` is normalized. A trimmed non-empty string is stored as-is.
    const toNullOrTrimmed = (
      v: string | undefined
    ): string | null | undefined =>
      v === undefined ? undefined : v.trim() === "" ? null : v.trim();

    const sellerName = toNullOrTrimmed(parsed.data.sellerName);
    const sellerTaxId = toNullOrTrimmed(parsed.data.sellerTaxId);
    const sellerAddress = toNullOrTrimmed(parsed.data.sellerAddress);
    const sellerPhone = toNullOrTrimmed(parsed.data.sellerPhone);
    const sellerPosId = toNullOrTrimmed(parsed.data.sellerPosId);
    const sellerBranchCode = toNullOrTrimmed(parsed.data.sellerBranchCode);
    const sellerBranchLabel = toNullOrTrimmed(parsed.data.sellerBranchLabel);

    // Loyalty config (loyalty program, Phase 1A). Each field is `undefined` when not
    // sent → Prisma leaves it unchanged (patch semantics); the Zod schema already
    // enforced the int/bool bounds, so no further normalization is needed. The
    // settings route audits none of its changes today, so no LOYALTY_SETTINGS_CHANGED
    // audit is written here (the AuditAction value exists for a future audited surface).
    const {
      loyaltyEnabled,
      earnBahtPerPoint,
      redeemPointValueSatang,
      minRedeemPoints,
    } = parsed.data;

    try {
      const settings = await prisma.shopSettings.upsert({
        where: { id: SINGLETON_ID },
        update: {
          receiptWidthMm,
          receiptHeightAuto,
          receiptHeightMm,
          // Prisma treats `undefined` as "do not touch" — so unsent seller fields
          // stay unchanged; `null` clears the field.
          sellerName,
          sellerTaxId,
          sellerAddress,
          sellerPhone,
          sellerPosId,
          sellerBranchCode,
          sellerBranchLabel,
          // Loyalty config — `undefined` leaves the field unchanged.
          loyaltyEnabled,
          earnBahtPerPoint,
          redeemPointValueSatang,
          minRedeemPoints,
        },
        create: {
          id: SINGLETON_ID,
          receiptWidthMm,
          receiptHeightAuto,
          receiptHeightMm,
          sellerName,
          sellerTaxId,
          sellerAddress,
          sellerPhone,
          sellerPosId,
          sellerBranchCode,
          sellerBranchLabel,
          // Loyalty config — `undefined` falls back to the schema column defaults.
          loyaltyEnabled,
          earnBahtPerPoint,
          redeemPointValueSatang,
          minRedeemPoints,
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

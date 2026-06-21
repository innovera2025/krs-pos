import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getSellerConfig } from "@/lib/sellerConfig";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// Seller identity is read from env at request time (D2). Force-dynamic so a
// build-time prerender never bakes a stale/empty seller block into the response.
export const dynamic = "force-dynamic";

// GET /api/seller-config — the seller identity block for the A4 tax-invoice
// document (Phase 4, owner decision D2: ENV-based seller config).
//
// AUTH: requires an authenticated active session (requireUser). The seller TIN +
// registered address are business-identity data and the print flow is staff-only;
// an anonymous request must not be able to read them.
//
// Returns `{ seller: SellerConfig | null }`. `null` means the mandatory §86/4
// particulars (TIN / name / address) are not configured — the client uses that to
// keep the "พิมพ์ใบกำกับภาษี" flow honest. The authoritative refusal still lives
// in the request-tax route (422 SELLER_NOT_CONFIGURED before minting); this read
// endpoint never mints anything.
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    try {
      const seller = getSellerConfig();
      return NextResponse.json({ seller });
    } catch (err) {
      logger.error({ err }, "GET /api/seller-config failed");
      return NextResponse.json(
        { error: "Could not load seller config", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

import { NextResponse } from "next/server";
import { SyncJobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// Always a live count — never prerendered/cached at build (the route takes no
// args, so without this Next would try to statically render it and hit the DB at
// build time). force-dynamic keeps it a request-time DB read.
export const dynamic = "force-dynamic";

// GET /api/sync-jobs/failed-count — the source for the NavRail failed-job badge
// (display-sidebar-failed-badge-source). A single COUNT(status=FAILED); the rail
// fetches it once on mount and shows the red dot when count > 0. Kept lightweight
// (no row payload) so the global rail's per-page fetch is cheap.
//
// AUTH (auth Phase 2): requireUser — the NavRail fetches this for every signed-in
// user; the data badge is hidden from sellers in the UI anyway, and the rail
// tolerates a non-ok response, so any active session is the correct gate.
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    // Error handling (theme #4): the NavRail fetches this on EVERY page mount for all
    // signed-in users, so an unguarded DB error here would surface as a raw 500 across
    // the whole app. Wrap it; the rail tolerates a non-ok response.
    try {
      const count = await prisma.syncJob.count({
        where: { status: SyncJobStatus.FAILED },
      });
      return NextResponse.json({ count });
    } catch (err) {
      logger.error({ err }, "GET /api/sync-jobs/failed-count failed");
      return NextResponse.json(
        { error: "Could not load failed count", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

import { NextResponse } from "next/server";
import { SyncJobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Always a live count — never prerendered/cached at build (the route takes no
// args, so without this Next would try to statically render it and hit the DB at
// build time). force-dynamic keeps it a request-time DB read.
export const dynamic = "force-dynamic";

// GET /api/sync-jobs/failed-count — the source for the NavRail failed-job badge
// (display-sidebar-failed-badge-source). A single COUNT(status=FAILED); the rail
// fetches it once on mount and shows the red dot when count > 0. Kept lightweight
// (no row payload) so the global rail's per-page fetch is cheap.
export async function GET() {
  const count = await prisma.syncJob.count({
    where: { status: SyncJobStatus.FAILED },
  });
  return NextResponse.json({ count });
}

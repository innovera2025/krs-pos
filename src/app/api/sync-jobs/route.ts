import { NextResponse } from "next/server";
import {
  SyncJobStatus,
  SyncJobType,
  SyncDirection,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";

// KRS sync jobs API (Phase 6b). The KRS transport is SIMULATED — there is no real
// MySQL/SSL connection here. The list + the two POST actions (pull / insert-all)
// are the only server writes for the /data screen; the Connection tab's
// test/insert-test/config + the mapping/mode toggles are pure client state
// (decision B). Checkout does NOT create SALE jobs (decision F) — jobs come from
// the seed, the 6a request-tax path, and these simulated actions.
//
// TODO(production-readiness): real KRS transport, idempotency on insert-all, auth.

/** Valid SyncJobStatus values for the optional `?status=` filter. */
function isSyncJobStatus(v: string): v is SyncJobStatus {
  return (Object.values(SyncJobStatus) as string[]).includes(v);
}

// GET /api/sync-jobs — list recent sync jobs (most-recently-updated first).
//
// Optional `?status=` filter is validated against SyncJobStatus; an unknown value
// is ignored (a stray param never 500s the /data screen), matching the orders
// route convention.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const statusParam = searchParams.get("status");

  const where =
    statusParam && isSyncJobStatus(statusParam)
      ? { status: statusParam }
      : {};

  const jobs = await prisma.syncJob.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return NextResponse.json(jobs);
}

type PostBody = { action?: unknown };

// POST /api/sync-jobs — simulated KRS data-flow actions.
//
//   { action: "pull" }       — create a SYNCED PULL job (ref KRS.products,
//     amount 0) representing a pull-and-map from KRS into the POS catalog.
//
//   { action: "insert-all" } — bulk-drain every PENDING job to SYNCED with a
//     canned INSERT response, returning { synced: n }. FAILED jobs are NOT
//     drained (a field-map mismatch must be fixed, not silently synced). When
//     nothing is pending it returns { synced: 0 } (no error).
export async function POST(req: Request) {
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  const action = body.action;
  if (action !== "pull" && action !== "insert-all") {
    return NextResponse.json(
      { error: "action must be 'pull' or 'insert-all'", code: "BAD_ACTION" },
      { status: 400 }
    );
  }

  try {
    if (action === "pull") {
      const job = await prisma.syncJob.create({
        data: {
          type: SyncJobType.PULL,
          direction: SyncDirection.PULL,
          ref: "KRS.products",
          amount: 0,
          status: SyncJobStatus.SYNCED,
          provider: "KRS",
          response:
            "HTTP 200 · ดึง N แถวจาก KRS.products → map field → อัปเดต POS",
        },
      });
      return NextResponse.json(job, { status: 201 });
    }

    // insert-all — drain only PENDING (FAILED stay FAILED).
    const result = await prisma.syncJob.updateMany({
      where: { status: SyncJobStatus.PENDING },
      data: {
        status: SyncJobStatus.SYNCED,
        response: 'HTTP 200 · INSERT KRS · {"rows":1}',
      },
    });
    return NextResponse.json({ synced: result.count });
  } catch (err) {
    console.error("POST /api/sync-jobs failed:", err);
    return NextResponse.json(
      { error: "Could not run sync action", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

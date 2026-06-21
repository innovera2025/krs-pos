import { NextResponse } from "next/server";
import { Prisma, SyncJobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
// WRAP-style Zod (D1): validate the action SHAPE + the new `reason` ≤ 500 cap. The
// invalid-action case keeps the existing 400 BAD_ACTION code; reason length is
// checked only when it is a string (preserving the silent-ignore → "—" default for
// a non-string reason). The route keeps its status gates and P2025 mapping.
import {
  SyncJobPatchActionSchema,
  SyncJobReasonSchema,
} from "@/lib/schemas/syncJob";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// PATCH /api/sync-jobs/[id] — retry or skip a simulated KRS sync job (Phase 6b).
// AUTH (auth Phase 2): admin-only — retry/skip are KRS Data Link admin actions.
// The status gates are SERVER-enforced (the client cannot be trusted to gate a
// retry/skip by state — mirrors the orders/[id] route convention).
//
//   { action: "retry" }            — gate status ∈ {FAILED, RETRYING, PENDING}
//     (else 409 INVALID_STATE). Transitions to SYNCED, clears error, and writes a
//     canned issued-document response. The KRS transport is SIMULATED — no real
//     retry happens.
//
//   { action: "skip", reason? }    — gate status ∉ {SYNCED, SKIPPED}
//     (else 409 INVALID_STATE; an already-synced/already-skipped job can't be
//     skipped). Transitions to SKIPPED and records the user-supplied reason.

type PatchBody = { action?: unknown; reason?: unknown };

const RETRYABLE: readonly SyncJobStatus[] = [
  SyncJobStatus.FAILED,
  SyncJobStatus.RETRYING,
  SyncJobStatus.PENDING,
];

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  return runWithRequestId(req, async () => {
  const gate = await requireAdmin();
  if ("response" in gate) return gate.response;

  const { id } = params;
  if (typeof id !== "string" || id.length === 0) {
    return NextResponse.json(
      { error: "Missing sync job id", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // WRAP-style Zod validates the action SHAPE; on failure keep the EXISTING 400
  // BAD_ACTION (same code/status/message the client already handles).
  const actionParse = SyncJobPatchActionSchema.safeParse(body);
  if (!actionParse.success) {
    return NextResponse.json(
      { error: "action must be 'retry' or 'skip'", code: "BAD_ACTION" },
      { status: 400 }
    );
  }
  const action = actionParse.data.action;

  // New `reason` ≤ 500 cap (§2B) — checked only when a string is supplied so a
  // non-string reason keeps its existing silent-ignore → "—" default behavior.
  if (typeof body.reason === "string" && !SyncJobReasonSchema.safeParse(body.reason).success) {
    return NextResponse.json(
      { error: "เหตุผลยาวเกินไป", code: "BAD_REASON" },
      { status: 400 }
    );
  }

  try {
    const existing = await prisma.syncJob.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "Sync job not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    if (action === "retry") {
      if (!RETRYABLE.includes(existing.status)) {
        return NextResponse.json(
          {
            error: "ลองใหม่ได้เฉพาะรายการที่ล้มเหลว/กำลังลองใหม่/รอส่ง",
            code: "INVALID_STATE",
          },
          { status: 409 }
        );
      }
      const docNo = `TAX-2026-${String(
        Math.floor(Math.random() * 900 + 100)
      )}`;
      const updated = await prisma.syncJob.update({
        where: { id },
        data: {
          status: SyncJobStatus.SYNCED,
          error: null,
          response: `HTTP 200 · {"doc_no":"${docNo}","status":"issued"}`,
        },
      });
      return NextResponse.json(updated);
    }

    // skip
    if (
      existing.status === SyncJobStatus.SYNCED ||
      existing.status === SyncJobStatus.SKIPPED
    ) {
      return NextResponse.json(
        {
          error: "ข้ามได้เฉพาะรายการที่ยังไม่ซิงค์/ยังไม่ถูกข้าม",
          code: "INVALID_STATE",
        },
        { status: 409 }
      );
    }
    const reason =
      typeof body.reason === "string" && body.reason.trim().length > 0
        ? body.reason.trim()
        : "—";
    const updated = await prisma.syncJob.update({
      where: { id },
      data: {
        status: SyncJobStatus.SKIPPED,
        response: `ข้ามโดยผู้ใช้ · เหตุผล: ${reason}`,
      },
    });
    return NextResponse.json(updated);
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Sync job not found", code: "NOT_FOUND" },
        { status: 404 }
      );
    }
    logger.error({ err }, "PATCH /api/sync-jobs/[id] failed");
    return NextResponse.json(
      { error: "Could not update sync job", code: "INTERNAL" },
      { status: 500 }
    );
  }
  });
}

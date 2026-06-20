import { NextResponse } from "next/server";
import { Prisma, SyncJobStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// PATCH /api/sync-jobs/[id] — retry or skip a simulated KRS sync job (Phase 6b).
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

  const action = body.action;
  if (action !== "retry" && action !== "skip") {
    return NextResponse.json(
      { error: "action must be 'retry' or 'skip'", code: "BAD_ACTION" },
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
    console.error("PATCH /api/sync-jobs/[id] failed:", err);
    return NextResponse.json(
      { error: "Could not update sync job", code: "INTERNAL" },
      { status: 500 }
    );
  }
}

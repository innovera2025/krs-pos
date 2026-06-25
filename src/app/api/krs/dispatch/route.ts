// NODE-ONLY. KRS outbound dispatch TRIGGER endpoint (krs-sync P2).
//
// POST /api/krs/dispatch — drains the SyncJob SALE outbox to KRS. Two auth modes:
//   1. MACHINE-TO-MACHINE bearer (primary): the krs-dispatch-cron sidecar sends
//      `Authorization: Bearer <KRS_DISPATCH_SECRET>` on an interval. The bearer secret
//      IS the authentication (no user session in a cron context). Mirrors the
//      auto-sync trigger exactly (constant-time compare, generic 401, never logged).
//   2. ADMIN SESSION (manual drain from the UI): an authenticated ADMIN/MANAGER may
//      trigger a drain by hand. A valid admin session is accepted when the bearer
//      check does not pass.
// Authorization requires EITHER a valid bearer OR a valid admin session — never
// unauthenticated.
//
// FAIL-OPEN: this endpoint runs long after checkout committed; it can never block or
// roll back a sale. Errors are sanitized (never raw mssql driver objects/config).
//
// Plan: process/features/krs-sync/active/krs-outbound-writeback_PLAN_25-06-26.md §5.1

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runDispatch } from "@/lib/krs/dispatcher";
import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * Constant-time bearer-secret check (identical discipline to /api/krs/auto-sync).
 * Returns true ONLY when the header is `Bearer <token>` and `<token>` equals the
 * configured secret. A length mismatch short-circuits before timingSafeEqual (the
 * length is not secret; the secret is min 32 chars). The token/secret are NEVER logged.
 */
function bearerMatches(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const token = authHeader.slice(prefix.length);
  if (token.length === 0) return false;

  const tokenBuf = Buffer.from(token, "utf8");
  const secretBuf = Buffer.from(secret, "utf8");
  if (tokenBuf.length !== secretBuf.length) return false;
  return timingSafeEqual(tokenBuf, secretBuf);
}

export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
    // === STEP 1: Authorize (bearer OR admin session) ===
    // Try the machine bearer first. A configured secret + matching header authorizes
    // the cron path. The secret is NEVER logged/echoed/returned.
    const secret = env.KRS_DISPATCH_SECRET;
    const bearerOk =
      typeof secret === "string" &&
      secret.length > 0 &&
      bearerMatches(req.headers.get("authorization"), secret);

    if (!bearerOk) {
      // Fall back to an admin session (manual drain from the UI). requireAdmin returns
      // 401 (not signed in) / 403 (not admin) — return that exact response so an
      // unauthenticated caller gets a clean denial. No "missing bearer" hint is leaked.
      const gate = await requireAdmin();
      if ("response" in gate) {
        return gate.response;
      }
    }

    // === STEP 2: Feature-flag gate (503 when outbound disabled) ===
    // The SALE SyncJob outbox is always populated at checkout, but the KRS WRITE is
    // opt-in. When disabled, return 503 OUTBOUND_DISABLED without claiming any job —
    // jobs simply accumulate and drain once enabled (plan §5.1 / §11.1).
    if (env.KRS_OUTBOUND_ENABLED !== "true") {
      return NextResponse.json(
        {
          error:
            "ปิดการส่งข้อมูลออกไป KRS อยู่ (KRS_OUTBOUND_ENABLED=false) · KRS outbound disabled",
          code: "OUTBOUND_DISABLED",
        },
        { status: 503 }
      );
    }

    // === STEP 3: Drain the outbox ===
    // runDispatch owns the atomic claim, dedup, retry/backoff, and the (Track-A stub)
    // KRS write. It never throws for a per-job fault; a top-level throw is only a
    // claim-query DB failure, which we sanitize here.
    try {
      const result = await runDispatch();
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      // Defensive: cannot contain KRS secrets (the write errors are sanitized inside
      // the dispatcher). Generic boundary message.
      logger.error({ err }, "POST /api/krs/dispatch failed");
      return NextResponse.json(
        {
          error: "ส่งข้อมูลไป KRS ไม่สำเร็จ · could not run KRS dispatch",
          code: "INTERNAL",
        },
        { status: 500 }
      );
    }
  });
}

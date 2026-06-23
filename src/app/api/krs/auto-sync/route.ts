// NODE-ONLY. KRS inbound auto-pull TRIGGER endpoint (krs-sync inbound auto-pull).
//
// POST /api/krs/auto-sync — the scheduled delta-pull trigger. Called by the cron
// scheduler (the krs-cron sidecar in docker-compose.prod.yml) on an interval, NOT
// by a browser. It therefore uses MACHINE-TO-MACHINE bearer auth (a shared secret),
// NOT the NextAuth session / requireAdmin — there is no user session in a cron
// context. The bearer secret IS the authentication for this route.
//
// ⚠️ SECURITY — this is the codebase's FIRST machine-auth path. It is flagged for a
// mandatory security-reviewer pass before any production deploy. Hardening here:
//   - The bearer token is compared to KRS_SYNC_TRIGGER_SECRET in CONSTANT TIME
//     (crypto.timingSafeEqual) to deny a timing oracle on the secret.
//   - A length mismatch returns 401 immediately (timingSafeEqual requires equal-
//     length buffers; the length itself is not secret — the secret is min 32 chars).
//   - The secret is NEVER logged, echoed, or returned at any level.
//   - All auth failures return a single generic 401 (no "missing header" vs "wrong
//     secret" distinction that would help an attacker probe).
//   - It does NOT call requireAdmin (intentional — machine auth, no session).
//
// FAIL-SAFE: the heavy lifting (delta math, stock writes, fail-safe aborts) lives in
// runAutoSync; this route only authenticates, gates on the kill switch, builds the
// KRS config, and maps the structured result to a clean HTTP response. Errors are
// sanitized (never raw mssql driver objects / config / password).

import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { buildConnectionConfig } from "@/lib/krs/client";
import { KrsKeyError } from "@/lib/krs/crypto";
import { runAutoSync } from "@/lib/krs/autoSync";
import { env } from "@/lib/env";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/** Default branch for the multi-branch-ready data model (single-store deploy). */
const DEFAULT_BRANCH_ID = "BR-01";

/**
 * Constant-time bearer-secret check. Returns true ONLY when the `Authorization`
 * header is `Bearer <token>` and `<token>` equals the configured secret.
 *
 * - Returns false (→ 401) when the header is absent / malformed / not Bearer.
 * - A length mismatch short-circuits to false WITHOUT a timingSafeEqual call (the
 *   comparison requires equal-length buffers; the length is not the secret).
 * - When lengths match, timingSafeEqual does a constant-time compare so the route
 *   leaks no timing signal about how many leading bytes were correct.
 *
 * The token / secret are NEVER logged here or by the caller.
 */
function bearerMatches(authHeader: string | null, secret: string): boolean {
  if (!authHeader) return false;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return false;
  const token = authHeader.slice(prefix.length);
  if (token.length === 0) return false;

  const tokenBuf = Buffer.from(token, "utf8");
  const secretBuf = Buffer.from(secret, "utf8");
  // Unequal lengths can never be equal; bail before timingSafeEqual (which throws on
  // a length mismatch). The length is not secret (the secret is min 32 chars).
  if (tokenBuf.length !== secretBuf.length) return false;
  return timingSafeEqual(tokenBuf, secretBuf);
}

export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
    // === STEP 1: Machine auth (bearer secret, timing-safe) ===
    const secret = env.KRS_SYNC_TRIGGER_SECRET;
    if (!secret) {
      // The trigger secret is not configured — the endpoint cannot authenticate
      // anyone, so it refuses to run. NEVER reveal anything about the secret.
      logger.warn("POST /api/krs/auto-sync: KRS_SYNC_TRIGGER_SECRET not configured");
      return NextResponse.json(
        {
          error:
            "ยังไม่ได้ตั้งค่า trigger secret บนเซิร์ฟเวอร์ · auto-sync trigger secret not configured",
          code: "AUTO_SYNC_NOT_CONFIGURED",
        },
        { status: 503 }
      );
    }

    if (!bearerMatches(req.headers.get("authorization"), secret)) {
      // Single generic 401 for every auth failure (missing/malformed/wrong). NEVER
      // log the provided token or the secret.
      return NextResponse.json(
        { error: "Unauthorized", code: "UNAUTHENTICATED" },
        { status: 401 }
      );
    }

    // === STEP 2: Kill switch ===
    if (env.KRS_AUTO_SYNC_ENABLED !== "true") {
      return NextResponse.json(
        {
          error:
            "ปิดการซิงค์อัตโนมัติอยู่ (KRS_AUTO_SYNC_ENABLED=false) · KRS auto-sync is disabled",
          code: "AUTO_SYNC_DISABLED",
        },
        { status: 422 }
      );
    }

    // === STEP 3: Build the KRS connection config ===
    let config;
    try {
      config = await buildConnectionConfig();
    } catch (err) {
      if (err instanceof KrsKeyError) {
        logger.error({ err }, "POST /api/krs/auto-sync: KRS encryption key missing/invalid");
        return NextResponse.json(
          {
            error:
              "ยังไม่ได้ตั้งค่า KRS_CONFIG_ENC_KEY บนเซิร์ฟเวอร์ · server encryption key missing",
            code: "KRS_KEY_MISSING",
          },
          { status: 500 }
        );
      }
      logger.error({ err }, "POST /api/krs/auto-sync failed (config)");
      return NextResponse.json(
        { error: "ซิงค์อัตโนมัติไม่สำเร็จ · could not run auto-sync", code: "INTERNAL" },
        { status: 500 }
      );
    }

    if (config === null) {
      return NextResponse.json(
        {
          error: "ยังไม่ได้ตั้งค่าการเชื่อมต่อ KRS · KRS connection not configured",
          code: "KRS_NOT_CONFIGURED",
        },
        { status: 422 }
      );
    }

    // === STEP 4: Run the delta engine ===
    // runAutoSync owns the fail-safe aborts (product upsert / sp_Onhand faults),
    // the single-run lock, and the empty-result protection. It NEVER throws for a
    // KRS-side fault — those map to a structured status — but a truly-unexpected
    // bug could throw, so wrap defensively to keep the secret/error sanitized.
    try {
      const result = await runAutoSync(config, {
        warehouse: env.KRS_AUTO_SYNC_WAREHOUSE || null,
        branchId: DEFAULT_BRANCH_ID,
      });
      return NextResponse.json({ ok: true, ...result });
    } catch (err) {
      // Defensive: cannot contain KRS secrets (the KRS read errors are already
      // sanitized inside the lib). Generic boundary message.
      logger.error({ err }, "POST /api/krs/auto-sync failed (run)");
      return NextResponse.json(
        { error: "ซิงค์อัตโนมัติไม่สำเร็จ · could not run auto-sync", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

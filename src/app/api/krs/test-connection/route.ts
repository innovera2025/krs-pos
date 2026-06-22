import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { parseBody } from "@/lib/schemas/_shared";
import { KrsTestConnectionBodySchema } from "@/lib/schemas/krsSettings";
import { testConnection, testConnectionWithInput } from "@/lib/krs/client";
import { KrsKeyError } from "@/lib/krs/crypto";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * POST /api/krs/test-connection (krs-sync P1, admin-only).
 *
 * Two code paths:
 *  - Empty body `{}` (or absent) → test the SAVED config from the DB
 *    (`testConnection()`), which returns a clean "not configured" result when KRS
 *    is not yet set up (no throw).
 *  - A non-empty body → validate it (the §1.2.1 bounds) and test that one-shot
 *    override ("test before save"). The plaintext password is held only in the
 *    request and passed straight into the mssql config — it is NEVER logged and
 *    NEVER echoed in the response.
 *
 * Response: `{ connected, latencyMs, error }` with a SANITIZED error string (never
 * the raw mssql/tedious message or any config value — handled in the client).
 */
export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    // The body is optional. Treat an absent/invalid-JSON/empty body as "use the
    // saved config"; only run the override path when fields were actually sent.
    let raw: unknown = {};
    try {
      const text = await req.text();
      if (text.trim().length > 0) raw = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    const hasOverride =
      typeof raw === "object" && raw !== null && Object.keys(raw).length > 0;

    try {
      if (hasOverride) {
        const parsed = parseBody(KrsTestConnectionBodySchema, raw);
        if ("response" in parsed) return parsed.response;
        const result = await testConnectionWithInput(parsed.data);
        return NextResponse.json(result);
      }

      const result = await testConnection();
      return NextResponse.json(result);
    } catch (err) {
      // A missing/invalid KRS_CONFIG_ENC_KEY (saved-config path needs to decrypt the
      // stored password) throws a distinct KrsKeyError — surface it as a clear,
      // non-sensitive SERVER-config message rather than a generic connection failure
      // (security F3). The message names the env var only; no secret material.
      if (err instanceof KrsKeyError) {
        logger.error({ err }, "POST /api/krs/test-connection: KRS encryption key missing/invalid");
        return NextResponse.json({
          connected: false,
          latencyMs: null,
          error: "ยังไม่ได้ตั้งค่า KRS_CONFIG_ENC_KEY บนเซิร์ฟเวอร์ · server encryption key missing",
        });
      }
      // Defense-in-depth: testConnection / testConnectionWithInput already return
      // sanitized failures rather than throwing for connection errors, so reaching
      // here means an unexpected internal fault. Log without the password (redacted)
      // and return a sanitized failure shape.
      logger.error({ err }, "POST /api/krs/test-connection failed");
      return NextResponse.json({
        connected: false,
        latencyMs: null,
        error: "Connection test failed",
      });
    }
  });
}

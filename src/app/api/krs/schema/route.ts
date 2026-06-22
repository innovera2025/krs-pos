import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { buildConnectionConfig, introspectSchemaWithConfig } from "@/lib/krs/client";
import { KrsKeyError } from "@/lib/krs/crypto";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * GET /api/krs/schema (krs-sync P1, admin-only).
 *
 * Runs `INFORMATION_SCHEMA.COLUMNS` introspection over the fixed KRS table
 * allow-list (no user-supplied SQL) and returns real column metadata so the Field
 * Mapping UI (P2/P3 — this phase ships the endpoint only) can show live shapes.
 *
 * Responses (all 200, never throwing the raw driver error/config):
 *  - Not configured (no saved config): `{ configured: false }`.
 *  - Success: `{ configured: true, tables: { [tableName]: KrsColumn[] } }`.
 *  - Configured but introspection failed (driver fault — the client already logged
 *    a SANITIZED error and returned null): `{ configured: true, tables: null,
 *    error: "Schema introspection failed" }` (sanitized — no raw driver message).
 *  - Server encryption key missing/invalid (KrsKeyError from decrypt): a distinct,
 *    non-sensitive message so the admin knows it is a SERVER config problem, not a
 *    network fault (security F3).
 *
 * We build the config ONCE: a `null` result classifies "not configured" (no row /
 * no stored password — it opens no connection), and the same non-null config is
 * reused for `introspectSchemaWithConfig` so we never re-read + re-decrypt the
 * singleton (code-review M2).
 */
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    let config;
    try {
      // Build ONCE. Returns null only when there is no row or no stored password
      // (it opens no connection). Decrypting the stored password here can throw a
      // KrsKeyError when KRS_CONFIG_ENC_KEY is missing/invalid — caught below.
      config = await buildConnectionConfig();
    } catch (err) {
      if (err instanceof KrsKeyError) {
        logger.error({ err }, "GET /api/krs/schema: KRS encryption key missing/invalid");
        return NextResponse.json({
          configured: true,
          tables: null,
          error: "ยังไม่ได้ตั้งค่า KRS_CONFIG_ENC_KEY บนเซิร์ฟเวอร์ · server encryption key missing",
        });
      }
      logger.error({ err }, "GET /api/krs/schema failed");
      return NextResponse.json({
        configured: true,
        tables: null,
        error: "Schema introspection failed",
      });
    }

    if (config === null) {
      return NextResponse.json({ configured: false });
    }

    // Reuse the already-built config — no second Prisma read / decrypt.
    const tables = await introspectSchemaWithConfig(config);
    if (tables === null) {
      // Configured but introspection failed — the client logged a sanitized error.
      // Report the sanitized error shape (no raw driver message).
      return NextResponse.json({
        configured: true,
        tables: null,
        error: "Schema introspection failed",
      });
    }
    return NextResponse.json({ configured: true, tables });
  });
}

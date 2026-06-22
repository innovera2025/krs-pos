import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { buildConnectionConfig } from "@/lib/krs/client";
import { fetchKrsProducts } from "@/lib/krs/products";
import { importKrsProducts } from "@/lib/krs/importProducts";
import { KrsKeyError } from "@/lib/krs/crypto";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * POST /api/krs/pull-products (krs-sync inbound pull, admin-only).
 *
 * The inbound "pull products from KRS" action: reads the KRS product master
 * (`dbo.InventoryItem`, READ ONLY) and upserts it into POS `Category`/`Product`.
 * It NEVER writes to KRS.
 *
 * Flow:
 *  1. requireAdmin (the REAL authorization boundary — defense-in-depth).
 *  2. buildConnectionConfig() — null ⇒ KRS not configured (422, clean message);
 *     a KrsKeyError ⇒ the server encryption key is missing/invalid (500, distinct
 *     non-sensitive message so the admin knows it is a SERVER config fault).
 *  3. fetchKrsProducts(config) — sanitized errors (the client never logs/propagates
 *     the raw mssql error/config/password); a fetch failure ⇒ 502.
 *  4. importKrsProducts(records) — POS-side Category/Product upsert.
 *  5. Return `{ ok, created, updated, barcodeSkipped, categories, total }`.
 *
 * Sanitized errors only: the raw mssql/tedious message (which leaks host/login)
 * never crosses this boundary. The success path writes a STRUCTURED log with the
 * counts only — no PII, no secrets.
 */
export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    let config;
    try {
      // null only when there is no saved row / no stored password (opens no
      // connection). Decrypting the stored password can throw KrsKeyError when
      // KRS_CONFIG_ENC_KEY is missing/invalid — caught distinctly below.
      config = await buildConnectionConfig();
    } catch (err) {
      if (err instanceof KrsKeyError) {
        logger.error(
          { err },
          "POST /api/krs/pull-products: KRS encryption key missing/invalid"
        );
        return NextResponse.json(
          {
            error:
              "ยังไม่ได้ตั้งค่า KRS_CONFIG_ENC_KEY บนเซิร์ฟเวอร์ · server encryption key missing",
            code: "KRS_KEY_MISSING",
          },
          { status: 500 }
        );
      }
      logger.error({ err }, "POST /api/krs/pull-products failed (config)");
      return NextResponse.json(
        { error: "ดึงสินค้าไม่สำเร็จ · could not pull products", code: "INTERNAL" },
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

    // ---- Fetch from KRS (read-only) ----
    let records;
    try {
      records = await fetchKrsProducts(config);
    } catch {
      // fetchKrsProducts already logged a SANITIZED error. Return a clean,
      // non-sensitive boundary message (never the raw driver message).
      return NextResponse.json(
        {
          error: "เชื่อมต่อ KRS ไม่สำเร็จหรืออ่านสินค้าไม่ได้ · could not read KRS products",
          code: "KRS_FETCH_FAILED",
        },
        { status: 502 }
      );
    }

    // ---- Upsert into POS (Postgres) ----
    try {
      const result = await importKrsProducts(records);
      // Structured success log — counts only, no PII / no secrets.
      logger.info(
        {
          krsPull: {
            total: records.length,
            created: result.created,
            updated: result.updated,
            barcodeSkipped: result.barcodeSkipped,
            categories: result.categories,
          },
        },
        "KRS pull-products completed"
      );
      return NextResponse.json({
        ok: true,
        created: result.created,
        updated: result.updated,
        barcodeSkipped: result.barcodeSkipped,
        categories: result.categories,
        total: records.length,
      });
    } catch (err) {
      // The import error is from Postgres/Prisma, not from KRS — it cannot contain
      // KRS connection secrets. Logged without leaking; a generic message crosses.
      logger.error({ err }, "POST /api/krs/pull-products failed (import)");
      return NextResponse.json(
        { error: "บันทึกสินค้าไม่สำเร็จ · could not save products", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { buildConnectionConfig } from "@/lib/krs/client";
import { fetchKrsStockBalances } from "@/lib/krs/stock";
import { KrsKeyError } from "@/lib/krs/crypto";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * GET /api/krs/reconcile (krs-sync R1 stock reconciliation, admin-only).
 *
 * READ-ONLY both ways: reads the KRS vendor-authoritative on-hand stored procedure
 * (`dbo.sp_Onhand`, current Balqty per ItemCode) and the POS product table, JOINs
 * them by `sku == itemCode`, and returns a per-item POS-vs-KRS stock comparison plus
 * the only-in-KRS / only-in-POS lists and a summary. It NEVER writes to KRS, and it
 * does NOT write to POS either (the write-side baseline import is POST
 * /api/krs/sync-stock).
 *
 * Flow:
 *  1. requireAdmin (the REAL authorization boundary — defense-in-depth).
 *  2. buildConnectionConfig() — null ⇒ KRS not configured (422, clean message);
 *     a KrsKeyError ⇒ the server encryption key is missing/invalid (500, distinct
 *     non-sensitive message so the admin knows it is a SERVER config fault).
 *  3. fetchKrsStockBalances(config) — sanitized errors; a fetch failure ⇒ 502.
 *  4. Load POS products (sku/name/stock/isActive), JOIN by sku == itemCode.
 *  5. Return per-item rows + onlyInKrs / onlyInPos lists + a summary.
 *
 * Sanitized errors only: the raw mssql/tedious message (which leaks host/login)
 * never crosses this boundary.
 */

/** POS-stock value is an Int column; the KRS balance can be fractional/negative, so
 *  a "match" compares the ROUNDED, FLOORED KRS balance (the baseline the sync-stock
 *  import would write) against POS stock. This keeps the reconcile status consistent
 *  with what a sync would produce: after a sync, every matched row reads "match". */
function krsBaseline(balance: number): number {
  return Math.max(0, Math.round(balance));
}

export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    let config;
    try {
      config = await buildConnectionConfig();
    } catch (err) {
      if (err instanceof KrsKeyError) {
        logger.error(
          { err },
          "GET /api/krs/reconcile: KRS encryption key missing/invalid"
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
      logger.error({ err }, "GET /api/krs/reconcile failed (config)");
      return NextResponse.json(
        { error: "เทียบสต็อกไม่สำเร็จ · could not reconcile stock", code: "INTERNAL" },
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

    // ---- Read KRS on-hand via sp_Onhand (read-only) ----
    let balances;
    try {
      balances = await fetchKrsStockBalances(config);
    } catch {
      // fetchKrsStockBalances already logged a SANITIZED error. Return a clean,
      // non-sensitive boundary message (never the raw driver message).
      return NextResponse.json(
        {
          error: "เชื่อมต่อ KRS ไม่สำเร็จหรืออ่านสต็อกไม่ได้ · could not read KRS stock",
          code: "KRS_FETCH_FAILED",
        },
        { status: 502 }
      );
    }

    // ---- Read POS products (read-only) + JOIN by sku == itemCode ----
    try {
      const products = await prisma.product.findMany({
        select: { sku: true, name: true, stock: true, isActive: true },
        orderBy: { sku: "asc" },
      });

      // Index KRS balances by item code; track which were consumed by a POS sku so
      // the leftovers become `onlyInKrs`.
      const krsByCode = new Map<string, (typeof balances)[number]>();
      for (const b of balances) krsByCode.set(b.itemCode, b);

      const rows: {
        sku: string;
        name: string;
        posStock: number;
        krsStock: number;
        diff: number;
        isActive: boolean;
        status: "match" | "mismatch";
      }[] = [];
      const onlyInPos: { sku: string; name: string; posStock: number; isActive: boolean }[] = [];
      const matchedCodes = new Set<string>();

      for (const p of products) {
        const krs = krsByCode.get(p.sku);
        if (krs === undefined) {
          // POS product with no KRS on-hand row (sp_Onhand reports no balance for it).
          onlyInPos.push({
            sku: p.sku,
            name: p.name,
            posStock: p.stock,
            isActive: p.isActive,
          });
          continue;
        }
        matchedCodes.add(p.sku);
        const krsStock = krsBaseline(krs.balance);
        const diff = p.stock - krsStock;
        rows.push({
          sku: p.sku,
          name: p.name,
          posStock: p.stock,
          krsStock,
          diff,
          isActive: p.isActive,
          status: diff === 0 ? "match" : "mismatch",
        });
      }

      // KRS item codes with no matching POS sku.
      const onlyInKrs: { itemCode: string; krsStock: number }[] = [];
      for (const b of balances) {
        if (matchedCodes.has(b.itemCode)) continue;
        onlyInKrs.push({
          itemCode: b.itemCode,
          krsStock: krsBaseline(b.balance),
        });
      }

      const mismatched = rows.filter((r) => r.status === "mismatch").length;
      const summary = {
        total: rows.length,
        matched: rows.length - mismatched,
        mismatched,
        onlyInKrs: onlyInKrs.length,
        onlyInPos: onlyInPos.length,
      };

      return NextResponse.json({
        ok: true,
        rows,
        onlyInKrs,
        onlyInPos,
        summary,
        checkedAt: new Date().toISOString(),
      });
    } catch (err) {
      // Postgres/Prisma error — cannot contain KRS secrets. Logged + generic message.
      logger.error({ err }, "GET /api/krs/reconcile failed (pos read)");
      return NextResponse.json(
        { error: "เทียบสต็อกไม่สำเร็จ · could not reconcile stock", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

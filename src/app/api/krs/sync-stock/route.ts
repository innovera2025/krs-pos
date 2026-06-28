import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { buildConnectionConfig } from "@/lib/krs/client";
import { fetchKrsStockBalances } from "@/lib/krs/stock";
import { KrsKeyError } from "@/lib/krs/crypto";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * POST /api/krs/sync-stock (krs-sync R1 baseline import, admin-only).
 *
 * The BASELINE import: reads the KRS vendor-authoritative on-hand stored procedure
 * (`dbo.sp_Onhand`, current Balqty per ItemCode, READ ONLY) and SETS each matching
 * POS `Product.stock` to that balance (rounded to the Int column, floored at 0 so a
 * negative KRS balance never writes a negative POS stock).
 *
 * Direction is STRICTLY one-way: it READS from KRS and WRITES ONLY to the POS
 * `Product.stock` column. It NEVER writes to KRS. Outbound write-back (R2) is
 * deferred (gated on the KRS vendor's supported write interface).
 *
 * Idempotent: re-running with the same KRS ledger state produces the same POS stock
 * values (it SETs, never increments).
 *
 * Flow:
 *  1. requireAdmin (the REAL authorization boundary — defense-in-depth).
 *  2. buildConnectionConfig() — null ⇒ KRS not configured (422); KrsKeyError ⇒ 500.
 *  3. fetchKrsStockBalances(config) — sanitized errors; a fetch failure ⇒ 502.
 *  4. For each POS product whose sku matches a KRS itemCode, set
 *     `stock = max(0, round(balance))`. Counts updated / skipped / notInKrs.
 *  5. Return `{ ok, updated, skipped, notInKrs, total }`.
 *
 * Sanitized errors only.
 */

/** The Int column the KRS balance is written into. KRS balance is fractional and
 *  can be negative; we round to the nearest integer and floor at 0 (a negative
 *  on-hand makes no sense for POS sellable stock). Capped at the 32-bit Postgres Int
 *  max so an absurd ledger value can never overflow the column (a 500). */
const POS_STOCK_MAX = 2_147_483_647;
function toPosStock(balance: number): number {
  if (!Number.isFinite(balance)) return 0;
  const rounded = Math.round(balance);
  if (rounded <= 0) return 0;
  return Math.min(rounded, POS_STOCK_MAX);
}

export async function POST(req: Request) {
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
          "POST /api/krs/sync-stock: KRS encryption key missing/invalid"
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
      logger.error({ err }, "POST /api/krs/sync-stock failed (config)");
      return NextResponse.json(
        { error: "ซิงค์สต็อกไม่สำเร็จ · could not sync stock", code: "INTERNAL" },
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
      return NextResponse.json(
        {
          error: "เชื่อมต่อ KRS ไม่สำเร็จหรืออ่านสต็อกไม่ได้ · could not read KRS stock",
          code: "KRS_FETCH_FAILED",
        },
        { status: 502 }
      );
    }

    // ---- Write ONLY to POS Product.stock (never to KRS) ----
    try {
      const krsByCode = new Map<string, number>();
      for (const b of balances) krsByCode.set(b.itemCode, b.balance);

      // Load POS products + their current stock so we can SKIP rows already at the
      // KRS baseline (idempotent: no needless write) and count notInKrs.
      const products = await prisma.product.findMany({
        select: { id: true, sku: true, stock: true },
      });

      let updated = 0;
      let skipped = 0;
      let notInKrs = 0;

      for (const p of products) {
        const balance = krsByCode.get(p.sku);
        if (balance === undefined) {
          // POS product with no KRS on-hand row — leave its POS stock untouched. No
          // snapshot is seeded (there is no KRS on-hand value to record).
          notInKrs += 1;
          continue;
        }

        // Seed/update KrsStockSnapshot with the RAW KRS balance (not the rounded POS
        // stock). This is what makes the FIRST auto-pull after a manual baseline
        // compute delta = 0 for unchanged items (krs-sync inbound auto-pull §10):
        // without it the auto-pull would treat the full KRS on-hand as a fresh delta
        // and double-add it. Seeded even on the SKIPPED path (POS stock already at
        // baseline) — the snapshot must reflect the current KRS value regardless of
        // whether POS stock changed. This is the manual absolute-baseline path, not
        // the auto delta path, so it intentionally tracks the raw KRS value here.
        // Composite-PK snapshot (Branch/Warehouse Phase 5): this manual baseline
        // seeds the GLOBAL all-warehouse sentinel row (warehouseCode = "") that the
        // global auto-sync delta engine reads. Per-warehouse rows are written by the
        // auto-sync per-warehouse pass, not here.
        await prisma.krsStockSnapshot.upsert({
          where: { itemCode_warehouseCode: { itemCode: p.sku, warehouseCode: "" } },
          update: { lastQty: new Prisma.Decimal(balance) },
          create: { itemCode: p.sku, warehouseCode: "", lastQty: new Prisma.Decimal(balance) },
        });

        const target = toPosStock(balance);
        if (target === p.stock) {
          // Already at the KRS baseline — no stock write (keeps the import
          // idempotent), but the snapshot above is still refreshed.
          skipped += 1;
          continue;
        }
        await prisma.product.update({
          where: { id: p.id },
          data: { stock: target },
          select: { id: true },
        });
        updated += 1;
      }

      logger.info(
        {
          krsSyncStock: {
            total: products.length,
            updated,
            skipped,
            notInKrs,
            krsItems: balances.length,
          },
        },
        "KRS sync-stock baseline completed"
      );

      return NextResponse.json({
        ok: true,
        updated,
        skipped,
        notInKrs,
        total: products.length,
      });
    } catch (err) {
      // Postgres/Prisma error — cannot contain KRS secrets. Logged + generic message.
      logger.error({ err }, "POST /api/krs/sync-stock failed (pos write)");
      return NextResponse.json(
        { error: "บันทึกสต็อกไม่สำเร็จ · could not save stock", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

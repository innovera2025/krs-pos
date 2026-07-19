#!/usr/bin/env node
// =============================================================================
// KRS POS — stock true-up (POSTGRES-ONLY)  [ops]  — krs-void-writeback Phase 1
// =============================================================================
// Plan: process/features/krs-sync/active/krs-void-writeback_PLAN_19-07-26.md (T2)
//
// Repairs Product.stock rows that drifted from the per-warehouse KrsStockSnapshot
// baseline because of the PRE-FIX dispatcher double-decrement bug: the post-sale
// snapshot-advance only touched the GLOBAL sentinel row (warehouseCode=""), so the
// next <=60s reconcile sweep saw each synced sale's KRS-side cut as a brand-new
// negative delta on the PER-WAREHOUSE row and re-applied it on top of an already-
// checkout-decremented Product.stock -- double-counting it (the shop's "ERP 339 vs
// POS 338"; backlog/outbound-production-gaps_TODO_27-06-26.md §9). The Phase 1
// dispatcher fix stops NEW drift; this script trues up drift that already happened.
//
// POSTGRES-ONLY: compares Product.stock against the ALREADY-STORED KrsStockSnapshot
// rows (the reconcile engine's own baseline) -- it NEVER opens an mssql connection
// and NEVER writes to KRS. It reads/writes Postgres only.
//
// DEFAULT = DRY-RUN (no flags): prints per-item drift (Product.stock vs the clamped
//   Σ per-warehouse KrsStockSnapshot.lastQty) for krsManaged + active items that HAVE
//   a snapshot baseline. Makes ZERO writes. Exit 0 always. Safe to run at ANY time.
//
// --apply: for each drifted item with NO in-flight SALE/VOID SyncJob (status
//   PENDING/RETRYING), rebases Product.stock to the expected value AND writes a
//   StockMovement ADJUST audit row (reference "trueup:<YYYY-MM-DD>"), ALL in one
//   Postgres transaction. Any item with an in-flight job is SKIPPED (logged) so the
//   rebase can never clobber a concurrent dispatcher decrement/increment.
//
//   --apply should be run ONCE, right after the Phase 1 dispatcher fix deploys, to
//   true-up the damage the pre-fix dispatcher already did. It is IDEMPOTENT: a second
//   --apply run finds zero drift once the underlying data is consistent. An item with
//   NO per-warehouse snapshot row (never baselined) is SKIPPED, never zeroed -- Σ=0
//   there means "no KRS baseline", not "0 on hand" (mirrors the dispatcher's
//   never-fabricate-a-0-baseline rule).
//
// Run (same migrate-image pattern as krs-discount-proof.cjs):
//   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
//     -v ~/krs-pos/scripts/krs-stock-trueup.cjs:/q.cjs:ro \
//     -e NODE_PATH=/app/node_modules -e DATABASE_URL="$DATABASE_URL" \
//     migrate node /q.cjs [--apply]
// =============================================================================

// Product.stock is a 32-bit Postgres Int; clamp Σ to it so an absurd ledger value can
// never overflow the column. Mirrors POS_STOCK_MAX (src/lib/krs/reconcileMath.ts:10).
const POS_STOCK_MAX = 2_147_483_647;

// Round + clamp a raw (fractional, possibly negative) Σ of snapshot balances to the
// non-negative integer Product.stock holds. Mirrors the clamp in reconcileMath.ts:10,32.
function clampExpected(rawSum) {
  if (!Number.isFinite(rawSum)) return 0;
  const rounded = Math.max(0, Math.round(rawSum));
  return rounded > POS_STOCK_MAX ? POS_STOCK_MAX : rounded;
}

// Signed integer -> "+N" / "-N" / "0" for the drift column.
const signed = (n) => (n > 0 ? `+${n}` : String(n));

async function main() {
  const apply = process.argv.includes("--apply");
  const { PrismaClient } = require("@prisma/client");
  const prisma = new PrismaClient();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  console.log(
    `[trueup] Postgres-only stock true-up — mode: ${apply ? "APPLY (writes)" : "DRY-RUN (read-only)"}`
  );

  try {
    // Σ per-warehouse (warehouseCode != "" excludes the global sentinel + run-lock rows)
    // snapshot balance per itemCode (= Product.sku). One grouped read.
    const sums = await prisma.krsStockSnapshot.groupBy({
      by: ["itemCode"],
      where: { warehouseCode: { not: "" } },
      _sum: { lastQty: true },
    });
    const sumMap = new Map();
    for (const s of sums) {
      sumMap.set(s.itemCode, Number(s._sum.lastQty ?? 0));
    }

    const products = await prisma.product.findMany({
      where: { krsManaged: true, isActive: true },
      select: { id: true, sku: true, stock: true },
      orderBy: { sku: "asc" },
    });

    // Build the drift list. An item with NO per-warehouse snapshot row (never baselined)
    // is SKIPPED -- Σ=0 there means "no KRS baseline", not "0 on hand".
    const drifted = [];
    let noBaseline = 0;
    for (const p of products) {
      if (!sumMap.has(p.sku)) {
        noBaseline += 1;
        continue;
      }
      const expected = clampExpected(sumMap.get(p.sku));
      if (p.stock !== expected) {
        drifted.push({
          id: p.id,
          sku: p.sku,
          current: p.stock,
          expected,
          delta: expected - p.stock,
        });
      }
    }

    console.log(
      `[trueup] scanned ${products.length} krsManaged+active items · ` +
        `${noBaseline} without a snapshot baseline (skipped) · ${drifted.length} drifted`
    );

    if (drifted.length === 0) {
      console.log("[trueup] no drift — Product.stock already matches Σ per-warehouse snapshot ✔");
      return;
    }

    console.log(
      `\n${"sku".padEnd(20)} ${"current".padStart(9)} ${"expected".padStart(9)} ${"drift".padStart(8)}`
    );
    for (const d of drifted) {
      console.log(
        `${String(d.sku).padEnd(20)} ${String(d.current).padStart(9)} ` +
          `${String(d.expected).padStart(9)} ${signed(d.delta).padStart(8)}`
      );
    }

    if (!apply) {
      console.log(
        `\n[trueup] DRY-RUN — ${drifted.length} item(s) would be rebased. ` +
          "Re-run with --apply to write. No changes made."
      );
      return;
    }

    // --apply: filter out any item with an in-flight SALE/VOID job (would race the
    // rebase), then rebase Product.stock + write an ADJUST audit row in ONE tx.
    // type::text avoids an enum error if 'VOID' is not yet a SyncJobType value (Phase 1
    // predates that migration); the LIKE pattern is a BOUND parameter (no injection).
    const toApply = [];
    let heldInflight = 0;
    for (const d of drifted) {
      const inflight = await prisma.$queryRaw`
        SELECT 1 FROM "SyncJob"
         WHERE status IN ('PENDING', 'RETRYING')
           AND "type"::text IN ('SALE', 'VOID')
           AND payload::text LIKE ${`%"itemCode":"${d.sku}"%`}
         LIMIT 1`;
      if (Array.isArray(inflight) && inflight.length > 0) {
        heldInflight += 1;
        console.log(`[trueup] SKIP ${d.sku} — in-flight SALE/VOID job present (rebase deferred)`);
        continue;
      }
      toApply.push(d);
    }

    if (toApply.length === 0) {
      console.log(
        `\n[trueup] APPLY — nothing to write (all ${heldInflight} drifted item(s) held by in-flight jobs).`
      );
      return;
    }

    await prisma.$transaction(async (tx) => {
      for (const d of toApply) {
        await tx.product.update({ where: { id: d.id }, data: { stock: d.expected } });
        await tx.stockMovement.create({
          data: {
            productId: d.id,
            type: "ADJUST",
            qty: d.delta, // signed rebase delta (expected - current)
            reference: `trueup:${today}`,
          },
        });
        console.log(`[trueup] APPLIED ${d.sku}: ${d.current} → ${d.expected} (Δ ${signed(d.delta)})`);
      }
    });

    console.log(
      `\n[trueup] APPLY done — ${toApply.length} rebased, ${heldInflight} held (in-flight). ` +
        `Reference: trueup:${today}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`[trueup] FAILED: ${err.message}`);
  process.exit(1);
});

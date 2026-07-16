// NODE-ONLY. KRS REALTIME inbound poll TRIGGER endpoint (krs-realtime-inbound P1, watermark
// variant).
//
// POST /api/krs/rt-poll — the ~2-second realtime stock-sync trigger. Called by the
// krs-rt-poll sidecar in docker-compose.prod.yml on a tight interval, NOT by a browser. It
// uses MACHINE-TO-MACHINE bearer auth (KRS_RT_POLL_SECRET), NOT the NextAuth session — the
// bearer secret IS the authentication (mirrors POST /api/krs/auto-sync exactly).
//
// ── THE HOT PATH IS CHEAP (the whole point) ────────────────────────────────────────────
// The common outcome, every 2s, is "nothing moved". That path costs exactly ONE mssql
// round-trip (the 4-aggregate watermark probe) + one Postgres READ (the cursor row) and
// ZERO Postgres writes: probe → compare to the stored cursor → `{ changed: false }`. The
// probe runs on a MODULE-LEVEL REUSED pool (watermark.ts) so it pays no connection
// handshake. The run-lock and any Postgres write are taken ONLY when a watermark actually
// advanced, so idle ticks never contend for the lock or write a row (see the ordering note
// on the run-lock below).
//
// ── WHEN SOMETHING MOVED ───────────────────────────────────────────────────────────────
// A probe watermark strictly past the cursor → resolve the changed (item, warehouse) pairs
// + any new product codes → (import new products if the item-master watermark moved) →
// reconcileStock(scope = the changed itemCodes) → advance the cursor ONLY after success.
// reconcileStock owns the SHARED run-lock; if the ≤60s safety-net sweep (or an overlapping
// tick) already holds it, reconcileStock returns SKIPPED_LOCKED and this tick does NOT
// advance the cursor (the change is retried next tick — idempotent). This is how
// overlapping ticks SKIP rather than STACK, without the hot path paying for a lock.
//
// ── FAIL-OPEN (invariant) ──────────────────────────────────────────────────────────────
// Every KRS-side fault is caught, sanitized (never the raw mssql error/config), the shared
// pool is reset so the next cycle reconnects cleanly, and a structured non-2xx is returned.
// The cursor is NOT advanced on failure (the next cycle retries from the last good cursor).
// This route NEVER throws further and NEVER touches checkout.

import { NextResponse } from "next/server";
import { buildConnectionConfig } from "@/lib/krs/client";
import { KrsKeyError } from "@/lib/krs/crypto";
import { bearerMatches } from "@/lib/krs/bearerAuth";
import {
  acquireKrsPool,
  resetKrsPool,
  probeWatermarks,
  fetchChangedDocs,
  fetchChangedItems,
} from "@/lib/krs/watermark";
import {
  ZERO_CURSOR,
  isFreshCursor,
  watermarksAdvanced,
  itemMasterAdvanced,
  nextCursorFromProbe,
  collectItemCodes,
  collectWarehouseCodes,
  type WatermarkCursorState,
  type Watermarks,
} from "@/lib/krs/watermarkCursor";
import { reconcileStock, type ReconcileSummary } from "@/lib/krs/stockReconcile";
import { fetchKrsProducts } from "@/lib/krs/products";
import { importKrsProducts } from "@/lib/krs/importProducts";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";
import { publishKrsEvent } from "@/lib/krs/events";

/** Default branch stamped onto StockMovement rows via reconcileStock (single-store). */
const DEFAULT_BRANCH_ID = "BR-01";

/** The watermark cursor singleton id (mirrors ShopSettings / KrsConnectionSettings). */
const CURSOR_ID = "singleton";

/** A sanitized error message — never the raw mssql driver object/config. */
function safeErrMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}

/** Load the watermark cursor singleton as a pure `WatermarkCursorState` (ZERO on first
 *  run). A Postgres READ — allowed on the hot path (the "zero writes" rule is about writes). */
async function loadCursor(): Promise<WatermarkCursorState> {
  const row = await prisma.krsWatermarkCursor.findUnique({ where: { id: CURSOR_ID } });
  if (!row) return { ...ZERO_CURSOR };
  return {
    lastTxn: row.lastTxn,
    lastEntryAt: row.lastEntryAt,
    lastApprovedAt: row.lastApprovedAt,
    lastItemEntryAt: row.lastItemEntryAt,
  };
}

/** Advance + persist the cursor to the probe snapshot (never regressing). Called ONLY
 *  after a cycle fully applied. Stamps lastCycleAt for ops visibility. */
async function advanceCursor(cursor: WatermarkCursorState, probe: Watermarks): Promise<void> {
  const next = nextCursorFromProbe(cursor, probe);
  const data = {
    lastTxn: next.lastTxn,
    lastEntryAt: next.lastEntryAt,
    lastApprovedAt: next.lastApprovedAt,
    lastItemEntryAt: next.lastItemEntryAt,
    lastCycleAt: new Date(),
  };
  await prisma.krsWatermarkCursor.upsert({
    where: { id: CURSOR_ID },
    update: data,
    create: { id: CURSOR_ID, ...data },
  });
}

/** Run the (unchanged, unfiltered) product-import path so new/updated KRS items land as
 *  POS Product rows before their stock is reconciled. Returns the created count. Throws on
 *  a KRS read/upsert fault (the caller fails open, cursor not advanced). */
async function importProducts(config: Parameters<typeof reconcileStock>[0]): Promise<number> {
  const krsProducts = await fetchKrsProducts(config);
  const result = await importKrsProducts(krsProducts);
  return result.created;
}

export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
    // === STEP 1: Machine auth (bearer secret, timing-safe) — mirrors /api/krs/auto-sync ===
    const secret = env.KRS_RT_POLL_SECRET;
    if (!secret) {
      logger.warn("POST /api/krs/rt-poll: KRS_RT_POLL_SECRET not configured");
      return NextResponse.json(
        {
          error:
            "ยังไม่ได้ตั้งค่า trigger secret บนเซิร์ฟเวอร์ · rt-poll trigger secret not configured",
          code: "RT_POLL_NOT_CONFIGURED",
        },
        { status: 503 }
      );
    }
    if (!bearerMatches(req.headers.get("authorization"), secret)) {
      return NextResponse.json(
        { error: "Unauthorized", code: "UNAUTHENTICATED" },
        { status: 401 }
      );
    }

    // === STEP 2: Kill switch (opt-in; safe default off) ===
    if (env.KRS_RT_POLL_ENABLED !== "true") {
      return NextResponse.json(
        {
          error:
            "ปิดการซิงค์เรียลไทม์อยู่ (KRS_RT_POLL_ENABLED=false) · KRS realtime poll is disabled",
          code: "RT_POLL_DISABLED",
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
        logger.error({ err }, "POST /api/krs/rt-poll: KRS encryption key missing/invalid");
        return NextResponse.json(
          {
            error:
              "ยังไม่ได้ตั้งค่า KRS_CONFIG_ENC_KEY บนเซิร์ฟเวอร์ · server encryption key missing",
            code: "KRS_KEY_MISSING",
          },
          { status: 500 }
        );
      }
      logger.error({ err }, "POST /api/krs/rt-poll failed (config)");
      return NextResponse.json(
        { error: "ซิงค์เรียลไทม์ไม่สำเร็จ · could not run rt-poll", code: "INTERNAL" },
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

    // === STEP 4: Poll cycle (fail-open around everything KRS-side) ===
    const startedAt = Date.now();
    try {
      // Reused module-level pool → the hot path pays no handshake.
      const pool = await acquireKrsPool(config);
      // (a) The single cheap probe — the ONE mssql round-trip on the hot path.
      const probe = await probeWatermarks(pool);
      // (b) Cursor read (Postgres READ; still zero WRITES on the hot path).
      const cursor = await loadCursor();

      // (c) Hot path: nothing moved → done, zero Postgres writes.
      if (!watermarksAdvanced(cursor, probe)) {
        return NextResponse.json({ ok: true, changed: false });
      }

      // (d) Something moved. Resolve scope + optionally import new products.
      const fresh = isFreshCursor(cursor);
      let summary: ReconcileSummary | null = null;
      let newProducts = 0;
      let warehousesTouched: string[] = [];
      let itemCodes: string[] = [];

      if (fresh) {
        // First run / retention re-init: establish baselines from the whole catalogue.
        newProducts = await importProducts(config);
        summary = await reconcileStock(config, "ALL", { branchId: DEFAULT_BRANCH_ID });
        warehousesTouched = summary.warehouses;
      } else {
        const pairs = await fetchChangedDocs(pool, cursor);
        if (itemMasterAdvanced(cursor, probe)) {
          // A NEW product-master row exists → import (unfiltered, per plan) so the new
          // items have POS Product rows before reconcile; fold their codes into the scope.
          const changedItems = await fetchChangedItems(pool, cursor);
          newProducts = await importProducts(config);
          itemCodes = collectItemCodes(pairs, changedItems);
        } else {
          itemCodes = collectItemCodes(pairs);
        }
        warehousesTouched = collectWarehouseCodes(pairs);
        if (itemCodes.length > 0) {
          summary = await reconcileStock(config, { itemCodes }, { branchId: DEFAULT_BRANCH_ID });
        }
      }

      // (e) If the shared lock was held (safety-net sweep or an overlapping tick), do NOT
      // advance the cursor — retry from the same cursor next tick (idempotent).
      if (summary && summary.status === "SKIPPED_LOCKED") {
        logger.info({ krsRtPoll: { changed: true, skipped: "locked" } }, "KRS rt-poll skipped (lock held)");
        return NextResponse.json({ ok: true, changed: true, skipped: "locked" });
      }

      // (f) Advance the cursor to the probe snapshot (only after success).
      await advanceCursor(cursor, probe);

      const cycleMs = Date.now() - startedAt;
      const itemsTouched = summary?.itemsTouched ?? 0;
      const stockUpdated = summary?.stockUpdated ?? 0;
      logger.info(
        {
          krsRtPoll: {
            changed: true,
            reinit: fresh,
            itemsTouched,
            stockUpdated,
            newProducts,
            warehousesTouched: warehousesTouched.length,
            cycleMs,
          },
        },
        "KRS rt-poll completed"
      );

      // SSE (P2 wiring): announce the cycle + let clients refetch product master when new
      // items were imported. stock-update events are published INSIDE reconcileStock (the
      // engine is the single publish point for stock). Best-effort — never fails the cycle.
      publishKrsEvent({
        type: "sync-status",
        source: "rt-poll",
        at: new Date().toISOString(),
        itemsTouched,
      });
      if (newProducts > 0) {
        publishKrsEvent({ type: "product-update", skus: itemCodes });
      }

      return NextResponse.json({
        ok: true,
        changed: true,
        reinit: fresh,
        itemsTouched,
        stockUpdated,
        newProducts,
        warehousesTouched,
        cycleMs,
      });
    } catch (err) {
      // Any KRS-side fault (already sanitized inside the lib) or unexpected error: reset
      // the reused pool so the next cycle reconnects, log a generic boundary message, and
      // return a structured non-2xx. The cursor was NOT advanced → next cycle retries.
      await resetKrsPool();
      logger.error({ err: safeErrMsg(err) }, "POST /api/krs/rt-poll failed (cycle)");
      return NextResponse.json(
        { error: "ซิงค์เรียลไทม์ไม่สำเร็จ · could not run rt-poll", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

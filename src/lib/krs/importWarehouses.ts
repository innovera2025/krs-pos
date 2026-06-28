// NODE-ONLY. POS-side import of KRS warehouse records into the local Postgres
// (Branch/Warehouse program, Phase 1 — the inbound "pull warehouses" path).
// Imported only by Node-runtime server code (the /api/krs/pull-warehouses route) —
// NEVER from a client component, `src/auth.config.ts`, or `src/middleware.ts` (it
// pulls in the Prisma singleton).
//
// This is the POS-SIDE half of the inbound pull and is PURE relative to KRS: it
// takes already-fetched `KrsWarehouseRecord[]` (see `warehouses.ts`) and upserts
// them into the POS `Warehouse` master. It touches ONLY the POS Prisma datasource;
// it never opens an mssql connection.

import { prisma } from "@/lib/prisma";
import type { KrsWarehouseRecord } from "./warehouses";

/** Outcome of a warehouse import run — drives the route response. */
export type ImportWarehousesResult = {
  /** New POS Warehouses created (by warehouseCode). */
  created: number;
  /** Existing POS Warehouses updated (matched by warehouseCode). */
  updated: number;
  /** Total records upserted (created + updated). */
  total: number;
};

/**
 * Import KRS warehouse records into the POS `Warehouse` master.
 *
 * For each record, upsert the Warehouse by `warehouseCode` (the natural PK):
 *   - trim the fields defensively (the fetch already trims, but the importer is
 *     reusable and must not trust its input)
 *   - SKIP a record with a blank `warehouseCode` (cannot key the upsert)
 *   - CREATE: warehouseCode + warehouseName + branchCode
 *   - UPDATE: warehouseName + branchCode (the code is the immutable key)
 *
 * Counted by a per-record pre-check (warehouseCode) so the result reports
 * created vs updated; the upsert itself is still atomic. Returns { created,
 * updated, total }.
 */
export async function importKrsWarehouses(
  records: KrsWarehouseRecord[]
): Promise<ImportWarehousesResult> {
  let created = 0;
  let updated = 0;

  for (const rec of records) {
    const warehouseCode = rec.warehouseCode.trim();
    // No natural key → cannot upsert (Warehouse.warehouseCode is the required PK).
    if (warehouseCode.length === 0) continue;

    const warehouseName = rec.warehouseName.trim();
    const branchCode = rec.branchCode.trim();

    // Pre-check by the natural key so we can report created/updated; the upsert is
    // still atomic.
    const existing = await prisma.warehouse.findUnique({
      where: { warehouseCode },
      select: { warehouseCode: true },
    });

    await prisma.warehouse.upsert({
      where: { warehouseCode },
      update: {
        warehouseName,
        branchCode,
      },
      create: {
        warehouseCode,
        warehouseName,
        branchCode,
      },
      select: { warehouseCode: true },
    });

    if (existing) updated += 1;
    else created += 1;
  }

  return { created, updated, total: created + updated };
}

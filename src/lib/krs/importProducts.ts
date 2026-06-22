// NODE-ONLY. POS-side import of KRS product records into the local Postgres
// (krs-sync inbound "pull products" path). Imported only by Node-runtime server
// code (the /api/krs/pull-products route and the one-time import script) — NEVER
// from a client component, `src/auth.config.ts`, or `src/middleware.ts` (it pulls
// in the Prisma singleton).
//
// This is the POS-SIDE half of the inbound pull and is PURE relative to KRS: it
// takes already-fetched `KrsProductRecord[]` (see `products.ts`) and upserts them
// into POS `Category`/`Product`, so BOTH the API route and the one-time import
// script can reuse the SAME logic. It touches ONLY the POS Prisma datasource; it
// never opens an mssql connection.

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { KrsProductRecord } from "./products";

/** Outcome of an import run — drives the route response + the script's stdout. */
export type ImportProductsResult = {
  /** New POS Products created (by sku). */
  created: number;
  /** Existing POS Products updated (matched by sku). */
  updated: number;
  /** Records whose KRS barcode collided (with the batch or an existing row) and
   *  was therefore left NULL on the POS side so the `Product.barcode @unique`
   *  constraint never throws. */
  barcodeSkipped: number;
  /** New POS Categories created from distinct KRS `ItemTypename` values. */
  categories: number;
};

/**
 * Decimal(10,2) money bound: 99,999,999.99. Mirrors PRICE_MAX in
 * `src/lib/schemas/product.ts` and the checkout caps — a price that cannot fit the
 * column is CLAMPED to this max (never silently overflowing into a Prisma/Postgres
 * 500). Negative / non-finite prices clamp to 0 (handled below).
 */
const PRICE_MAX = 99_999_999.99;

/**
 * Render a KRS price (a JS number) as the EXACT 2dp Decimal STRING the
 * `Product.price` Decimal(10,2) column expects, bounded to the column range.
 *
 * Money-safe (mirrors orderSerialize/pricing): we go through integer satang so a
 * value like 19.99 becomes "19.99" with no float drift, and we clamp to
 * [0, PRICE_MAX] so an out-of-range KRS value can NEVER overflow the column (a
 * 500). A `Prisma.Decimal` is built from the clamped 2dp string.
 */
function toPriceDecimal(price: number): Prisma.Decimal {
  // Defensive: collapse non-finite / negative to 0 (fetch already does this, but
  // the importer is reusable and must not trust its input).
  const safe = Number.isFinite(price) && price > 0 ? price : 0;
  const clamped = Math.min(safe, PRICE_MAX);
  // Integer satang → exact 2dp string (no trailing-zero loss, no float drift).
  const satang = Math.round(clamped * 100);
  const str = (satang / 100).toFixed(2);
  return new Prisma.Decimal(str);
}

/**
 * Upsert distinct KRS category names (`ItemTypename`) into POS `Category` and
 * return a `name → id` map plus the count of newly created categories.
 *
 * `Category.name` is `@unique`, so we upsert each distinct name (create on miss,
 * no-op update on hit). We pre-load the existing names to count ONLY the genuinely
 * new ones for the result summary.
 */
async function upsertCategories(
  records: KrsProductRecord[]
): Promise<{ map: Map<string, string>; created: number }> {
  // Distinct, non-null category names from the batch.
  const names = Array.from(
    new Set(
      records
        .map((r) => r.categoryName)
        .filter((n): n is string => n !== null)
    )
  );

  const map = new Map<string, string>();
  if (names.length === 0) return { map, created: 0 };

  // Pre-load which of these names already exist so we can count only NEW creates.
  const existing = await prisma.category.findMany({
    where: { name: { in: names } },
    select: { name: true },
  });
  const existingNames = new Set(existing.map((c) => c.name));

  let created = 0;
  for (const name of names) {
    const cat = await prisma.category.upsert({
      where: { name },
      // Touch updatedAt only; the name is the unique key (nothing else to change).
      update: {},
      create: { name },
      select: { id: true, name: true },
    });
    map.set(cat.name, cat.id);
    if (!existingNames.has(name)) created += 1;
  }

  return { map, created };
}

/**
 * Import KRS product records into POS `Category`/`Product`.
 *
 * Order of operations:
 *  1. Upsert Categories by name → build a `name → id` map.
 *  2. Seed the in-memory "taken barcodes" set from existing POS rows that ALREADY
 *     hold any of the batch's barcodes (so we never collide with a barcode the DB
 *     already owns — including one owned by a DIFFERENT sku).
 *  3. For each record, upsert the Product by `sku`:
 *       - resolve `categoryId` from the map (null when the KRS category was blank)
 *       - resolve a SAFE barcode: assign it only if free (not already taken by the
 *         batch or an existing row that isn't this same sku); otherwise NULL and
 *         increment `barcodeSkipped`
 *       - CREATE: name/sku/price/barcode/isActive/categoryId + stock 0
 *       - UPDATE: name/price/barcode/isActive/categoryId (stock is POS-owned and
 *         intentionally left untouched)
 *
 * Barcode-unique handling (the `Product.barcode @unique` constraint): a barcode is
 * assigned to AT MOST ONE product. We track every barcode we have committed to
 * (seeded from existing rows + accumulated across the batch) keyed to the sku that
 * owns it; a record whose barcode is already owned by a DIFFERENT sku gets NULL +
 * a `barcodeSkipped` bump, so the unique index is never violated.
 *
 * Returns counts of { created, updated, barcodeSkipped, categories }.
 */
export async function importKrsProducts(
  records: KrsProductRecord[]
): Promise<ImportProductsResult> {
  // 1) Categories first.
  const { map: categoryByName, created: categories } =
    await upsertCategories(records);

  // 2) Seed the barcode owner-map from existing POS rows that already hold any of
  //    the batch's barcodes. Maps a barcode → the sku that currently owns it, so a
  //    barcode owned by a DIFFERENT product (or an existing row for the SAME sku)
  //    is handled correctly.
  const batchBarcodes = Array.from(
    new Set(
      records
        .map((r) => r.barcode)
        .filter((b): b is string => b !== null)
    )
  );
  // `barcodeOwner`: barcode → sku that holds it. Seeding from existing rows means a
  // re-import keeps a product's OWN barcode (same sku), and never steals a barcode
  // already owned by another sku.
  const barcodeOwner = new Map<string, string>();
  if (batchBarcodes.length > 0) {
    const existingWithBarcode = await prisma.product.findMany({
      where: { barcode: { in: batchBarcodes } },
      select: { sku: true, barcode: true },
    });
    for (const p of existingWithBarcode) {
      if (p.barcode !== null) barcodeOwner.set(p.barcode, p.sku);
    }
  }

  let created = 0;
  let updated = 0;
  let barcodeSkipped = 0;

  // 3) Upsert each product by sku.
  for (const rec of records) {
    const categoryId =
      rec.categoryName !== null
        ? categoryByName.get(rec.categoryName) ?? null
        : null;

    // Resolve a collision-safe barcode. A barcode is usable iff it is unowned, or
    // already owned by THIS sku (a re-import of the same product). Otherwise it is
    // owned by a different sku → drop to null and count the skip.
    let barcode: string | null = null;
    if (rec.barcode !== null) {
      const owner = barcodeOwner.get(rec.barcode);
      if (owner === undefined || owner === rec.sku) {
        barcode = rec.barcode;
        // Claim it for this sku so a later record in the same batch carrying the
        // same barcode is treated as a collision (NULL + skipped).
        barcodeOwner.set(rec.barcode, rec.sku);
      } else {
        barcodeSkipped += 1;
      }
    }

    const price = toPriceDecimal(rec.price);

    // Detect create vs update for the counters. We pre-check by sku (the natural
    // key) so we can report created/updated; the upsert is still atomic.
    const existing = await prisma.product.findUnique({
      where: { sku: rec.sku },
      select: { id: true },
    });

    await prisma.product.upsert({
      where: { sku: rec.sku },
      update: {
        name: rec.name,
        price,
        barcode,
        isActive: rec.isActive,
        categoryId,
        // stock is POS-owned going forward — NOT touched on update.
      },
      create: {
        sku: rec.sku,
        name: rec.name,
        price,
        barcode,
        isActive: rec.isActive,
        categoryId,
        stock: 0,
      },
      select: { id: true },
    });

    if (existing) updated += 1;
    else created += 1;
  }

  return { created, updated, barcodeSkipped, categories };
}

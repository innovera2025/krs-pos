#!/usr/bin/env node
// =============================================================================
// KRS POS — ghost product CLEANUP (WRITES to POS Postgres; KRS stays read-only)
// =============================================================================
// Deactivates POS products that no longer exist in the KRS master (deleted
// ItemCodes) and frees their barcodes so the REAL KRS items claim them on the
// next product-import cycle (holder-wins seeding reads current DB owners).
//
// SAFETY GUARDS (any failure → NO writes at all):
//   1. KRS fetch sanity: the live ItemCode list must be reasonably large
//      (>= 60% of current POS active count) — a partial/failed fetch must
//      never mass-deactivate the catalogue (fail-open discipline).
//   2. Only ghosts with stock == 0 are touched; if ANY ghost holds stock the
//      script aborts and prints them for manual review.
//   3. Single Prisma transaction; prints per-row actions before committing.
//   4. Re-runnable/idempotent (second run finds 0 ghosts).
//
// Run AFTER a fresh `sh scripts/backup.sh` (migrate-image pattern):
//   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
//     -v ~/krs-pos/scripts/krs-ghost-products-cleanup.cjs:/q.cjs:ro \
//     -e NODE_PATH=/app/node_modules -e DATABASE_URL="$DATABASE_URL" \
//     -e KRS_CONFIG_ENC_KEY="$KRS_CONFIG_ENC_KEY" migrate node /q.cjs
// =============================================================================

const { createDecipheriv } = require("crypto");

function decryptPassword(blob) {
  const raw = process.env.KRS_CONFIG_ENC_KEY;
  if (!raw) throw new Error("KRS_CONFIG_ENC_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("KRS_CONFIG_ENC_KEY must be 32 bytes (base64)");
  const [version, ivHex, tagHex, ctHex] = String(blob).split(":");
  if (version !== "v1" || !ivHex || !tagHex || !ctHex) throw new Error("bad blob format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAAD(Buffer.from("krs.connection.password.v1"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString("utf8");
}

async function main() {
  const { PrismaClient } = require("@prisma/client");
  const sql = require("mssql");
  const prisma = new PrismaClient();
  const s = await prisma.krsConnectionSettings.findUnique({ where: { id: "singleton" } });
  if (!s || !s.encryptedPassword) throw new Error("KrsConnectionSettings singleton missing/incomplete");

  console.log(`[cleanup] KRS: ${s.host}:${s.port} db=${s.database} (read-only side)`);
  const pool = await sql.connect({
    server: s.host,
    port: s.port,
    database: s.database,
    user: s.username,
    password: decryptPassword(s.encryptedPassword),
    options: { encrypt: s.ssl, trustServerCertificate: s.trustServerCert },
    connectionTimeout: 15000,
    requestTimeout: 60000,
  });

  const krs = await pool.request().query(
    "SELECT ItemCode FROM dbo.InventoryItem WHERE ItemCode IS NOT NULL;"
  );
  await pool.close();
  const krsCodes = new Set(krs.recordset.map((r) => String(r.ItemCode).trim()));

  const active = await prisma.product.findMany({
    where: { isActive: true },
    select: { id: true, sku: true, name: true, barcode: true, stock: true },
  });

  // GUARD 1: fetch sanity — never mass-deactivate on a suspiciously small list.
  if (krsCodes.size < active.length * 0.6) {
    throw new Error(
      `KRS list suspiciously small (${krsCodes.size} vs POS active ${active.length}) — aborting, nothing written`
    );
  }

  const ghosts = active.filter((p) => !krsCodes.has(p.sku.trim()));
  console.log(`[cleanup] KRS codes=${krsCodes.size}, POS active=${active.length}, ghosts=${ghosts.length}`);

  // GUARD 2: any ghost holding stock → abort for manual review.
  const stocked = ghosts.filter((g) => g.stock > 0);
  if (stocked.length > 0) {
    console.log("[cleanup] ABORT — ghosts holding stock (review manually):");
    for (const g of stocked) console.log(JSON.stringify(g));
    throw new Error(`${stocked.length} ghost(s) hold stock — nothing written`);
  }

  if (ghosts.length === 0) {
    console.log("[cleanup] no ghosts — nothing to do");
    await prisma.$disconnect();
    return;
  }

  for (const g of ghosts) {
    console.log(
      `[cleanup] deactivate ${g.sku}${g.barcode ? ` (free barcode ${g.barcode})` : ""} — ${g.name}`
    );
  }

  const ids = ghosts.map((g) => g.id);
  const result = await prisma.$transaction(async (tx) => {
    return tx.product.updateMany({
      where: { id: { in: ids }, isActive: true, stock: 0 },
      data: { isActive: false, barcode: null },
    });
  });

  console.log(`\n[cleanup] DONE — deactivated ${result.count} ghost products, freed their barcodes.`);
  console.log(
    "[cleanup] the next product-import cycle (~1 min) will re-claim freed barcodes onto the live KRS items."
  );
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(`[cleanup] FAILED: ${err.message}`);
  process.exit(1);
});

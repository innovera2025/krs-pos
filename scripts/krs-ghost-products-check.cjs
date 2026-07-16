#!/usr/bin/env node
// =============================================================================
// KRS POS — ghost product check: POS rows absent from KRS master (READ-ONLY)
// =============================================================================
// The KRS master deletes obsolete ItemCodes, but the POS import only ever
// creates/updates by sku — deleted KRS items therefore live on in POS as
// sellable "ghosts" (the duplicate-card incident, 17-07-26). This script diffs
// POS active products against the live KRS InventoryItem list.
// READ-ONLY on both sides.
//
// Run (migrate-image pattern):
//   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
//     -v ~/krs-pos/scripts/krs-ghost-products-check.cjs:/q.cjs:ro \
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

  console.log(`[ghost] target: ${s.host}:${s.port} db=${s.database} (read-only)`);
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

  // 1) Live KRS ItemCode set
  const krs = await pool.request().query(
    "SELECT ItemCode FROM dbo.InventoryItem WHERE ItemCode IS NOT NULL;"
  );
  const krsCodes = new Set(krs.recordset.map((r) => String(r.ItemCode).trim()));
  console.log(`[ghost] KRS InventoryItem codes: ${krsCodes.size}`);

  // 2) POS active products
  const pos = await prisma.product.findMany({
    where: { isActive: true },
    select: { sku: true, name: true, barcode: true, stock: true },
    orderBy: { sku: "asc" },
  });
  console.log(`[ghost] POS active products: ${pos.length}`);

  // 3) Diff
  const ghosts = pos.filter((p) => !krsCodes.has(p.sku.trim()));
  const withStock = ghosts.filter((g) => g.stock > 0);
  const withBarcode = ghosts.filter((g) => g.barcode !== null);
  console.log(`\n=== GHOSTS (active in POS, absent from KRS master): ${ghosts.length} ===`);
  console.log(`  - holding stock > 0: ${withStock.length}`);
  console.log(`  - holding a barcode: ${withBarcode.length}`);
  console.log(`\n--- ghosts with stock (sellable — highest risk) ---`);
  for (const g of withStock) console.log(JSON.stringify(g));
  console.log(`\n--- first 40 ghosts overall ---`);
  for (const g of ghosts.slice(0, 40)) console.log(JSON.stringify(g));

  await prisma.$disconnect();
  await pool.close();
  console.log("\n[ghost] done (read-only, no changes made)");
}

main().catch((err) => {
  console.error(`[ghost] FAILED: ${err.message}`);
  process.exit(1);
});

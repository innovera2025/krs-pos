#!/usr/bin/env node
// =============================================================================
// KRS POS — duplicate item-master check on the KRS side (READ-ONLY)       [ops]
// =============================================================================
// Same queries as the SSMS script handed to the KRS team (17-07-26): barcodes
// shared by multiple ItemCodes, names shared by multiple ItemCodes, and counts.
// "hasMovement" (InventoryFlowDtl exists) marks the code the master should keep.
//
// Run (migrate-image pattern):
//   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
//     -v ~/krs-pos/scripts/krs-dup-items-check.cjs:/q.cjs:ro \
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
  await prisma.$disconnect();
  if (!s || !s.encryptedPassword) throw new Error("KrsConnectionSettings singleton missing/incomplete");

  console.log(`[dup] target: ${s.host}:${s.port} db=${s.database} (read-only)`);
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

  const q = async (label, text) => {
    try {
      const r = await pool.request().query(text);
      console.log(`\n=== ${label} (${(r.recordset ?? []).length} rows) ===`);
      for (const row of r.recordset ?? []) console.log(JSON.stringify(row));
    } catch (err) {
      console.log(`\n=== ${label} === ERROR: ${err.message}`);
    }
  };

  await q("A. Same barcode on multiple ItemCodes", `
    SELECT i.BarCode, i.ItemCode, i.ItemName, i.IsActive,
           CASE WHEN EXISTS (SELECT 1 FROM dbo.InventoryFlowDtl d WHERE d.ItemCode = i.ItemCode)
                THEN 'Y' ELSE 'N' END AS hasMovement
    FROM dbo.InventoryItem i
    WHERE i.BarCode IS NOT NULL AND LTRIM(RTRIM(i.BarCode)) <> ''
      AND i.BarCode IN (SELECT BarCode FROM dbo.InventoryItem
                        WHERE BarCode IS NOT NULL AND LTRIM(RTRIM(BarCode)) <> ''
                        GROUP BY BarCode HAVING COUNT(*) > 1)
    ORDER BY i.BarCode, i.ItemCode;`);

  await q("B. Same name on multiple ItemCodes", `
    SELECT i.ItemName, i.ItemCode, i.BarCode, i.IsActive,
           CASE WHEN EXISTS (SELECT 1 FROM dbo.InventoryFlowDtl d WHERE d.ItemCode = i.ItemCode)
                THEN 'Y' ELSE 'N' END AS hasMovement
    FROM dbo.InventoryItem i
    WHERE i.ItemName IN (SELECT ItemName FROM dbo.InventoryItem
                         GROUP BY ItemName HAVING COUNT(*) > 1)
    ORDER BY i.ItemName, i.ItemCode;`);

  await q("C. Counts", `
    SELECT
      (SELECT COUNT(*) FROM (SELECT BarCode FROM dbo.InventoryItem
         WHERE BarCode IS NOT NULL AND LTRIM(RTRIM(BarCode)) <> ''
         GROUP BY BarCode HAVING COUNT(*) > 1) x) AS dupBarcodeGroups,
      (SELECT COUNT(*) FROM (SELECT ItemName FROM dbo.InventoryItem
         GROUP BY ItemName HAVING COUNT(*) > 1) y) AS dupNameGroups;`);

  await pool.close();
  console.log("\n[dup] done (read-only, no changes made)");
}

main().catch((err) => {
  console.error(`[dup] FAILED: ${err.message}`);
  process.exit(1);
});

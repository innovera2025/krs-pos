#!/usr/bin/env node
// =============================================================================
// KRS POS — watermark discovery (P0 addendum, READ-ONLY)                  [ops]
// =============================================================================
// Vendor-free realtime variant: discovers whether the 3 inventory tables carry
// usable change signals WITHOUT Change Tracking:
//   1. datetime-ish columns (EditDate etc.) per table + their MAX (used or dead?)
//   2. current MAX(TransactionNo) watermarks on InventoryFlowHdr/Dtl
//   3. row counts (query-cost context)
// READ-ONLY: INFORMATION_SCHEMA + SELECT MAX/COUNT only. No writes, no DDL.
//
// Run (same pattern as krs-ct-precheck.cjs — migrate image has full deps):
//   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
//     -v ~/krs-pos/scripts/krs-watermark-discovery.cjs:/wm.cjs:ro \
//     -e NODE_PATH=/app/node_modules -e DATABASE_URL="$DATABASE_URL" \
//     -e KRS_CONFIG_ENC_KEY="$KRS_CONFIG_ENC_KEY" migrate node /wm.cjs
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

const TABLES = ["InventoryFlowHdr", "InventoryFlowDtl", "InventoryItem"];
// Identifier allowlist — column names are interpolated into SELECT MAX() below,
// so refuse anything that is not a plain identifier (defense-in-depth; the
// source is INFORMATION_SCHEMA on a server we treat as untrusted input).
const IDENT_RE = /^[A-Za-z0-9_]+$/;

async function main() {
  const { PrismaClient } = require("@prisma/client");
  const sql = require("mssql");
  const prisma = new PrismaClient();
  const s = await prisma.krsConnectionSettings.findUnique({ where: { id: "singleton" } });
  await prisma.$disconnect();
  if (!s || !s.encryptedPassword) throw new Error("KrsConnectionSettings singleton missing/incomplete");

  console.log(`[wm] target: ${s.host}:${s.port} db=${s.database} (read-only)`);
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

  // 1. datetime-ish columns per table + column totals
  const cols = await pool.request().query(`
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME IN ('${TABLES.join("','")}')
    ORDER BY TABLE_NAME, ORDINAL_POSITION;`);
  const byTable = {};
  for (const r of cols.recordset) {
    byTable[r.TABLE_NAME] = byTable[r.TABLE_NAME] || { total: 0, datetimeCols: [] };
    byTable[r.TABLE_NAME].total += 1;
    if (/date|time/i.test(r.DATA_TYPE)) byTable[r.TABLE_NAME].datetimeCols.push(r.COLUMN_NAME);
  }
  console.log("\n=== 1. Column inventory ===");
  for (const t of TABLES) {
    const info = byTable[t] || { total: 0, datetimeCols: [] };
    console.log(`${t}: ${info.total} columns; datetime-ish: [${info.datetimeCols.join(", ")}]`);
  }

  // 2. MAX of every datetime-ish column (is it populated/recent?)
  console.log("\n=== 2. MAX of datetime columns (populated? recent?) ===");
  for (const t of TABLES) {
    for (const c of (byTable[t] ? byTable[t].datetimeCols : [])) {
      if (!IDENT_RE.test(t) || !IDENT_RE.test(c)) { console.log(`${t}.${c}: SKIPPED (non-plain identifier)`); continue; }
      try {
        const r = await pool.request().query(`SELECT MAX([${c}]) AS mx FROM dbo.[${t}];`);
        console.log(`${t}.${c}: MAX = ${r.recordset[0].mx}`);
      } catch (err) {
        console.log(`${t}.${c}: ERROR ${err.message}`);
      }
    }
  }

  // 3. Watermarks + row counts
  console.log("\n=== 3. Watermarks + row counts ===");
  const wm = await pool.request().query(`
    SELECT 'InventoryFlowHdr' AS t, COUNT(*) AS rows, MAX(TransactionNo) AS maxTxn FROM dbo.InventoryFlowHdr
    UNION ALL
    SELECT 'InventoryFlowDtl', COUNT(*), MAX(TransactionNo) FROM dbo.InventoryFlowDtl
    UNION ALL
    SELECT 'InventoryItem', COUNT(*), NULL FROM dbo.InventoryItem;`);
  console.log(JSON.stringify(wm.recordset, null, 1));

  await pool.close();
  console.log("\n[wm] done (read-only, no changes made)");
}

main().catch((err) => {
  console.error(`[wm] FAILED: ${err.message}`);
  process.exit(1);
});

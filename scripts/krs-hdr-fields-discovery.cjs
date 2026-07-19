#!/usr/bin/env node
// =============================================================================
// KRS POS — SalesInvoiceHdr Receipt_Type/PosBillNo discovery (READ-ONLY)  [ops]
// =============================================================================
// Vendor asked the cash-sale INSERT to also carry Receipt_Type + PosBillNo, and
// (vendor answer 19-07-26) the discount split writes SalesInvoiceHdr.DiscountAmount
// (bill-level) + SalesInvoiceDtl.DiscountAmount (line-level). Before writing anything
// we discover: do the columns exist (type/nullable) — the deploy gate verifies
// Hdr.DiscountAmount exists KRS-side — what Receipt_Type values existing rows use, and
// a sample of recent rows. READ-ONLY: INFORMATION_SCHEMA + SELECT only.
//
// ⚠️ DEPLOY GATE (VOID writeback, 19-07-26 vendor revision): the cash-sale INSERT now
// ALSO stamps PosBillNo on TheJournal + SalePurchaseTax (so the cancel path can target
// WHERE PosBillNo). Query (1) below verifies BOTH new columns exist in live KRS. If
// either is MISSING, DO NOT deploy the writeback INSERT change — every sale INSERT would
// fail (column not found). Sequence: pull → run THIS discovery → only then build/up.
//
// Run (same migrate-image pattern as krs-ct-precheck.cjs):
//   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
//     -v ~/krs-pos/scripts/krs-hdr-fields-discovery.cjs:/q.cjs:ro \
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

  console.log(`[hdr] target: ${s.host}:${s.port} db=${s.database} (read-only)`);
  const pool = await sql.connect({
    server: s.host,
    port: s.port,
    database: s.database,
    user: s.username,
    password: decryptPassword(s.encryptedPassword),
    options: { encrypt: s.ssl, trustServerCertificate: s.trustServerCert },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  });

  const q = async (label, text) => {
    try {
      const r = await pool.request().query(text);
      console.log(`\n=== ${label} ===`);
      console.log(JSON.stringify(r.recordset ?? [], null, 1));
    } catch (err) {
      console.log(`\n=== ${label} === ERROR: ${err.message}`);
    }
  };

  await q("1. Columns exist? (type/nullable/default) — DEPLOY GATE for TheJournal.PosBillNo + SalePurchaseTax.PosBillNo", `
    SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = 'dbo'
      AND TABLE_NAME IN ('SalesInvoiceHdr', 'InventoryFlowHdr', 'TheJournal', 'SalePurchaseTax')
      AND COLUMN_NAME IN ('PosBillNo', 'DiscountAmount', 'Receipt_Type', 'IsClosed')
    ORDER BY TABLE_NAME, COLUMN_NAME;`);
  await q("2. Receipt_Type values in existing rows", `
    SELECT Receipt_Type, COUNT(*) AS n
    FROM dbo.SalesInvoiceHdr GROUP BY Receipt_Type ORDER BY n DESC;`);
  await q("3. Recent rows (traceability sample)", `
    SELECT TOP 6 TransactionNo, VoucherNo, Receipt_Type, PosBillNo, TotalAmount, EntryDate
    FROM dbo.SalesInvoiceHdr ORDER BY TransactionNo DESC;`);

  await pool.close();
  console.log("\n[hdr] done (read-only, no changes made)");
}

main().catch((err) => {
  console.error(`[hdr] FAILED: ${err.message}`);
  process.exit(1);
});

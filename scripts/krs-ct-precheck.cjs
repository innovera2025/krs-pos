#!/usr/bin/env node
// =============================================================================
// KRS POS — Change Tracking pre-check (P0.1, READ-ONLY)                   [ops]
// =============================================================================
// Runs the P0.1 discovery queries from
// process/features/krs-sync/active/krs-realtime-inbound_PLAN_16-07-26.md
// against the live KRS SQL Server, using the SAME connection settings the app
// uses (KrsConnectionSettings singleton + KRS_CONFIG_ENC_KEY decryption).
//
// READ-ONLY: SERVERPROPERTY / DATABASEPROPERTYEX / sys.change_tracking_* /
// INFORMATION_SCHEMA / sp_spaceused. No INSERT/UPDATE/DELETE/DDL of any kind.
//
// Where to run: inside the app container on the VPS (it has the network path,
// the env key, node_modules with mssql + @prisma/client, and DB access):
//   docker cp scripts/krs-ct-precheck.cjs krs-pos-app:/tmp/
//   docker exec krs-pos-app node /tmp/krs-ct-precheck.cjs
//
// Output: never prints username/password. Host/database only (already public
// in the krs-sync discovery docs).
// =============================================================================

const { createDecipheriv } = require("crypto");

// --- password decrypt (mirrors src/lib/krs/crypto.ts: v1:<ivHex>:<tagHex>:<ctHex>,
// --- AES-256-GCM, key = base64 32 bytes, AAD binds blob to the password slot)
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

  console.log(`[precheck] target: ${s.host}:${s.port} db=${s.database} (read-only)`);
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
      // sp_spaceused returns multiple recordsets
      const sets = r.recordsets && r.recordsets.length ? r.recordsets : [r.recordset || []];
      for (const set of sets) console.log(JSON.stringify(set, null, 1));
    } catch (err) {
      console.log(`\n=== ${label} === ERROR: ${err.message}`);
    }
  };

  await q("1. Edition", "SELECT SERVERPROPERTY('Edition') AS Edition, SERVERPROPERTY('EngineEdition') AS EngineEdition, SERVERPROPERTY('ProductVersion') AS ProductVersion;");
  await q("2a. DB CT enabled?", "SELECT DATABASEPROPERTYEX(DB_NAME(), 'IsChangeTrackingEnabled') AS DbCtEnabled;");
  await q("2b. CT database config", "SELECT database_id, is_auto_cleanup_on, retention_period, retention_period_units_desc FROM sys.change_tracking_databases WHERE database_id = DB_ID();");
  await q("2c. CT tables already tracked", "SELECT OBJECT_NAME(object_id) AS table_name, is_track_columns_updated_on FROM sys.change_tracking_tables;");
  await q("3. PK check (all 3 tables MUST appear)", `
    SELECT tc.TABLE_SCHEMA, tc.TABLE_NAME, kcu.COLUMN_NAME, kcu.ORDINAL_POSITION
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
    JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
      ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
    WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      AND tc.TABLE_NAME IN ('InventoryFlowDtl', 'InventoryFlowHdr', 'InventoryItem')
    ORDER BY tc.TABLE_NAME, kcu.ORDINAL_POSITION;`);
  await q("4. Space used (Express 10GB cap headroom)", "EXEC sp_spaceused;");

  await pool.close();
  console.log("\n[precheck] done (read-only, no changes made)");
}

main().catch((err) => {
  console.error(`[precheck] FAILED: ${err.message}`);
  process.exit(1);
});

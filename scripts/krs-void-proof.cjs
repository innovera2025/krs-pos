#!/usr/bin/env node
// =============================================================================
// KRS POS — VOID (cancel) writeback proof (READ-ONLY)  [ops]
// =============================================================================
// Verifies the vendor-confirmed 4-UPDATE soft-cancel (19-07-26) on real voided bills:
//   • SalesInvoiceHdr.IsClosed = 1  (bill closed)
//   • SalePurchaseTax.IsClosed = 0  (vendor-confirmed asymmetry — NOT 1)
//   • TheJournal.IsClosed = 1 on all (expected 3) rows for the voucher
//   • InventoryFlowHdr.IsClosed = 1 with a non-null IsClosedBy / IsClosedDate
// Prints an OK/FAIL verdict per bill. READ-ONLY: SELECT only, makes NO changes.
//
// Bills to check = argv PosBillNo(s), else the most recent SYNCED VOID SyncJobs (their
// `ref` = orderNumber = KRS PosBillNo). Targets the LIVE KrsConnectionSettings singleton
// (same server the vendor demonstrated writes against), NOT KRS_SANDBOX_* — matching
// scripts/krs-discount-proof.cjs.
//
// Run (same migrate-image pattern as krs-discount-proof.cjs):
//   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
//     -v ~/krs-pos/scripts/krs-void-proof.cjs:/q.cjs:ro \
//     -e NODE_PATH=/app/node_modules -e DATABASE_URL="$DATABASE_URL" \
//     -e KRS_CONFIG_ENC_KEY="$KRS_CONFIG_ENC_KEY" migrate node /q.cjs [PosBillNo ...]
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

  // Bills to check: argv PosBillNo(s), else the most recent SYNCED VOID SyncJobs.
  let bills = process.argv.slice(2).filter((a) => a && !a.startsWith("-"));
  if (bills.length === 0) {
    const jobs = await prisma.syncJob.findMany({
      where: { type: "VOID", status: "SYNCED" },
      orderBy: { updatedAt: "desc" },
      take: 30,
      select: { ref: true },
    });
    bills = jobs.map((j) => j.ref).filter(Boolean);
  }

  const s = await prisma.krsConnectionSettings.findUnique({ where: { id: "singleton" } });
  await prisma.$disconnect();
  if (!s || !s.encryptedPassword) throw new Error("KrsConnectionSettings singleton missing/incomplete");
  if (bills.length === 0) {
    console.log("[void-proof] no VOID bills to check (pass a PosBillNo arg, or run after a synced void)");
    return;
  }

  console.log(`[void-proof] target: ${s.host}:${s.port} db=${s.database} (read-only)`);
  console.log(`[void-proof] checking ${bills.length} bill(s)\n`);

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

  let fail = 0;
  let missing = 0;
  for (const ref of bills) {
    const hdr = await pool.request().input("ref", sql.NVarChar(30), ref).query(
      `SELECT h.VoucherNo, h.IsClosed AS HdrIsClosed FROM dbo.SalesInvoiceHdr h WHERE h.PosBillNo = @ref;`
    );
    const flow = await pool.request().input("ref", sql.NVarChar(30), ref).query(
      `SELECT f.VoucherNo, f.IsClosed AS FlowIsClosed, f.IsClosedBy, f.IsClosedDate
         FROM dbo.InventoryFlowHdr f WHERE f.PosBillNo = @ref;`
    );

    const hdrRow = hdr.recordset[0];
    const flowRow = flow.recordset[0];
    if (!hdrRow || !flowRow) {
      missing++;
      console.log(`MISSING       ${String(ref).padEnd(19)} hdr=${hdrRow ? "y" : "n"} flow=${flowRow ? "y" : "n"} — no PosBillNo match in KRS`);
      continue;
    }

    const sc = hdrRow.VoucherNo;
    const tax = await pool.request().input("sc", sql.NVarChar, sc).query(
      `SELECT t.IsClosed AS TaxIsClosed FROM dbo.SalePurchaseTax t WHERE t.VoucherNo = @sc;`
    );
    const jnl = await pool.request().input("sc", sql.NVarChar, sc).query(
      `SELECT j.IsClosed AS JnlIsClosed, COUNT(*) AS Rows FROM dbo.TheJournal j
         WHERE j.VoucherNo = @sc GROUP BY j.IsClosed;`
    );

    const hdrClosed = Number(hdrRow.HdrIsClosed) === 1;
    // SalePurchaseTax must be IsClosed=0 (vendor-confirmed asymmetry). If no tax row
    // exists it's not the closed=0 state we assert, so treat absence as a FAIL signal.
    const taxRow = tax.recordset[0];
    const taxClosedZero = taxRow != null && Number(taxRow.IsClosed) === 0;
    // Every TheJournal group row must be IsClosed=1; sum the row counts for display.
    const jnlRows = jnl.recordset.reduce((n, r) => n + Number(r.Rows ?? 0), 0);
    const jnlAllClosed = jnl.recordset.length > 0 && jnl.recordset.every((r) => Number(r.JnlIsClosed) === 1);
    const flowClosed = Number(flowRow.FlowIsClosed) === 1;
    const flowByOk = flowRow.IsClosedBy != null && String(flowRow.IsClosedBy).length > 0;
    const flowDateOk = flowRow.IsClosedDate != null;

    const ok = hdrClosed && taxClosedZero && jnlAllClosed && flowClosed && flowByOk && flowDateOk;
    if (!ok) fail++;

    console.log(
      `${(ok ? "OK" : "FAIL").padEnd(13)} ${String(ref).padEnd(19)} sc=${sc} osl=${flowRow.VoucherNo} ` +
        `hdrClosed=${hdrClosed ? 1 : 0} taxClosed0=${taxClosedZero ? "y" : "n"} ` +
        `jnl=${jnlAllClosed ? "all1" : "MIXED"}(${jnlRows}) flowClosed=${flowClosed ? 1 : 0} ` +
        `by=${flowByOk ? "y" : "n"} date=${flowDateOk ? "y" : "n"}`
    );
  }

  console.log(
    `\n[void-proof] ${bills.length} bill(s) checked — ${missing} missing, ${fail} FAILED` +
      (fail === 0 && missing === 0 ? " — all voids closed as specified ✔" : " — INVESTIGATE THE ROWS ABOVE")
  );

  await pool.close();
  console.log("[void-proof] done (read-only, no changes made)");
}

main().catch((err) => {
  console.error(`[void-proof] FAILED: ${err.message}`);
  process.exit(1);
});

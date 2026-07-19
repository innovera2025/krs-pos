#!/usr/bin/env node
// =============================================================================
// KRS POS — discount writeback proof (READ-ONLY)  [ops]
// =============================================================================
// Verifies the vendor-confirmed discount split (19-07-26) on real written bills:
//   • Hdr.DiscountAmount = bill-level discount, Dtl.DiscountAmount = line-level,
//   • cross-doc identity Σ Dtl.Amount − Hdr.DiscountAmount == Hdr.TotalAmount.
// Lists every POS-written bill (PosBillNo IS NOT NULL) with the per-bill sums and
// an OK/FAIL verdict per identity. READ-ONLY: SELECT only.
//
// Run (same migrate-image pattern as krs-ct-precheck.cjs):
//   docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm --no-deps \
//     -v ~/krs-pos/scripts/krs-discount-proof.cjs:/q.cjs:ro \
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

// money columns come back as JS numbers; compare at satang resolution.
const sat = (v) => Math.round(Number(v ?? 0) * 100);

async function main() {
  const { PrismaClient } = require("@prisma/client");
  const sql = require("mssql");
  const prisma = new PrismaClient();
  const s = await prisma.krsConnectionSettings.findUnique({ where: { id: "singleton" } });
  await prisma.$disconnect();
  if (!s || !s.encryptedPassword) throw new Error("KrsConnectionSettings singleton missing/incomplete");

  console.log(`[proof] target: ${s.host}:${s.port} db=${s.database} (read-only)`);
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

  const r = await pool.request().query(`
    SELECT TOP 60 h.TransactionNo, h.VoucherNo, h.PosBillNo, h.Receipt_Type,
           h.TotalAmount, h.DiscountAmount AS HdrDisc, h.SubTotalAmnt, h.VATForValue, h.VATAmount,
           d.SumAmount, d.SumLineDisc, d.Lines, h.EntryDate
    FROM dbo.SalesInvoiceHdr h
    OUTER APPLY (
      SELECT SUM(Amount) AS SumAmount, SUM(DiscountAmount) AS SumLineDisc, COUNT(*) AS Lines
      FROM dbo.SalesInvoiceDtl WHERE TransactionNo = h.TransactionNo
    ) d
    WHERE h.PosBillNo IS NOT NULL
    ORDER BY h.TransactionNo DESC;`);

  let fail = 0;
  let discounted = 0;
  for (const row of r.recordset) {
    const total = sat(row.TotalAmount);
    const hdrDisc = sat(row.HdrDisc);
    const sumAmount = sat(row.SumAmount);
    const sumLineDisc = sat(row.SumLineDisc);
    const exVat = sat(row.SubTotalAmnt);
    const vat = sat(row.VATAmount);

    const identityOk = sumAmount - hdrDisc === total; // Σ Dtl.Amount − Hdr.DiscountAmount == TotalAmount
    const vatOk = exVat + vat === total; // net ex-VAT + VAT == net total (unchanged model)
    const hasDiscount = hdrDisc > 0 || sumLineDisc > 0;
    if (hasDiscount) discounted++;
    if (!identityOk || !vatOk) fail++;

    const tag = !identityOk ? "FAIL-IDENTITY" : !vatOk ? "FAIL-VAT" : hasDiscount ? "OK*disc" : "OK";
    console.log(
      `${tag.padEnd(13)} ${row.VoucherNo}  ${String(row.PosBillNo).padEnd(19)} ` +
        `total=${(total / 100).toFixed(2)} hdrDisc=${(hdrDisc / 100).toFixed(2)} ` +
        `ΣAmt=${(sumAmount / 100).toFixed(2)} ΣlineDisc=${(sumLineDisc / 100).toFixed(2)} ` +
        `exVat=${(exVat / 100).toFixed(2)} vat=${(vat / 100).toFixed(2)} lines=${row.Lines}`
    );
  }

  console.log(
    `\n[proof] ${r.recordset.length} POS bills checked — ${discounted} discounted, ${fail} FAILED` +
      (fail === 0 ? " — all identities hold ✔" : " — INVESTIGATE THE FAIL ROWS ABOVE")
  );

  await pool.close();
  console.log("[proof] done (read-only, no changes made)");
}

main().catch((err) => {
  console.error(`[proof] FAILED: ${err.message}`);
  process.exit(1);
});

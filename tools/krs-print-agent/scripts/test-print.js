'use strict';

// scripts/test-print.js — standalone owner test print (Phase B2 + B3 self-test).
//
// Run this ON THE SHOP WINDOWS PC with the XP-80C installed to print a sample
// receipt WITHOUT the web app or the HTTP server. Use it to iterate the Thai code
// table until the printed Thai is correct:
//
//   npm run test-print                         (default codepage 20)
//   set KRS_THAI_CODEPAGE=21 && npm run test-print   (Windows cmd — try 21, 18, 17)
//   $env:KRS_THAI_CODEPAGE=21; npm run test-print     (Windows PowerShell)
//   set KRS_BAHT_FALLBACK=1 && npm run test-print     (print "B" instead of ฿)
//   set KRS_PRINTER_NAME=XP-80C && npm run test-print (target a specific printer)
//
// On a non-Windows dev host the receipt bytes are still BUILT (so layout/encoding
// can be inspected) but cannot be spooled — the script reports that and dumps a byte
// count instead of failing hard.
//
// Phase B3: this same SAMPLE + runSelfTest() is REUSED by the packaged .exe via
// `krs-print-agent.exe --test` (index.js requires this module and calls runSelfTest
// instead of starting the HTTP server). So the owner can verify Thai + packaging on
// the printer with NO Node install and NO web app. The auto-run at the bottom only
// fires when this file is executed directly (`node scripts/test-print.js`).

const config = require('../config');
const { printReceipt, buildReceiptBuffer } = require('../printer');

// A realistic sample exercising every receipt section: Thai shop identity + TIN,
// phone/POS id, multi-line address, several items (including a long Thai product
// name that must truncate), split payment (cash + transfer) with change, and the
// tax-payer block. Shapes mirror ReceiptData { order, seller, sizeSettings }.
const SAMPLE = {
  order: {
    id: 'test-order-0001',
    orderNumber: 'POS-20260701-0042',
    accountingDocNo: null, // → "— รอออกเอกสาร —"
    createdAt: new Date().toISOString(),
    status: 'COMPLETED',
    paymentType: 'CASH',
    total: 1290.5,
    change: 209.5,
    taxRequested: true,
    cashier: { id: 'u-1', name: 'นิดา สายทอง' },
    items: [
      {
        id: 'it-1',
        quantity: 2,
        unitPrice: 120,
        lineTotal: 240,
        product: { id: 'p-1', name: 'กาแฟอเมริกาโน่เย็น', sku: 'DRK-001' },
      },
      {
        id: 'it-2',
        quantity: 1,
        unitPrice: 350.5,
        lineTotal: 350.5,
        product: {
          id: 'p-2',
          name: 'ชุดของขวัญพรีเมียมกล่องไม้สลักชื่อพร้อมริบบิ้นทองคำเปลว',
          sku: 'GFT-014',
        },
      },
      {
        id: 'it-3',
        quantity: 5,
        unitPrice: 140,
        lineTotal: 700,
        product: { id: 'p-3', name: 'ขนมไทยโบราณ (กล่อง)', sku: 'FOD-233' },
      },
    ],
    payments: [
      { id: 'pay-1', method: 'CASH', amount: 1000, reference: null },
      { id: 'pay-2', method: 'TRANSFER', amount: 500, reference: 'TRX-88213' },
    ],
    customer: {
      id: 'c-1',
      name: 'บริษัท กรุงเทพ ค้าปลีก จำกัด (สำนักงานใหญ่)',
      address: '99/1 ถนนสุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพฯ 10110',
      taxId: '0105558123456',
      phone: '021234567',
      buyerBranchCode: '00000',
      branchId: 'BR-01',
    },
  },
  seller: {
    sellerName: 'บริษัท เคอาร์เอส รีเทล จำกัด',
    sellerBranchLabel: 'สาขาสีลม · Silom Branch',
    sellerPhone: '02-987-6543',
    sellerPosId: 'POS-01',
    sellerAddress: '123 อาคารเคอาร์เอส ชั้น 5 ถนนสีลม แขวงสุริยวงศ์ เขตบางรัก กรุงเทพฯ 10500',
    sellerTaxId: '0105551234567',
    sellerBranchCode: '00001',
  },
  sizeSettings: null,
};

/**
 * Print the SAMPLE receipt once and report the outcome. Returns a process exit code
 * (0 = job submitted, 1 = could not print). Never throws — off-Windows and
 * printer-missing paths are handled and the built byte count is reported so the
 * layout/encoding can still be inspected. Shared by `npm run test-print` and by the
 * packaged .exe's `--test` / `--selftest` flag (see index.js).
 * @returns {Promise<number>} 0 on success, 1 on failure
 */
async function runSelfTest() {
  console.log(
    `[test-print] THAI_CODEPAGE=${config.THAI_CODEPAGE} ` +
      `PRINTER_NAME='${config.PRINTER_NAME || '(Windows default)'}' ` +
      `BAHT_FALLBACK=${config.BAHT_FALLBACK}`,
  );
  try {
    await printReceipt(SAMPLE);
    console.log('[test-print] job submitted — inspect the physical receipt on the XP-80C.');
    console.log(
      '[test-print] If Thai is garbled, rerun with KRS_THAI_CODEPAGE=21 (then 18, then 17).',
    );
    return 0;
  } catch (err) {
    console.error(`[test-print] could not print: ${err && err.message ? err.message : err}`);
    // Still prove the render path so layout/encoding can be inspected off-device.
    try {
      const buf = buildReceiptBuffer(SAMPLE);
      console.error(`[test-print] built ${buf.length} ESC/POS bytes (not sent).`);
    } catch (buildErr) {
      console.error(
        `[test-print] render also failed: ${
          buildErr && buildErr.message ? buildErr.message : buildErr
        }`,
      );
    }
    return 1;
  }
}

module.exports = { SAMPLE, runSelfTest };

// Auto-run only when executed directly (`node scripts/test-print.js` /
// `npm run test-print`). When index.js requires this module for `--test`, this guard
// prevents a second, unwanted run.
if (require.main === module) {
  runSelfTest().then((code) => {
    process.exitCode = code;
  });
}

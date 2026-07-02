'use strict';

// printer.js — ESC/POS receipt renderer for the KRS POS thermal receipt (Phase B2).
//
// Builds an 80mm / 48-column (Font A) ESC/POS byte stream that mirrors the web
// receipt (src/components/pos/ReceiptModal.tsx `.print-receipt`) and submits it to
// the shop's Windows printer. It is the real implementation behind POST
// /print-receipt (index.js) and behind `npm run test-print` (scripts/test-print.js).
//
// TWO responsibilities, kept separable:
//   1. BUILD  — `buildReceiptBuffer(receiptData)` returns the raw ESC/POS Buffer with
//               NO device involved. This is what the dry-run / test harness inspects.
//   2. SEND   — `printReceipt(receiptData)` builds, then spools the bytes to Windows.
//
// Thai encoding (the highest-risk item): the layout selects the printer's Thai code
// table with `ESC t <config.THAI_CODEPAGE>` and sends every Thai string as TIS-620
// bytes (see encoding.js). node-thermal-printer's `CharacterSet` enum has no Thai
// entry, so we do the code-table selection + encoding ourselves and hand the printer
// raw Buffers via `append()` — the library is used for buffer assembly + control
// codes (align/bold/cut) and as the `execute()` transport entry point.
//
// Transport note: the plan named node-thermal-printer's built-in `printer:` interface,
// but in v4.6.0 that requires a native (node-gyp) `printer` driver module — not
// installed and hostile to the Phase-B3 `pkg` single-exe build. To keep the agent
// dependency-light AND make `test-print` actually print, `execute()` is routed through
// an equivalent native-free Windows RAW spooler send (winspool via PowerShell). The
// call site the plan specified (`printer.execute()`) and the printer-name/default
// semantics are preserved.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ThermalPrinter, PrinterTypes } = require('node-thermal-printer');
const config = require('./config');
const { encodeThai, printWidth, truncateToWidth, moneyAgent } = require('./encoding');

// 80mm Font A = 48 columns. Fixed for the XP-80C at standard density.
const RECEIPT_WIDTH = 48;

/** Thrown for any receipt-render or spooler failure (index.js surfaces .message). */
class PrintError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrintError';
  }
}

// Thai payment-method labels — an EXACT copy of src/components/pos/paymentMeta.ts
// (the agent must not import the app's TS). Keys are lowercased before lookup.
const METHOD_LABELS = {
  cash: 'เงินสด',
  transfer: 'โอนเงิน',
  qr: 'QR PromptPay',
  card: 'บัตรเครดิต',
  ewallet: 'e-Wallet',
  other: 'อื่นๆ',
};

/** Thai label for a payment method key (defaults to the key for unknown values). */
function methodLabel(key) {
  const k = String(key == null ? '' : key).toLowerCase();
  return Object.prototype.hasOwnProperty.call(METHOD_LABELS, k) ? METHOD_LABELS[k] : k;
}

// Thai month abbreviations (th-TH short form) + Buddhist era, mirroring the web
// receipt's `formatDateTime` (toLocaleString('th-TH', ...)) deterministically so the
// agent does not depend on Node's ICU locale data or emit Thai digits.
const THAI_MONTHS_ABBR = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

/** Format an ISO string as "dd <thai-month> <BE year> HH:MM" (host-local time). */
function formatDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso == null ? '' : iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mon = THAI_MONTHS_ABBR[d.getMonth()];
  const be = d.getFullYear() + 543; // th-TH default calendar is Buddhist
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dd} ${mon} ${be} ${hh}:${mm}`;
}

/** Coerce to a trimmed string ('' for null/undefined). */
function s(x) {
  return x == null ? '' : String(x).trim();
}

/**
 * Build a fixed-width two-column line: `left` left-aligned (truncated with … if it
 * would collide with the value), `right` right-aligned, at least one space between.
 * Column math is in PRINT columns (Thai combining marks are zero-width).
 */
function rowLR(left, right, width) {
  const rightStr = String(right == null ? '' : right);
  const rw = printWidth(rightStr);
  const maxLeft = Math.max(1, width - rw - 1);
  const leftStr = truncateToWidth(s(left), maxLeft);
  const gap = Math.max(1, width - printWidth(leftStr) - rw);
  return leftStr + ' '.repeat(gap) + rightStr;
}

/** A full-width rule of a single ASCII character (e.g. '-' or '='). */
function rule(ch, width) {
  return ch.repeat(width);
}

/**
 * Hard-wrap text to lines of at most `maxCols` PRINT columns. Width-based (not
 * word-based) because Thai text frequently has no spaces; honours embedded '\n'.
 */
function wrapByWidth(str, maxCols) {
  const chars = [...String(str == null ? '' : str)];
  const lines = [];
  let cur = '';
  let cols = 0;
  for (const ch of chars) {
    if (ch === '\n') {
      lines.push(cur);
      cur = '';
      cols = 0;
      continue;
    }
    const w = printWidth(ch); // 0 for combining marks, 1 otherwise
    if (cols + w > maxCols && cur) {
      lines.push(cur);
      cur = '';
      cols = 0;
    }
    cur += ch;
    cols += w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Append one text line (Thai-encoded) + newline to the printer buffer. */
function line(printer, str) {
  printer.append(encodeThai(str));
  printer.newLine();
}

/**
 * Render the full receipt layout onto a ThermalPrinter instance (no device I/O).
 * @param {import('node-thermal-printer').ThermalPrinter} printer
 * @param {object} data ReceiptData: { order, seller, sizeSettings }
 * @param {{ bahtFallback?: boolean, codepage?: number }} opts
 */
function renderReceipt(printer, data, opts) {
  const width = RECEIPT_WIDTH;
  const bahtFallback = !!opts.bahtFallback;
  const codepage = Number.isInteger(opts.codepage) ? opts.codepage : 20;
  const m = (n) => moneyAgent(n, { bahtFallback });

  const order = data && data.order ? data.order : {};
  const seller = data && data.seller ? data.seller : {};

  // Header field resolution — identical fallbacks to ReceiptModal.
  const sellerName = s(seller.sellerName) || 'KRS';
  const branchLine = s(seller.sellerBranchLabel) || 'สำนักงานใหญ่ · Head Office';
  const phone = s(seller.sellerPhone);
  const posId = s(seller.sellerPosId);
  const address = s(seller.sellerAddress);
  const taxId = s(seller.sellerTaxId);

  // --- Initialize + select Thai code table (ESC @, FS ., then ESC t <n>). ---
  printer.append(Buffer.from([0x1b, 0x40])); // ESC @  reset printer
  // FS .  (0x1C 0x2E) — CANCEL Kanji / multi-byte character mode. Chinese-firmware
  // XP-80C units default to Kanji mode ON (FS &), which consumes each PAIR of high
  // TIS-620 bytes as ONE double-byte Chinese glyph — so Thai prints as Chinese. We
  // MUST cancel Kanji mode here (before the code table + any Thai) so the printer
  // treats every byte as SINGLE-byte and the ESC t Thai table applies to 0x80–0xFF.
  printer.append(Buffer.from([0x1c, 0x2e])); // FS .  cancel Kanji (single-byte mode)
  printer.append(Buffer.from([0x1b, 0x74, codepage & 0xff])); // ESC t <n>  Thai table
  printer.setTypeFontA(); // Font A → 48 columns

  // --- HEADER (centered) ---
  printer.alignCenter();
  printer.bold(true);
  line(printer, sellerName);
  printer.bold(false);
  line(printer, branchLine);
  if (phone) line(printer, `โทร ${phone}`);
  if (posId) line(printer, `POS: ${posId}`);
  if (address) for (const ln of wrapByWidth(address, 40)) line(printer, ln);
  if (taxId) line(printer, `เลขประจำตัวผู้เสียภาษี ${taxId}`);
  printer.bold(true);
  line(printer, 'ใบเสร็จรับเงินสด');
  printer.bold(false);
  printer.alignLeft();
  line(printer, rule('-', width));

  // --- META (label left / value right) ---
  line(printer, rowLR('เลขที่ POS', s(order.orderNumber), width));
  line(printer, rowLR('เลขเอกสารบัญชี', order.accountingDocNo ? s(order.accountingDocNo) : '— รอออกเอกสาร —', width));
  line(printer, rowLR('วันที่', formatDateTime(order.createdAt), width));
  line(printer, rowLR('แคชเชียร์', s(order.cashier && order.cashier.name) || 'นิดา ส.', width));
  line(printer, rule('-', width));

  // --- LINE ITEMS ---
  const items = Array.isArray(order.items) ? order.items : [];
  for (const it of items) {
    const name = s(it && it.product && it.product.name);
    const qty = it && it.quantity != null ? it.quantity : 0;
    line(printer, rowLR(name, m(it && it.lineTotal), width));
    line(printer, `  ${qty} x ${m(it && it.unitPrice)}`); // indented qty × unitPrice
  }
  line(printer, rule('=', width));

  // --- TOTAL (bold) ---
  printer.bold(true);
  line(printer, rowLR('รวมสุทธิ', m(order.total), width));
  printer.bold(false);
  line(printer, rule('-', width));

  // --- PAYMENT LINES ---
  const payLines =
    Array.isArray(order.payments) && order.payments.length > 0
      ? order.payments
      : [{ method: order.paymentType, amount: order.total }];
  for (const p of payLines) {
    line(printer, rowLR(methodLabel(p && p.method), m(p && p.amount), width));
  }
  // เงินทอน (change) only when > 0.01, matching ReceiptModal's hasChange guard.
  const change = Number(order.change);
  if (Number.isFinite(change) && change > 0.01) {
    printer.bold(true);
    line(printer, rowLR('เงินทอน', m(order.change), width));
    printer.bold(false);
  }

  // --- TAX-PAYER BLOCK (order.taxRequested && customer.taxId) ---
  if (order.taxRequested && order.customer && s(order.customer.taxId)) {
    line(printer, rule('-', width));
    line(printer, 'ข้อมูลผู้เสียภาษี');
    line(printer, s(order.customer.name));
    if (s(order.customer.address)) line(printer, s(order.customer.address));
    line(printer, `TIN ${s(order.customer.taxId)}`);
  }

  // --- FOOTER (centered) ---
  line(printer, rule('=', width));
  printer.alignCenter();
  line(printer, 'ราคานี้รวมภาษีมูลค่าเพิ่ม 7% แล้ว');
  line(printer, 'ขอบคุณที่ใช้บริการ · Thank you');
  printer.alignLeft();

  // Feed a little, then partial cut (GS V 1 via node-thermal-printer).
  printer.newLine();
  printer.newLine();
  printer.newLine();
  printer.partialCut();
}

// PowerShell RAW-print helper (winspool P/Invoke). Written to a temp .ps1 at send
// time and invoked with the printer name + payload path. Sends bytes verbatim as a
// "RAW" datatype job so the printer receives our ESC/POS stream unmodified — no GDI
// re-rendering. No `${` or backtick sequences here (kept safe inside a JS template).
const RAWPRINT_PS1 = `param(
  [Parameter(Mandatory=$true)][string]$FilePath,
  [string]$PrinterName = ""
)
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($PrinterName)) {
  $def = Get-CimInstance -ClassName Win32_Printer -Filter "Default = True" | Select-Object -First 1
  if ($null -eq $def) { Write-Error "No default Windows printer is configured"; exit 1 }
  $PrinterName = $def.Name
}
$src = @'
using System;
using System.Runtime.InteropServices;
public static class KrsRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool OpenPrinter(string pPrinterName, out IntPtr hPrinter, IntPtr pDefault);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFO di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
  public static void SendBytes(string printerName, byte[] bytes) {
    IntPtr h;
    if (!OpenPrinter(printerName, out h, IntPtr.Zero))
      throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ") for " + printerName);
    try {
      DOCINFO di = new DOCINFO();
      di.pDocName = "KRS POS Receipt";
      di.pDataType = "RAW";
      if (!StartDocPrinter(h, 1, ref di))
        throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(h))
          throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written))
          throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        EndPagePrinter(h);
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[KrsRawPrinter]::SendBytes($PrinterName, $bytes)
Write-Output ("OK sent " + $bytes.Length + " bytes to " + $PrinterName)
`;

/**
 * Spool a raw ESC/POS Buffer to a Windows printer with no native/node-gyp modules.
 * On non-Windows hosts this throws a clear PrintError (the dry-run / dev path) after
 * the buffer has already been built, so callers can still inspect the bytes.
 *
 * @param {Buffer} buffer
 * @param {string} printerName '' = the Windows default printer
 * @returns {Promise<string>} spooler confirmation line
 */
async function sendToWindowsPrinter(buffer, printerName) {
  if (process.platform !== 'win32') {
    throw new PrintError(
      `printer transport is only available on Windows (host is '${process.platform}'). ` +
        `Built ${buffer ? buffer.length : 0} ESC/POS bytes but cannot spool them here.`,
    );
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krs-print-'));
  const binPath = path.join(tmpDir, 'receipt.bin');
  const ps1Path = path.join(tmpDir, 'rawprint.ps1');
  try {
    fs.writeFileSync(binPath, buffer);
    fs.writeFileSync(ps1Path, RAWPRINT_PS1, 'utf8');
    return await new Promise((resolve, reject) => {
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ps1Path,
        '-FilePath',
        binPath,
        '-PrinterName',
        printerName || '',
      ];
      execFile(
        'powershell.exe',
        args,
        { windowsHide: true, timeout: 15000 },
        (err, stdout, stderr) => {
          const out = String(stdout || '').trim();
          const errOut = String(stderr || '').trim();
          if (err) {
            reject(new PrintError(`spooler error: ${errOut || err.message}`));
            return;
          }
          if (/^OK\b/.test(out)) {
            resolve(out);
          } else {
            reject(new PrintError(`spooler did not confirm the job: ${out || errOut || 'no output'}`));
          }
        },
      );
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_e) {
      // best-effort cleanup; ignore
    }
  }
}

/**
 * The `execute()` transport node-thermal-printer drives. Returned as a plain object
 * so the library's `getInterface` passes it through untouched (no native module).
 */
function makeSpoolerInterface(printerName) {
  return {
    isPrinterConnected: async () => process.platform === 'win32',
    execute: async (buffer) => sendToWindowsPrinter(buffer, printerName),
  };
}

/**
 * Instantiate a ThermalPrinter and render the receipt onto it (no device I/O).
 * @param {object} receiptData
 * @param {{ bahtFallback?: boolean, codepage?: number, printerName?: string }} [opts]
 * @returns {import('node-thermal-printer').ThermalPrinter}
 */
function buildPrinter(receiptData, opts = {}) {
  const printerName = opts.printerName != null ? opts.printerName : config.PRINTER_NAME;
  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON, // XP-80C is ESC/POS (Epson) compatible
    interface: makeSpoolerInterface(printerName),
    width: RECEIPT_WIDTH,
    removeSpecialCharacters: false, // must keep Thai combining marks intact
  });
  renderReceipt(printer, receiptData, {
    bahtFallback: opts.bahtFallback != null ? opts.bahtFallback : config.BAHT_FALLBACK,
    codepage: opts.codepage != null ? opts.codepage : config.THAI_CODEPAGE,
  });
  return printer;
}

/**
 * Build the raw ESC/POS Buffer for a receipt WITHOUT sending it to any printer.
 * Used by the dry-run / test harness and by test-print.js for offline inspection.
 * @param {object} receiptData
 * @param {object} [opts]
 * @returns {Buffer}
 */
function buildReceiptBuffer(receiptData, opts = {}) {
  return buildPrinter(receiptData, opts).getBuffer();
}

/**
 * Render `receiptData` to ESC/POS and spool it to the configured Windows printer.
 * Throws PrintError on any failure (index.js maps it to HTTP 500). Never prints
 * secrets; logs a one-line success/failure with the order identifier only.
 * @param {object} receiptData ReceiptData: { order, seller, sizeSettings }
 * @param {object} [opts]
 * @returns {Promise<void>}
 */
async function printReceipt(receiptData, opts = {}) {
  if (!receiptData || typeof receiptData.order !== 'object' || receiptData.order === null) {
    throw new PrintError('invalid receipt data: order object required');
  }
  const order = receiptData.order;
  const orderId = order.orderNumber || order.id || '(unknown)';
  try {
    const printer = buildPrinter(receiptData, opts);
    await printer.execute(); // → makeSpoolerInterface.execute → Windows RAW spooler
    console.log(`[printer] job submitted, order=${orderId}`);
  } catch (err) {
    const message = err instanceof PrintError ? err.message : (err && err.message) || String(err);
    console.error(`[printer] ERROR: ${message}, order=${orderId}`);
    throw err instanceof PrintError ? err : new PrintError(message);
  }
}

module.exports = {
  printReceipt,
  buildReceiptBuffer,
  renderReceipt,
  methodLabel,
  formatDateTime,
  // Shared native-free Windows RAW spooler send. Exported so other CLI paths
  // (e.g. index.js `--scan`) can spool their own ESC/POS buffer to the same
  // printer without duplicating the winspool/PowerShell logic. '' = default queue.
  sendToWindowsPrinter,
  PrintError,
  RECEIPT_WIDTH,
};

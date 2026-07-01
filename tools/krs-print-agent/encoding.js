'use strict';

// encoding.js — Thai text encoding + baht money formatting for the ESC/POS receipt
// (Phase B2). The XP-80C renders Thai from an on-board code table selected with
// `ESC t <n>` (see config.THAI_CODEPAGE / printer.js). After that selection every
// byte in 0x80–0xFF is drawn as that table's glyph, so Thai strings must be sent to
// the printer as **TIS-620 bytes**, NOT as UTF-8. iconv-lite performs that mapping.
//
// TIS-620 and CP874 share the same Thai high range (0xA1–0xFB) and are ASCII for
// 0x00–0x7F, so a mixed "เงินสด 1,234.50" line encodes cleanly in one pass.

const iconv = require('iconv-lite');

// iconv-lite label for the Thai single-byte encoding. 'tis620' and 'cp874' are
// aliases for the same table in iconv-lite; keep this in one place in case a shop's
// printer firmware ever needs the CP874 alias instead.
const THAI_ENCODING = 'tis620';

// The baht sign ฿ (U+0E3F) is 0xDF in TIS-620. On some XP-80 OEM firmware the
// selected code table maps 0xDF to a different glyph, so the receipt can fall back
// to an ASCII "B". Toggled per shop via config.BAHT_FALLBACK (env KRS_BAHT_FALLBACK).
const BAHT_SIGN = '฿';
const BAHT_SIGN_FALLBACK = 'B';

// Punctuation that appears in the web receipt (ReceiptModal) but has NO TIS-620
// byte. Left unmapped, iconv-lite emits 0x3F ('?') for these — visible garbage on
// paper. Transliterate them to a safe ASCII equivalent BEFORE encoding.
//   '×' (U+00D7) — the "qty × unitPrice" multiplication sign
//   '·' (U+00B7) — the "ขอบคุณ · Thank you" middle dot
//   '…' (U+2026) — used as the product-name truncation marker
const TIS620_SUBSTITUTIONS = {
  '×': 'x', // × multiplication sign
  '·': '-', // · middle dot
  '…': '...', // … horizontal ellipsis
  '–': '-', // – en dash
  '—': '-', // — em dash
  '“': '"', // “ left double quote
  '”': '"', // ” right double quote
  '‘': "'", // ‘ left single quote
  '’': "'", // ’ right single quote
};

// Thai combining marks (upper/lower vowels and tone marks) render stacked on the
// preceding base consonant, so they occupy ZERO print columns even though each is a
// distinct code point / TIS-620 byte. Excluding them is what makes column widths
// (item name vs. right-aligned price) line up for Thai text.
//   U+0E31            ◌ั  mai han-akat
//   U+0E34–U+0E3A     ◌ิ ◌ี ◌ึ ◌ื ◌ุ ◌ู ◌ฺ  upper/lower vowels + phinthu
//   U+0E47–U+0E4E     ◌็ ◌่ ◌้ ◌๊ ◌๋ ◌์ ◌ํ ◌๎  maitaikhu + tone marks + thanthakhat
const THAI_COMBINING_CLASS = '\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E';
const THAI_COMBINING_ONE = new RegExp(`^[${THAI_COMBINING_CLASS}]$`); // single-char test (no /g state)
const THAI_COMBINING_GLOBAL = new RegExp(`[${THAI_COMBINING_CLASS}]`, 'g'); // count/strip
const THAI_COMBINING_TRAILING = new RegExp(`[${THAI_COMBINING_CLASS}]+$`); // strip orphaned tail

/**
 * Replace characters with no TIS-620 representation with safe ASCII equivalents.
 * @param {string} str
 * @returns {string}
 */
function substituteUnsupported(str) {
  let out = '';
  for (const ch of str) {
    out += Object.prototype.hasOwnProperty.call(TIS620_SUBSTITUTIONS, ch)
      ? TIS620_SUBSTITUTIONS[ch]
      : ch;
  }
  return out;
}

/**
 * Encode a display string for the printer's active Thai code table.
 *
 * Returns the string unchanged when it is pure ASCII (the node-thermal-printer
 * `append()` ASCII path is already byte-safe for 0x00–0x7F), otherwise returns a
 * TIS-620 Buffer. Callers pass the result straight to `printer.append(...)`, which
 * appends a Buffer verbatim and iterates an ASCII string char-by-char — both correct.
 *
 * @param {string} str
 * @returns {string|Buffer}
 */
function encodeThai(str) {
  const s = String(str == null ? '' : str);
  // Pure ASCII (no code point above U+007F): no re-encoding needed.
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(s)) return s;
  return iconv.encode(substituteUnsupported(s), THAI_ENCODING);
}

/**
 * Number of PRINT COLUMNS a string occupies once rendered, i.e. code points minus
 * zero-width Thai combining marks. Used for item/price column alignment.
 * @param {string} str
 * @returns {number}
 */
function printWidth(str) {
  const s = String(str == null ? '' : str);
  const combining = s.match(THAI_COMBINING_GLOBAL);
  return [...s].length - (combining ? combining.length : 0);
}

/**
 * Truncate a string to at most `maxCols` print columns, appending an ellipsis when
 * it overflows. The ellipsis becomes ASCII "..." after TIS-620 substitution, so we
 * reserve 3 columns for it. Trailing orphaned combining marks (a tone mark left
 * without its base consonant after the cut) are trimmed so nothing renders detached.
 *
 * @param {string} str
 * @param {number} maxCols
 * @returns {string}
 */
function truncateToWidth(str, maxCols) {
  const s = String(str == null ? '' : str);
  if (printWidth(s) <= maxCols) return s;
  const budget = Math.max(1, maxCols - 3); // room for the "..." marker
  const chars = [...s];
  let out = '';
  let cols = 0;
  for (const ch of chars) {
    const w = THAI_COMBINING_ONE.test(ch) ? 0 : 1;
    if (cols + w > budget) break;
    out += ch;
    cols += w;
  }
  // Drop any trailing combining marks orphaned by the cut.
  out = out.replace(THAI_COMBINING_TRAILING, '');
  return out + '…';
}

/**
 * Format a number/numeric-string as Thai baht — an EXACT mirror of the web app's
 * `money()` (src/lib/money.ts): sign BEFORE the ฿ symbol, comma thousands grouping,
 * always two decimals, and "฿0.00" for non-finite input.
 *
 * @param {number|string} n
 * @param {{ bahtFallback?: boolean }} [opts] bahtFallback prints "B" instead of ฿.
 * @returns {string}
 */
function moneyAgent(n, opts = {}) {
  const symbol = opts.bahtFallback ? BAHT_SIGN_FALLBACK : BAHT_SIGN;
  const raw = typeof n === 'string' ? Number(n.trim()) : n;
  if (!Number.isFinite(raw)) return `${symbol}0.00`;
  const v = raw === 0 ? 0 : raw; // normalize -0
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${symbol}${abs}`;
}

module.exports = {
  THAI_ENCODING,
  BAHT_SIGN,
  BAHT_SIGN_FALLBACK,
  encodeThai,
  printWidth,
  truncateToWidth,
  moneyAgent,
  substituteUnsupported,
};

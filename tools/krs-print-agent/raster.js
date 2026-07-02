'use strict';

// raster.js — PNG → ESC/POS RASTER (GS v 0) image printing for the KRS Print Agent.
//
// WHY THIS EXISTS: text ESC/POS printing (printer.js) draws Thai from the printer's
// on-board Thai code table (ESC t <n>), which is firmware-specific and often absent
// on XP-80 OEM clones — so Thai can print as Chinese or "?". Raster/dot printing needs
// NO printer font: the BROWSER renders the receipt (Thai included) to a bitmap, and we
// print that bitmap as dots. Any ESC/POS printer that accepts GS v 0 then prints Thai
// correctly. This module is the device-side of that contract (see POST /print-image).
//
// PIPELINE:
//   base64/Buffer PNG  ->  pngjs decode (PURE JS, no node-gyp)  ->  grayscale+threshold
//   to 1-bit  ->  GS v 0 raster bands  ->  shared winspool RAW spooler (printer.js).
//
// PURE-JS DECODER: the PNG is decoded with `pngjs` (zero native deps, no binding.gyp,
// no .node files) so the Phase-B3 `pkg` single-exe cross-build stays native-free. Do
// NOT swap in sharp/canvas/jimp-with-native — those need node-gyp and break the build.

const { PNG } = require('pngjs');
const config = require('./config');
const { sendToWindowsPrinter, PrintError } = require('./printer');

// Luminance threshold: a pixel darker than this (0..255) prints as a black dot.
// ~128 is the midpoint; the browser renders black content on a white background, so
// anti-aliased edges resolve cleanly either side of this.
const DEFAULT_LUMA_THRESHOLD = 128;

// Max dot rows per single GS v 0 command. A tall receipt must be BANDED into vertical
// chunks and emitted as sequential GS v 0 calls (each advances the paper by its own
// height, so consecutive bands print seamlessly with no feed between them). 255 keeps
// each band's height in a single byte (yH = 0) — the most compatible choice across
// ESC/POS firmware, well within the spec's ≤255 / ≤1662 guidance.
const MAX_BAND_HEIGHT = 255;

/**
 * Decode a PNG Buffer and pack it into a 1-bit bitmap for ESC/POS raster output.
 *
 * Each pixel is converted to grayscale (Rec.601 luma) and thresholded: darker than
 * `threshold` => black dot (bit 1), else white (bit 0). A fully transparent pixel
 * (alpha === 0) is treated as white. Rows are packed MSB-first, 8 px/byte, with the
 * final byte in each row zero-padded (white) — row stride = ceil(width/8) bytes.
 *
 * @param {Buffer} pngBuffer raw PNG bytes
 * @param {{ threshold?: number }} [opts]
 * @returns {{ width: number, height: number, widthBytes: number, bitmap: Buffer }}
 */
function pngToBitmap(pngBuffer, opts = {}) {
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
    throw new PrintError('image data is empty');
  }
  let png;
  try {
    png = PNG.sync.read(pngBuffer); // pure-JS decode → { width, height, data(RGBA) }
  } catch (err) {
    throw new PrintError(`invalid PNG: ${err && err.message ? err.message : err}`);
  }
  const { width, height, data } = png;
  if (!width || !height) {
    throw new PrintError('PNG has zero width or height');
  }
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_LUMA_THRESHOLD;

  const widthBytes = Math.ceil(width / 8);
  const bitmap = Buffer.alloc(widthBytes * height, 0x00); // 0x00 = all white

  for (let y = 0; y < height; y++) {
    const rowByteBase = y * widthBytes;
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2; // 4 bytes/pixel (RGBA)
      const a = data[idx + 3];
      let black;
      if (a === 0) {
        black = false; // fully transparent → white
      } else {
        // Rec.601 luma, integer math to avoid float wobble.
        const luma = (data[idx] * 299 + data[idx + 1] * 587 + data[idx + 2] * 114) / 1000;
        black = luma < threshold;
      }
      if (black) {
        bitmap[rowByteBase + (x >> 3)] |= 0x80 >> (x & 7); // MSB = leftmost pixel
      }
    }
  }
  return { width, height, widthBytes, bitmap };
}

/**
 * Convert a PNG Buffer into a complete ESC/POS RASTER byte stream:
 *   ESC @                         init/reset
 *   GS v 0 m xL xH yL yH <data>   one command per vertical BAND (m=0 normal),
 *                                 xL/xH = row width in BYTES, yL/yH = band height in
 *                                 DOTS (little-endian); bands emitted back-to-back so
 *                                 a tall receipt prints fully and seamlessly
 *   LF LF LF                      feed clear of the head
 *   GS V 1                        partial cut (EPSON)
 *
 * Deliberately does NOT emit FS . / ESC t — those select the printer's Thai text code
 * table, which is irrelevant for raster (the glyphs are already dots in the bitmap).
 *
 * @param {Buffer} pngBuffer raw PNG bytes
 * @param {{ threshold?: number }} [opts]
 * @returns {Buffer} raw ESC/POS raster stream (no device involved)
 */
function pngBufferToRaster(pngBuffer, opts = {}) {
  const { height, widthBytes, bitmap } = pngToBitmap(pngBuffer, opts);

  const parts = [];
  parts.push(Buffer.from([0x1b, 0x40])); // ESC @  init

  const xL = widthBytes & 0xff;
  const xH = (widthBytes >> 8) & 0xff;

  for (let y0 = 0; y0 < height; y0 += MAX_BAND_HEIGHT) {
    const bandRows = Math.min(MAX_BAND_HEIGHT, height - y0);
    const yL = bandRows & 0xff;
    const yH = (bandRows >> 8) & 0xff;
    // GS v 0  m=0  xL xH yL yH
    parts.push(Buffer.from([0x1d, 0x76, 0x30, 0x00, xL, xH, yL, yH]));
    const start = y0 * widthBytes;
    const end = start + bandRows * widthBytes;
    parts.push(bitmap.subarray(start, end));
  }

  parts.push(Buffer.from([0x0a, 0x0a, 0x0a])); // feed
  parts.push(Buffer.from([0x1d, 0x56, 0x01])); // GS V 1  partial cut
  return Buffer.concat(parts);
}

/**
 * Decode `pngInput` (a base64 string OR a raw PNG Buffer) to ESC/POS raster and spool
 * it to the Windows printer via the shared winspool RAW send (printer.js). Throws
 * PrintError on any failure so index.js maps it to HTTP 500 without crashing; off
 * Windows the raster still BUILDS and the send throws a clear PrintError.
 *
 * @param {string|Buffer} pngInput base64 PNG (from the browser) or a PNG Buffer
 * @param {{ threshold?: number, printerName?: string }} [opts]
 * @returns {Promise<string>} spooler confirmation line
 */
async function printImage(pngInput, opts = {}) {
  let buffer;
  if (Buffer.isBuffer(pngInput)) {
    buffer = pngInput;
  } else if (typeof pngInput === 'string') {
    if (pngInput.length === 0) throw new PrintError('image data is empty');
    buffer = Buffer.from(pngInput, 'base64'); // lenient; bad data fails at PNG decode
  } else {
    throw new PrintError('image data must be a base64 string or Buffer');
  }
  const raster = pngBufferToRaster(buffer, opts);
  const printerName = opts.printerName != null ? opts.printerName : config.PRINTER_NAME;
  return sendToWindowsPrinter(raster, printerName);
}

/**
 * Build a small, self-contained 1-bit test bitmap PNG entirely IN CODE (NO font):
 * a full black border, a filled solid box, and a diagonal line on a white background.
 * Encoded with pngjs. Used by `--test-image` to prove the RASTER path end-to-end on
 * the real printer without a browser. (Real Thai still comes from the browser via
 * POST /print-image; this only proves the printer accepts GS v 0 raster.)
 *
 * @param {{ width?: number, height?: number }} [opts]
 * @returns {Buffer} PNG bytes (black content on a white background)
 */
function buildTestImagePng(opts = {}) {
  const width = Number.isInteger(opts.width) && opts.width > 0 ? opts.width : 576; // 80mm printable
  const height = Number.isInteger(opts.height) && opts.height > 0 ? opts.height : 240;
  const png = new PNG({ width, height });

  const set = (x, y, black) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = (width * y + x) << 2;
    const v = black ? 0 : 255;
    png.data[idx] = v;
    png.data[idx + 1] = v;
    png.data[idx + 2] = v;
    png.data[idx + 3] = 255; // opaque
  };

  // White background.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) set(x, y, false);

  // 3px full border.
  const b = 3;
  for (let y = 0; y < height; y++) {
    for (let t = 0; t < b; t++) {
      set(t, y, true);
      set(width - 1 - t, y, true);
    }
  }
  for (let x = 0; x < width; x++) {
    for (let t = 0; t < b; t++) {
      set(x, t, true);
      set(x, height - 1 - t, true);
    }
  }

  // Filled solid box (proves solid dot coverage).
  const bx0 = 40;
  const by0 = 40;
  const bx1 = Math.min(width - 40, 240);
  const by1 = Math.min(height - 40, 160);
  for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) set(x, y, true);

  // Diagonal line corner-to-corner (proves per-dot addressing).
  const steps = Math.max(width, height);
  for (let i = 0; i < steps; i++) {
    const x = Math.round((i / (steps - 1)) * (width - 1));
    const y = Math.round((i / (steps - 1)) * (height - 1));
    set(x, y, true);
    set(x + 1, y, true); // 2px thick so it survives thresholding
  }

  return PNG.sync.write(png);
}

module.exports = {
  pngToBitmap,
  pngBufferToRaster,
  printImage,
  buildTestImagePng,
  MAX_BAND_HEIGHT,
  DEFAULT_LUMA_THRESHOLD,
};

'use strict';

// config.js — KRS Print Agent configuration (CommonJS).
//
// This file is COMMITTED and must contain no secrets. Shop-specific overrides
// (printer name, Thai codepage, non-default port) are applied at RUNTIME without a
// rebuild via, in order of precedence (highest first):
//
//   1. Environment variables ..... KRS_PRINTER_NAME / KRS_THAI_CODEPAGE / ... / PORT
//   2. A `.env` file ............. KEY=VALUE lines, loaded into process.env for any
//                                  key not already set (so real env still wins)
//   3. `config.local.json` ....... a JSON object of overrides, e.g.
//                                    { "PRINTER_NAME": "XP-80C", "THAI_CODEPAGE": 21 }
//   4. The hardcoded defaults below.
//
// WHY DISK FILES: config.js is bundled INTO the Phase-B3 `krs-print-agent.exe`, so it
// cannot be edited after packaging. The `.env` / `config.local.json` files are read
// from disk NEXT TO THE EXECUTABLE at startup, letting the shop owner iterate the Thai
// codepage / printer name on the real XP-80C without a rebuild. In plain-Node dev
// (`node index.js`) the same files are read next to the source instead.
//
// A dev-only `config.local.js` (a CommonJS re-export) is also still git-ignored and
// may be used when running from source, but it does NOT apply inside the packaged
// .exe — use `.env` or `config.local.json` for the shipped agent.

const fs = require('fs');
const path = require('path');

// When bundled by pkg, `process.pkg` is set and config.js lives inside the read-only
// snapshot; disk overrides must be looked up next to the .exe (process.execPath).
// In dev, look next to these source files.
const IS_PKG = typeof process.pkg !== 'undefined';
const EXTERNAL_DIR = IS_PKG ? path.dirname(process.execPath) : __dirname;

/**
 * Load a `.env` (or `agent.env`) file next to the agent, applying each KEY=VALUE line
 * to process.env ONLY when that key is not already set — real environment variables
 * always win. Comments (`#`) and blank lines are ignored; surrounding quotes stripped.
 */
function loadDotEnv(dir) {
  for (const name of ['.env', 'agent.env']) {
    const p = path.join(dir, name);
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (_e) {
      continue; // not present — fine
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
    process.stderr.write(`[krs-print-agent] loaded env overrides from ${p}\n`);
  }
}

/**
 * Load `config.local.json` next to the agent. Returns a plain object of overrides
 * (used as a fallback under real/`.env` environment variables), or `{}` if absent.
 */
function loadJsonConfig(dir) {
  const p = path.join(dir, 'config.local.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      process.stderr.write(`[krs-print-agent] loaded config overrides from ${p}\n`);
      return parsed;
    }
    process.stderr.write(`[krs-print-agent] WARN: ${p} is not a JSON object — ignored\n`);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      process.stderr.write(`[krs-print-agent] WARN: could not read ${p}: ${err.message}\n`);
    }
  }
  return {};
}

loadDotEnv(EXTERNAL_DIR);
const FILE = loadJsonConfig(EXTERNAL_DIR);

// Precedence resolvers: env var(s) > config.local.json > hardcoded default.
function pickStr(envNames, fileKey, def) {
  for (const n of envNames) if (process.env[n] != null) return process.env[n];
  if (FILE[fileKey] != null) return String(FILE[fileKey]);
  return def;
}
function pickInt(envNames, fileKey, def) {
  for (const n of envNames) if (process.env[n] != null) return parseInt(process.env[n], 10);
  if (FILE[fileKey] != null) return parseInt(String(FILE[fileKey]), 10);
  return def;
}
function pickBool(envNames, fileKey, def) {
  const truthy = (v) => v === true || v === '1' || String(v).toLowerCase() === 'true';
  for (const n of envNames) if (process.env[n] != null) return truthy(process.env[n]);
  if (FILE[fileKey] != null) return truthy(FILE[fileKey]);
  return def;
}

module.exports = {
  // Port the agent listens on. Overridable via env for shops that already use 9100.
  // KRS_PRINT_AGENT_PORT takes precedence, then generic PORT, then the 9100 default.
  PORT: pickInt(['KRS_PRINT_AGENT_PORT', 'PORT'], 'PORT', 9100),

  // Bind to loopback ONLY. This agent must never be reachable off the shop PC.
  // NEVER change this to "0.0.0.0" — doing so would expose the print endpoint to
  // the local network / internet. Loopback binding is the primary security control.
  // Intentionally NOT overridable from disk/env: it is a security invariant.
  HOST: '127.0.0.1',

  // Cross-origin browsers are only trusted from these exact origins. The POS web
  // app is served over HTTPS but must reach this http://127.0.0.1 agent, so the
  // browser performs a CORS (and Chrome Private Network Access) preflight. Only
  // origins in this list receive an Access-Control-Allow-Origin echo.
  // Intentionally NOT overridable from disk/env: it is a security invariant.
  ALLOWED_ORIGINS: [
    'https://krspos.innoveraappcenter.com', // production POS
    'http://localhost:3000', // Next.js dev
    'http://127.0.0.1:3000', // Next.js dev (alt host)
  ],

  // Windows printer name. Empty string = use the Windows default printer.
  // Set per-shop via KRS_PRINTER_NAME env, .env, or config.local.json.
  PRINTER_NAME: pickStr(['KRS_PRINTER_NAME'], 'PRINTER_NAME', ''),

  // Max accepted request body size for POST /print-receipt. A receipt JSON is
  // ~2–5 KB; 128 KB is generous headroom and caps abuse. Bodies over this are
  // rejected with HTTP 413 before any parsing.
  MAX_BODY_BYTES: 131072, // 128 KB

  // Max accepted request body size for POST /print-image. The browser sends a
  // ~576px-wide receipt PNG as base64 in { imagePngBase64 }, typically 200–500 KB;
  // 2 MB gives generous headroom for tall receipts while still capping abuse. Bodies
  // over this are rejected with HTTP 413 before any parsing.
  MAX_IMAGE_BODY_BYTES: 2097152, // 2 MB

  // ESC t code-table selector for Thai glyphs on the thermal printer (printer.js
  // emits `ESC t <n>` = 0x1B 0x74 <n> before any Thai text). The correct table
  // number is firmware-specific on XP-80 OEM clones and is NOT standardised, so the
  // owner iterates the candidates below on the real XP-80C via `npm run test-print`
  // (or `krs-print-agent.exe --test`) and sets the winning value via KRS_THAI_CODEPAGE
  // (env), a `.env` line, or config.local.json — NO code change / rebuild needed:
  //
  //   20  (0x14)  most common TIS-620 on Chinese OEM thermal printers  ← default
  //   21  (0x15)  sometimes used for CP874
  //   18  (0x12)  found in some Xprinter firmware revisions
  //   17  (0x11)  occasional alternate
  //
  // KANJI MODE: printer.js ALWAYS sends `FS .` (0x1C 0x2E, cancel Kanji/multi-byte
  // mode) right after ESC @, BEFORE this ESC t selection. Chinese-firmware XP-80C
  // units default to Kanji mode ON, which consumes each PAIR of Thai high-bytes as
  // one double-byte Chinese glyph (Thai prints as Chinese); FS . forces single-byte
  // mode so this code table applies. Changing only the codepage number does nothing
  // while Kanji mode is on — that fix is now unconditional.
  //
  // Not sure which number? Run `krs-print-agent.exe --scan` (or `node index.js
  // --scan`): it prints ONE strip with a Thai sample under ESC t 0..79, one per line.
  // Read the strip, find the `n=<n>:` line whose Thai is READABLE, and set that number
  // as KRS_THAI_CODEPAGE (env) or "THAI_CODEPAGE" in config.local.json. If even the
  // scan shows no readable Thai, request the firmware code-table spec from Xprinter
  // (see README "Thai codepage" section).
  THAI_CODEPAGE: pickInt(['KRS_THAI_CODEPAGE'], 'THAI_CODEPAGE', 20),

  // Print an ASCII "B" instead of the baht sign ฿ (U+0E3F → 0xDF in TIS-620). Some
  // firmware maps 0xDF to a different glyph; if the test receipt shows garbage where
  // ฿ should be, set KRS_BAHT_FALLBACK=1 (or "BAHT_FALLBACK": true in the JSON file).
  BAHT_FALLBACK: pickBool(['KRS_BAHT_FALLBACK'], 'BAHT_FALLBACK', false),

  // The directory the disk overrides above were read from (next to the .exe when
  // packaged). Exposed for logging/diagnostics only.
  EXTERNAL_CONFIG_DIR: EXTERNAL_DIR,
};

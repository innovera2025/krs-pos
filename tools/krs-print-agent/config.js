// config.js — KRS Print Agent configuration (CommonJS).
//
// This file is COMMITTED and must contain no secrets. Shop-specific overrides
// (printer name, Thai codepage, non-default port) belong in a git-ignored
// `config.local.js` that re-exports these values with overrides applied, e.g.:
//
//   // config.local.js  (git-ignored — see .gitignore)
//   const base = require('./config');
//   module.exports = { ...base, PRINTER_NAME: 'XP-80C', THAI_CODEPAGE: 21 };
//
// index.js loads `./config` directly in B1. A future phase may prefer
// `config.local.js` when present; keep this file free of machine-specific state.

module.exports = {
  // Port the agent listens on. Overridable via env for shops that already use 9100.
  // KRS_PRINT_AGENT_PORT takes precedence, then generic PORT, then the 9100 default.
  PORT: parseInt(
    process.env.KRS_PRINT_AGENT_PORT ?? process.env.PORT ?? '9100',
    10,
  ),

  // Bind to loopback ONLY. This agent must never be reachable off the shop PC.
  // NEVER change this to "0.0.0.0" — doing so would expose the print endpoint to
  // the local network / internet. Loopback binding is the primary security control.
  HOST: '127.0.0.1',

  // Cross-origin browsers are only trusted from these exact origins. The POS web
  // app is served over HTTPS but must reach this http://127.0.0.1 agent, so the
  // browser performs a CORS (and Chrome Private Network Access) preflight. Only
  // origins in this list receive an Access-Control-Allow-Origin echo.
  ALLOWED_ORIGINS: [
    'https://krspos.innoveraappcenter.com', // production POS
    'http://localhost:3000', // Next.js dev
    'http://127.0.0.1:3000', // Next.js dev (alt host)
  ],

  // Windows printer name. Empty string = use the Windows default printer.
  // Set per-shop via KRS_PRINTER_NAME env or config.local.js. (Used in B2.)
  PRINTER_NAME: process.env.KRS_PRINTER_NAME ?? '',

  // Max accepted request body size for POST /print-receipt. A receipt JSON is
  // ~2–5 KB; 128 KB is generous headroom and caps abuse. Bodies over this are
  // rejected with HTTP 413 before any parsing.
  MAX_BODY_BYTES: 131072, // 128 KB

  // ESC t code-table selector for Thai glyphs on the thermal printer. Default 20
  // (TIS-620) is the most common on Xprinter/XP-80 OEM firmware. Override via
  // KRS_THAI_CODEPAGE without a code change once the owner confirms the printer's
  // actual table. (Used in B2 — not referenced by the B1 HTTP server.)
  THAI_CODEPAGE: parseInt(process.env.KRS_THAI_CODEPAGE ?? '20', 10),
};

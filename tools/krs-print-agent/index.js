'use strict';

// index.js — KRS Print Agent HTTP server (Phase B2: real ESC/POS printing).
//
// A tiny loopback-only HTTP service that runs on the cashier's shop PC. The POS
// web app (served over HTTPS from krspos.innoveraappcenter.com) pings GET /health
// on page load to detect this agent; when present it routes receipt printing here
// as ESC/POS bytes (no browser print dialog). POST /print-receipt now renders the
// receipt and spools it to the Windows printer (see printer.js) — the B1 stub is gone.
//
// Dependencies (installed under this package's own node_modules, git-ignored):
// `node-thermal-printer` (ESC/POS buffer assembly) and `iconv-lite` (Thai TIS-620).
// The HTTP layer itself still uses only the Node.js built-in `http` module.
//
// SECURITY MODEL:
//   1. Bind to 127.0.0.1 ONLY (config.HOST) — never reachable off this machine.
//   2. Trust cross-origin browser requests only from config.ALLOWED_ORIGINS
//      (exact-match echo, never a wildcard "*").
//   3. Cap the request body (config.MAX_BODY_BYTES) to reject abusive payloads.
//   4. No secrets, no auth tokens — loopback + origin allow-list is the boundary.

const http = require('http');
const config = require('./config');
const pkg = require('./package.json');
const { printReceipt, PrintError } = require('./printer');

const { PORT, HOST, ALLOWED_ORIGINS, MAX_BODY_BYTES } = config;
const AGENT_NAME = 'krs-print-agent';
const AGENT_VERSION = pkg.version; // read from package.json (currently "1.0.0")

/**
 * Apply CORS + Chrome Private Network Access (PNA) headers.
 *
 * The POS runs on HTTPS but must fetch this http://127.0.0.1 agent. Modern
 * Chromium browsers therefore send a CORS preflight AND a Private Network Access
 * preflight (Access-Control-Request-Private-Network) before the actual request.
 * We must answer both for the browser to allow the HTTPS-page -> localhost call.
 *
 * Only origins in ALLOWED_ORIGINS receive an Access-Control-Allow-Origin echo.
 * Requests with no Origin header (same-origin, curl, health probes) are left
 * untouched. Disallowed cross-origin requests get an empty allow-origin (deny)
 * and a stderr warning. Call this ONCE at the top of the request handler, before
 * any other response header is set.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;

  // No Origin header => not a cross-origin browser request. Nothing to negotiate.
  if (!origin) return;

  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin); // exact echo, not "*"
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // Chrome PNA: required for an HTTPS page to call a private/loopback address.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '86400');
  } else {
    // Untrusted origin: explicitly deny by echoing an empty allow-origin so the
    // browser's CORS check fails, and flag it for the operator.
    res.setHeader('Access-Control-Allow-Origin', '');
    process.stderr.write(
      `[${AGENT_NAME}] WARN: rejected cross-origin request from disallowed origin: ${origin}\n`,
    );
  }
}

/**
 * Send a JSON response with an explicit status code.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {object} payload
 */
function sendJson(res, status, payload) {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/**
 * POST /print-receipt handler (B2).
 * Streams and size-limits the body, parses/validates ReceiptData, then renders the
 * receipt to ESC/POS and spools it to the Windows printer via printer.printReceipt.
 * Returns 200 { ok: true } on success and 500 { ok: false, error } on any print
 * failure — a spooler/printer error must never crash the server.
 */
function handlePrintReceipt(req, res) {
  // Fast reject when the client advertises an oversized body up front.
  const declaredLen = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES) {
    sendJson(res, 413, { error: 'payload too large' });
    req.destroy();
    return;
  }

  const chunks = [];
  let received = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { error: 'payload too large' });
      req.destroy(); // stop reading further data
      return;
    }
    chunks.push(chunk);
  });

  req.on('error', () => {
    if (aborted) return;
    aborted = true;
    sendJson(res, 400, { error: 'request stream error' });
  });

  req.on('end', () => {
    if (aborted) return;

    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (_err) {
      sendJson(res, 400, { error: 'invalid JSON' });
      return;
    }

    // Validate the ReceiptData shape: { order, seller, sizeSettings }.
    // `order` must be a non-null object; seller/sizeSettings are optional here.
    if (!body || typeof body.order !== 'object' || body.order === null) {
      sendJson(res, 400, { error: 'order required' });
      return;
    }

    // B2: render ESC/POS and spool to the Windows printer. A print failure must
    // NEVER crash the server — printReceipt rejects with PrintError; we catch it and
    // return 500 so the fail-open web client resolves and the sale is unaffected.
    const orderNumber = body.order.orderNumber ?? body.order.id ?? '(unknown)';
    const itemCount = Array.isArray(body.order.items) ? body.order.items.length : 0;
    console.log(
      `[${AGENT_NAME}] print-receipt order=${orderNumber} items=${itemCount}`,
    );

    printReceipt(body)
      .then(() => {
        sendJson(res, 200, { ok: true });
      })
      .catch((err) => {
        const message = err instanceof PrintError ? err.message : 'internal error';
        process.stderr.write(
          `[${AGENT_NAME}] print failed order=${orderNumber}: ${
            err && err.message ? err.message : err
          }\n`,
        );
        sendJson(res, 500, { ok: false, error: message });
      });
  });
}

/**
 * Create the loopback HTTP server, start listening, and wire graceful shutdown.
 * Split out from module top-level so the CLI flags (--test/--help/--version) can
 * short-circuit BEFORE any port is bound.
 */
function startServer() {
  const server = http.createServer((req, res) => {
    // CORS/PNA headers first, before any other response header, on EVERY request.
    setCorsHeaders(req, res);

    const method = req.method || 'GET';
    // Strip query string for path matching.
    const path = (req.url || '/').split('?')[0];

    // CORS + PNA preflight for any path.
    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, {
        name: AGENT_NAME,
        version: AGENT_VERSION,
        status: 'ok',
      });
      return;
    }

    if (method === 'POST' && path === '/print-receipt') {
      handlePrintReceipt(req, res);
      return;
    }

    // Everything else.
    sendJson(res, 404, { error: 'not found' });
  });

  server.listen(PORT, HOST, () => {
    console.log(`[${AGENT_NAME}] listening on http://${HOST}:${PORT}`);
  });

  server.on('error', (err) => {
    process.stderr.write(`[${AGENT_NAME}] server error: ${err.message}\n`);
    process.exit(1);
  });

  // Graceful shutdown so autostart/service managers can stop the agent cleanly.
  function shutdown(signal) {
    console.log(`[${AGENT_NAME}] received ${signal}, shutting down`);
    server.close(() => process.exit(0));
    // Safety net if connections do not drain promptly.
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

/** Print the CLI usage banner (for --help / -h). */
function printHelp() {
  process.stdout.write(
    `${AGENT_NAME} v${AGENT_VERSION} — local ESC/POS print bridge for KRS POS\n` +
      '\n' +
      'USAGE:\n' +
      '  krs-print-agent.exe            Start the loopback print server (default)\n' +
      `                                 -> listens on http://${HOST}:${PORT}\n` +
      '  krs-print-agent.exe --test     Print the sample receipt once, then exit\n' +
      '  krs-print-agent.exe --selftest (alias for --test)\n' +
      '  krs-print-agent.exe --version  Print the agent version and exit\n' +
      '  krs-print-agent.exe --help     Show this help and exit\n' +
      '\n' +
      'RUNTIME CONFIG (no rebuild required — set an env var OR a file next to the .exe):\n' +
      '  KRS_PRINTER_NAME    Windows printer queue name (empty = system default)\n' +
      '  KRS_THAI_CODEPAGE   ESC t code table for Thai (default 20; try 21/18/17)\n' +
      '  KRS_BAHT_FALLBACK   1 = print "B" instead of the baht sign\n' +
      '  KRS_PRINT_AGENT_PORT / PORT   Listen port (default 9100)\n' +
      '  File overrides next to the .exe: config.local.json (JSON) or .env (KEY=VALUE)\n',
  );
}

/**
 * CLI entry point. Handle one-shot flags (help/version/self-test) before falling
 * through to the long-running server. Top-level dispatch keeps `pkg` happy: the
 * self-test module is required lazily so it (and the sample) are still bundled, but
 * the server code path stays the default.
 */
function main() {
  const argv = process.argv.slice(2);
  const has = (...names) => argv.some((a) => names.includes(a));

  if (has('--help', '-h', '/?')) {
    printHelp();
    return;
  }

  if (has('--version', '-v')) {
    process.stdout.write(`${AGENT_VERSION}\n`);
    return;
  }

  if (has('--test', '--selftest')) {
    // Reuse the EXACT sample receipt + runner from scripts/test-print.js so the
    // packaged .exe self-test matches `npm run test-print` byte-for-byte.
    const { runSelfTest } = require('./scripts/test-print');
    runSelfTest()
      .then((code) => {
        process.exitCode = code;
      })
      .catch((err) => {
        process.stderr.write(
          `[${AGENT_NAME}] self-test error: ${err && err.message ? err.message : err}\n`,
        );
        process.exitCode = 1;
      });
    return;
  }

  startServer();
}

main();

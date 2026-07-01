'use strict';

// index.js — KRS Print Agent HTTP server (Phase B1: scaffold + detection contract).
//
// A tiny loopback-only HTTP service that runs on the cashier's shop PC. The POS
// web app (served over HTTPS from krspos.innoveraappcenter.com) pings GET /health
// on page load to detect this agent; when present it will route receipt printing
// here as ESC/POS bytes (no browser print dialog). B1 is the scaffold only:
// /print-receipt validates and logs but does NOT print — real ESC/POS is Phase B2.
//
// ZERO npm dependencies: this uses only the Node.js built-in `http` module so it
// runs with a plain `node index.js` and needs no `npm install`.
//
// SECURITY MODEL (B1):
//   1. Bind to 127.0.0.1 ONLY (config.HOST) — never reachable off this machine.
//   2. Trust cross-origin browser requests only from config.ALLOWED_ORIGINS
//      (exact-match echo, never a wildcard "*").
//   3. Cap the request body (config.MAX_BODY_BYTES) to reject abusive payloads.
//   4. No secrets, no auth tokens — loopback + origin allow-list is the boundary.

const http = require('http');
const config = require('./config');
const pkg = require('./package.json');

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
 * POST /print-receipt handler (B1 STUB).
 * Streams and size-limits the body, parses/validates ReceiptData, logs a concise
 * summary, and returns { ok: true, stubbed: true } WITHOUT printing. Real ESC/POS
 * printing is added in Phase B2.
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

    // B1 STUB: no printing. Log a concise summary the operator can eyeball.
    const orderNumber = body.order.orderNumber ?? body.order.id ?? '(unknown)';
    const itemCount = Array.isArray(body.order.items)
      ? body.order.items.length
      : 0;
    console.log(
      `[${AGENT_NAME}] print-receipt (stub) order=${orderNumber} items=${itemCount}`,
    );

    sendJson(res, 200, { ok: true, stubbed: true });
  });
}

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

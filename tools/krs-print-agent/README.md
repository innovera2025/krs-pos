# KRS Print Agent

A tiny, standalone local **ESC/POS print bridge** for KRS POS thermal receipts.
It runs on the cashier's Windows PC and exposes a loopback-only HTTP endpoint on
`127.0.0.1:9100`. The POS web app pings it on page load; when the agent is present
it routes receipt printing here as ESC/POS bytes — **no browser print dialog**.
When the agent is absent the web app falls back silently to its existing
browser/kiosk print path, so the cashier experience is unchanged.

> **This package is NOT part of the Next.js app.** It is not built, bundled, or
> deployed with the web app. It lives in `tools/krs-print-agent/`, has its own
> `package.json`, and runs directly on the shop PC.

## Status

- **Phase B1 (this code): scaffold + detection contract — DONE.**
  HTTP server, `GET /health`, `POST /print-receipt` **stub** (validates + logs,
  does **not** print yet), and CORS / Private Network Access preflight handling.
- Phase B2 adds real ESC/POS receipt rendering to the XP-80C (Thai codepage work).
- Phase B3 packages a Windows `.exe` (`npm run build`) + one-click installer.
- Phase B4 wires the web app to detect and use the agent.

## Requirements

- **Node.js 20+** for development/testing (any OS — macOS/Linux/Windows).
- Windows is only required for the production `.exe` and real printing (Phase B2/B3).
- **Zero npm dependencies** in B1: it uses only the Node.js built-in `http` module.

## Quick start

```bash
cd tools/krs-print-agent
npm start          # or: node index.js
```

You should see:

```
[krs-print-agent] listening on http://127.0.0.1:9100
```

(There is nothing to `npm install` for B1 — dependencies arrive with the ESC/POS
library in Phase B2.)

## Endpoints

| Method | Path              | B1 behavior |
|--------|-------------------|-------------|
| `GET`  | `/health`         | `200` `{ "name": "krs-print-agent", "version": "1.0.0", "status": "ok" }` — the detection probe the web app pings. |
| `POST` | `/print-receipt`  | Accepts `ReceiptData` JSON `{ order, seller, sizeSettings }`. Validates, logs `order=<n> items=<n>`, returns `200` `{ "ok": true, "stubbed": true }`. **Does not print yet** (Phase B2). Bodies over 128 KB are rejected with `413`. |
| `OPTIONS` | (any path)     | `204` with CORS + Private Network Access preflight headers. |
| (other) | (any path)      | `404` `{ "error": "not found" }`. |

### Try it

```bash
curl -s http://127.0.0.1:9100/health

curl -s -X POST http://127.0.0.1:9100/print-receipt \
  -H 'Content-Type: application/json' \
  -d '{"order":{"orderNumber":"POS-TEST-1","items":[{}]},"seller":null,"sizeSettings":null}'
```

## CORS & Private Network Access (why these headers exist)

The POS web app is served over **HTTPS** (`https://krspos.innoveraappcenter.com`),
but this agent listens over plain **HTTP** on `127.0.0.1`. For a browser to let an
HTTPS page call a loopback/private address it must pass **two** checks:

1. **CORS** — the agent echoes `Access-Control-Allow-Origin` for the exact request
   origin **only** if that origin is in the allow-list (production POS origin, or
   `localhost:3000` / `127.0.0.1:3000` for Next.js dev). It never uses a wildcard.
2. **Chrome Private Network Access (PNA)** — Chromium sends an extra preflight with
   `Access-Control-Request-Private-Network: true`. The agent answers with
   `Access-Control-Allow-Private-Network: true`, allowing the HTTPS→loopback call.

Requests from any other origin get an empty allow-origin (deny) and a stderr warning.

## Configuration

Defaults live in `config.js` (committed, no secrets). Common overrides:

| Setting | Env var | Default | Notes |
|---------|---------|---------|-------|
| Port | `KRS_PRINT_AGENT_PORT` (or `PORT`) | `9100` | |
| Printer name | `KRS_PRINTER_NAME` | `""` (Windows default printer) | Used in Phase B2. |
| Thai codepage | `KRS_THAI_CODEPAGE` | `20` (TIS-620) | ESC `t` code-table; used in Phase B2. |

For persistent per-shop settings without editing the committed file, create a
git-ignored **`config.local.js`** that re-exports overrides:

```js
// config.local.js  (git-ignored)
const base = require('./config');
module.exports = { ...base, PRINTER_NAME: 'XP-80C', THAI_CODEPAGE: 21 };
```

## Security

- Binds `127.0.0.1` **only** — never `0.0.0.0`. Not reachable off the shop PC.
- Accepts cross-origin browser calls only from the listed POS origins.
- Caps request bodies at 128 KB (`413` otherwise). A receipt JSON is ~2–5 KB.
- No authentication tokens and no secrets — loopback + origin allow-list is the
  trust boundary.

## Build (Phase B3)

`npm run build` will package the agent into a single Windows executable at
`dist/krs-print-agent.exe` (via `pkg`). `dist/`, `*.exe`, `node_modules/`, and
`config.local.js` are all git-ignored.

## Thai codepage note (Phase B2)

Thai glyphs on the XP-80C are selected with the ESC `t <n>` code-table command.
The default is table `20` (TIS-620); the exact number is firmware-specific on
XP-80 OEM clones. Override with `KRS_THAI_CODEPAGE` (candidates: 20 → 21 → 18 → 17)
without a code change once the owner confirms the correct value on the real printer.

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

- **Phase B1: scaffold + detection contract — DONE.**
  HTTP server, `GET /health`, CORS / Private Network Access preflight handling.
- **Phase B2: ESC/POS receipt rendering — CODE DONE (owner hardware test pending).**
  `POST /print-receipt` now renders the full receipt (`printer.js` + `encoding.js`)
  and spools it to the Windows printer. Developer gates pass (buffer builds, Thai
  encodes to TIS-620, server never crashes). **Real Thai rendering + cut + alignment
  on the physical XP-80C is owner-verified** — see "Phase B2 — printing & Thai
  codepage" below.
- **Phase B3: packaging + one-click installer + autostart — CODE DONE (owner
  Windows test pending).** `npm run build` produces a single Windows `.exe`
  (`dist/krs-print-agent.exe`), `deploy/setup-print-agent.bat` installs it with
  hidden autostart, and `krs-print-agent.exe --test` runs the self-test — see
  "Phase B3 — build, install & autostart" below.
- Phase B4 wires the web app to detect and use the agent.

## Requirements

- **Node.js 20+** for development/testing (any OS — macOS/Linux/Windows).
- **Windows** is required for **real printing**: the agent spools ESC/POS bytes to the
  Windows print queue via the built-in print spooler (no native/node-gyp modules). On
  macOS/Linux the receipt bytes still build (for inspection) but cannot be spooled.
- Dependencies (installed into this package's own git-ignored `node_modules`):
  `node-thermal-printer` (ESC/POS buffer assembly) and `iconv-lite` (Thai TIS-620).
  The HTTP layer itself uses only Node's built-in `http` module.

## Quick start

```bash
cd tools/krs-print-agent
npm install        # installs node-thermal-printer + iconv-lite (local, git-ignored)
npm start          # or: node index.js
```

You should see:

```
[krs-print-agent] listening on http://127.0.0.1:9100
```

## Endpoints

| Method | Path              | B1 behavior |
|--------|-------------------|-------------|
| `GET`  | `/health`         | `200` `{ "name": "krs-print-agent", "version": "1.0.0", "status": "ok" }` — the detection probe the web app pings. |
| `POST` | `/print-receipt`  | **(text ESC/POS — diagnostics / back-compat)** Accepts `ReceiptData` JSON `{ order, seller, sizeSettings }`. Renders ESC/POS text and spools to the Windows printer. Returns `200` `{ "ok": true }` on success, `500` `{ "ok": false, "error": "..." }` on any print failure (a spooler/printer error never crashes the server). Malformed JSON or a missing `order` → `400`; bodies over 128 KB → `413`. |
| `POST` | `/print-image`    | **(RASTER — the path the POS now uses)** Accepts `{ "imagePngBase64": "<base64 PNG>" }` (black content on a **white** background, ~576 px wide = 80 mm printable). The agent decodes the PNG, thresholds it to 1-bit, and prints it as ESC/POS **raster** (`GS v 0`) + feed + partial cut. Returns `200` `{ "ok": true }` on success, `500` `{ "ok": false, "error": "..." }` on any failure (bad PNG / spooler error never crashes the server). Malformed JSON or a missing/empty `imagePngBase64` → `400`; bodies over 2 MB → `413`. **Raster needs NO printer font, so Thai (rendered by the BROWSER) prints correctly on any ESC/POS printer.** |
| `OPTIONS` | (any path)     | `204` with CORS + Private Network Access preflight headers. |
| (other) | (any path)      | `404` `{ "error": "not found" }`. |

### Try it

```bash
curl -s http://127.0.0.1:9100/health

curl -s -X POST http://127.0.0.1:9100/print-receipt \
  -H 'Content-Type: application/json' \
  -d '{"order":{"orderNumber":"POS-TEST-1","items":[{}]},"seller":null,"sizeSettings":null}'

# RASTER path (the one the POS uses): a base64 PNG, black-on-white, ~576 px wide.
curl -s -X POST http://127.0.0.1:9100/print-image \
  -H 'Content-Type: application/json' \
  -d '{"imagePngBase64":"<base64 of a 576px-wide PNG>"}'
```

## Raster image printing (Thai without a printer font)

The POS now prints receipts as a **raster image**, not as text ESC/POS. The **browser**
renders the receipt (Thai and all) to a `~576 px`-wide PNG (black content on a **white**
background) and `POST`s it to `/print-image` as base64. The agent decodes the PNG with a
**pure-JS** decoder (`pngjs` — no native/node-gyp modules, so the `pkg` single-exe build
stays clean), thresholds it to 1-bit (black where luminance `< ~128`; `alpha = 0` → white),
and emits it as ESC/POS **raster** via `GS v 0` (`0x1D 0x76 0x30`), followed by a feed and
partial cut. Tall receipts are **banded** into vertical chunks (≤ 255 dot rows per `GS v 0`
call, emitted back-to-back) so the whole receipt prints.

**Why raster:** dot/raster printing needs **no on-board printer font or Thai code table**,
so Thai renders correctly on **any** ESC/POS printer — this sidesteps the firmware-specific
`ESC t` codepage / Kanji-mode problem entirely (see "Phase B2 — Thai codepage" below, kept
for the legacy text path). The raster path does **not** send `FS .` or `ESC t` (irrelevant
for dots). Prove it on the real printer with `krs-print-agent.exe --test-image`, which runs
an in-code test bitmap through the same raster path — no browser needed.

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
| Printer name | `KRS_PRINTER_NAME` | `""` (Windows default printer) | Target a specific queue, e.g. `XP-80C`. |
| Thai codepage | `KRS_THAI_CODEPAGE` | `20` (TIS-620) | `ESC t <n>` code-table; iterate `20 → 21 → 18 → 17` on the real printer. |
| Baht fallback | `KRS_BAHT_FALLBACK` | `0` | Set `1` to print `B` instead of `฿` if the firmware maps 0xDF wrong. |

### Runtime overrides (no rebuild — works inside the packaged `.exe`)

`config.js` is bundled into `krs-print-agent.exe`, so it cannot be edited after
packaging. Overrides are instead read at startup, in this precedence order (highest
first). For the `.exe` the files are looked up **next to the executable**
(`%LOCALAPPDATA%\KrsPrintAgent\`); in dev they are read next to the source files.

1. **Environment variables** — `KRS_PRINTER_NAME`, `KRS_THAI_CODEPAGE`,
   `KRS_BAHT_FALLBACK`, `KRS_PRINT_AGENT_PORT` / `PORT`.
2. **`.env` file** (`.env` or `agent.env`) — `KEY=VALUE` lines, applied to any key
   not already set in the real environment. Example:
   ```
   KRS_THAI_CODEPAGE=21
   KRS_PRINTER_NAME=XP-80C
   ```
3. **`config.local.json`** — a JSON object of overrides. Example:
   ```json
   { "THAI_CODEPAGE": 21, "PRINTER_NAME": "XP-80C", "BAHT_FALLBACK": true }
   ```
4. The hardcoded defaults in `config.js`.

This lets the owner iterate the Thai codepage on the real printer **without a
rebuild** — drop a `config.local.json` (or `.env`) next to the `.exe`, then re-run
the installer or reboot. `HOST` (loopback) and `ALLOWED_ORIGINS` are security
invariants and are intentionally **not** overridable from disk/env.

A dev-only git-ignored **`config.local.js`** (a CommonJS re-export) also still works
when running from source, but does **not** apply inside the packaged `.exe` — use
`.env` or `config.local.json` for the shipped agent:

```js
// config.local.js  (git-ignored, dev-from-source only)
const base = require('./config');
module.exports = { ...base, PRINTER_NAME: 'XP-80C', THAI_CODEPAGE: 21 };
```

## Security

- Binds `127.0.0.1` **only** — never `0.0.0.0`. Not reachable off the shop PC.
- Accepts cross-origin browser calls only from the listed POS origins.
- Caps request bodies at 128 KB (`413` otherwise). A receipt JSON is ~2–5 KB.
- No authentication tokens and no secrets — loopback + origin allow-list is the
  trust boundary.

## Phase B3 — build, install & autostart

### 1. Build the Windows `.exe`

```bash
cd tools/krs-print-agent
npm install          # installs deps + the @yao-pkg/pkg devDependency
npm run build        # -> dist/krs-print-agent.exe  (single-file, ~58 MB)
```

`npm run build` runs `pkg . --targets node22-win-x64 --output dist/krs-print-agent.exe`.

- **Packager: [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg)** — the maintained fork
  of the archived `vercel/pkg`. It cross-compiles a single `.exe` from macOS/Linux and
  bundles the Node runtime + all deps, so the shop PC needs **no Node install**.
- **Target `node22-win-x64`.** `pkg-fetch` currently ships prebuilt Windows base
  binaries for node **22 / 24 / 26** only (not 18 / 20), and 22 matches the Node used
  to build here — so `node22` is the correct win-x64 target. (Targeting `node20-win-x64`
  fails with a `pkg-fetch` 404; if you must pin a different major, pick one that
  `pkg-fetch` publishes a win-x64 prebuilt for.)
- **`pkg` config** lives in `package.json` (`"bin"`, `"pkg".targets`, `"pkg".assets`).
  The `assets` globs bundle `iconv-lite`'s `encodings/tables/*.json` from both
  iconv-lite copies so no code path can crash at runtime for a missing encoding table.

Verify the artifact is a real Windows PE:

```bash
file dist/krs-print-agent.exe
# dist/krs-print-agent.exe: PE32+ executable (console) x86-64, for MS Windows
```

`dist/`, `*.exe`, `node_modules/`, `config.local.js`, `config.local.json`, `.env`, and
`agent.env` are all git-ignored — the binary is distributed out-of-band (e.g. a GitHub
Release), not committed.

> The `.exe` is built and validated as a win-x64 PE on the dev machine, but **actually
> running it, printing Thai on the XP-80C, and autostart on boot are owner-verified on
> Windows** — a macOS/Linux dev host cannot execute a Windows `.exe`.

### 2. Self-test the packaged `.exe` (no Node, no web app)

On the shop Windows PC, with the XP-80C installed:

```bat
krs-print-agent.exe --test
```

`--test` (alias `--selftest`) prints the **same** sample receipt as
`npm run test-print` — reusing the exact `SAMPLE` from `scripts/test-print.js` — then
exits. Use it to confirm Thai rendering + the packaging on the real printer. Other flags:

```bat
krs-print-agent.exe --test-image REM print a self-contained RASTER test bitmap (GS v 0), then exit
krs-print-agent.exe --scan       REM print a Thai codepage scan (ESC t 0..79), then exit
krs-print-agent.exe --version    REM print the agent version and exit
krs-print-agent.exe --help       REM usage + the runtime-config env/file summary
krs-print-agent.exe              REM (no flag) start the server on 127.0.0.1:9100
```

`--test-image` builds a small bitmap **in code** (a bordered box + diagonal — **no font,
no Thai codepage**), runs it through the exact same PNG → 1-bit → `GS v 0` raster path as
`POST /print-image`, and spools it once. Use it to confirm the printer accepts **raster**
end-to-end without a browser. (Real Thai still comes from the browser via `/print-image`;
`--test-image` only proves the printer renders raster dots.)

`--scan` prints ONE strip that renders a short Thai sample (`กขคงจ ๑๒๓`) under **every**
`ESC t` code table from `0` to `79`, one per line (`n=<n>: <sample>`), after the same
`FS .` Kanji-cancel. See "Find the Thai codepage with `--scan`" below for how to read it.

### 3. One-click install + autostart (`deploy/setup-print-agent.bat`)

Put `krs-print-agent.exe` and `deploy/setup-print-agent.bat` in the **same folder**,
then double-click the `.bat`. It (idempotently, no admin needed):

1. Stops any running agent, then copies the `.exe` to `%LOCALAPPDATA%\KrsPrintAgent\`.
2. Sets **XP-80C** as the Windows default printer and **locks** it
   (`LegacyDefaultPrinterMode=1`, same as `kiosk-print-setup.bat`) so it sticks.
3. Registers **hidden autostart**: a `launch-hidden.vbs` (window mode `0`) in
   `%LOCALAPPDATA%\KrsPrintAgent\`, launched by a Startup-folder shortcut at
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\KRS Print Agent.lnk`
   on every logon — **no console window**.
4. Starts the agent now and pings `http://127.0.0.1:9100/health`, reporting RUNNING /
   NOT RESPONDING.

> **SmartScreen:** a `.bat`/`.exe` downloaded from the internet may show a security
> warning. Click **"More info" → "Run anyway"**.

After the shop PC reboots, the agent is already running (hidden) on logon — the cashier
just opens the POS in any normal browser; receipts print with no dialog, no shortcut.

### 4. Change the Thai codepage / printer on the installed agent

No rebuild needed — drop a file next to the installed `.exe`
(`%LOCALAPPDATA%\KrsPrintAgent\`), then reboot or re-run the installer:

```json
// %LOCALAPPDATA%\KrsPrintAgent\config.local.json
{ "THAI_CODEPAGE": 21, "PRINTER_NAME": "XP-80C" }
```

or an env-style file:

```
REM %LOCALAPPDATA%\KrsPrintAgent\.env
KRS_THAI_CODEPAGE=21
```

Iterate `20 → 21 → 18 → 17` (running `krs-print-agent.exe --test` after each) until the
Thai prints correctly. See "Runtime overrides" above for full precedence.

### 5. Uninstall

Edit the top of `deploy/setup-print-agent.bat`, change `set "ACTION=install"` to
`set "ACTION=uninstall"`, and run it again. It stops the agent and removes the Startup
shortcut, the `launch-hidden.vbs`, the `.exe`, and the `%LOCALAPPDATA%\KrsPrintAgent\`
folder. (The Windows default-printer setting is left as-is — change it manually if you
wish.) To disable autostart only, just delete the Startup shortcut:
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\KRS Print Agent.lnk`.

## Phase B2 — printing & Thai codepage (owner test)

`POST /print-receipt` (and `npm run test-print`) build an 80mm / 48-column (Font A)
ESC/POS stream in `printer.js` that mirrors the web receipt
(`src/components/pos/ReceiptModal.tsx`): centred bold header + `ใบเสร็จรับเงินสด`
title, meta rows, line items (`name … lineTotal`, then indented `qty x unitPrice`),
`รวมสุทธิ` total, payment lines + `เงินทอน` change, the optional taxpayer block, the
`ราคานี้รวมภาษีมูลค่าเพิ่ม 7% แล้ว` note, footer, and a partial cut.

**How Thai is printed.** node-thermal-printer's `CharacterSet` enum has no Thai
entry, so the agent selects the printer's Thai code table itself with
`ESC t <KRS_THAI_CODEPAGE>` and sends every Thai string as **TIS-620 bytes**
(`encoding.js`, via `iconv-lite`). `×`, `·` and `…` (absent from TIS-620) are
transliterated to `x`, `-`, `...` so nothing prints as `?`.

**Kanji mode must be OFF (`FS .`).** Chinese-firmware XP-80C units boot with
**Kanji / multi-byte mode ON**, which consumes each *pair* of Thai high-bytes as one
double-byte **Chinese** glyph — so Thai prints as Chinese and changing only the
codepage number does nothing. `printer.js` therefore **always** emits `FS .`
(`0x1C 0x2E`, "cancel Kanji character mode") right after `ESC @` and **before** the
`ESC t` code-table selection, forcing single-byte mode so the Thai table applies to
`0x80–0xFF`. This cancel is unconditional (no config toggle). Getting correct Thai on
these units needs **both** Kanji mode off (now automatic) **and** the right `ESC t`
number (below).

**How the job reaches the printer.** The ESC/POS buffer is spooled to Windows as a
`RAW` job through the print spooler (winspool, via a generated PowerShell helper) —
**no native/node-gyp module**, which keeps the Phase-B3 `pkg` single-exe build clean.
`KRS_PRINTER_NAME` targets a specific queue; empty = the Windows default printer.

### Owner test on the real XP-80C

The correct Thai `ESC t` table number is firmware-specific on XP-80 OEM clones and
can only be confirmed on the physical printer. Run this on the shop Windows PC:

```bat
npm install
npm run test-print
```

#### Find the Thai codepage with `--scan` (fastest)

If the test receipt prints **Chinese** (or other garbage) for Thai, the printer's
`ESC t` table number is wrong. Instead of guessing one value at a time, print the
whole sweep once:

```bat
krs-print-agent.exe --scan
REM (from source: node index.js --scan)
```

This prints a single strip with a Thai sample (`กขคงจ ๑๒๓`) under **every** code table
`0..79`, one per line:

```
=== THAI CODEPAGE SCAN ===
Find the line with READABLE THAI -> that n = KRS_THAI_CODEPAGE
sample = "กขคงจ ๑๒๓"
n=0: <sample under table 0>
n=1: <sample under table 1>
...
n=79: <sample under table 79>
```

Read the strip, find the `n=<n>:` line whose Thai is **readable**, and set that number
permanently (no rebuild):

```json
// config.local.json (next to the .exe)
{ "THAI_CODEPAGE": 21 }
```

or `set KRS_THAI_CODEPAGE=21`. The scan already sends `FS .` (Kanji-cancel) once up
front, so its lines are a fair single-byte test of each table. If **no** line on the
strip shows readable Thai, the firmware likely lacks a TIS-620 table — request the
code-table spec from Xprinter.

Then inspect the printed sample and iterate as needed (no code change — just env):

1. **Thai garbled?** Try the next code table, reprint after each:
   ```bat
   set KRS_THAI_CODEPAGE=21 && npm run test-print
   set KRS_THAI_CODEPAGE=18 && npm run test-print
   set KRS_THAI_CODEPAGE=17 && npm run test-print
   ```
   (PowerShell: `$env:KRS_THAI_CODEPAGE=21; npm run test-print`.) Record the value
   that prints correct Thai and set it permanently in a git-ignored `config.local.js`
   or as a machine env var.
2. **`฿` shows garbage?** `set KRS_BAHT_FALLBACK=1 && npm run test-print` (prints `B`).
3. **Wrong / no printer?** `set KRS_PRINTER_NAME=XP-80C && npm run test-print`.
4. Confirm: the `-`/`=` rules fill the width without wrapping, the partial cut
   separates the receipt cleanly, and a long Thai product name truncates with `...`
   instead of overflowing the line.

If none of `20 → 21 → 18 → 17` produce correct Thai, request the firmware code-table
spec from Xprinter before shipping the agent.

> **Real-print correctness (Thai glyphs, cut, alignment on the XP-80C) is
> owner-verified.** A headless/dev host can only prove the bytes build correctly and
> that Thai encodes to TIS-620 — it cannot prove how the physical printer renders them.

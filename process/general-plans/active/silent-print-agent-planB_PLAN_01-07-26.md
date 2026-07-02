# Plan B — Local Silent Print Agent

**Date**: 01-07-26
**Complexity**: COMPLEX — 4 dependent phases (B1 → B2 → B3 → B4)
**Status**: PLANNED
**Selected plan file:** `process/general-plans/active/silent-print-agent-planB_PLAN_01-07-26.md`
**Cross-reference (Plan A):** `process/general-plans/active/silent-print-onboarding_PLAN_01-07-26.md`

---

## Overview

Plan A (already shipped) makes the kiosk `.bat` discoverable in-product but still
requires a one-time OS-level step and a special desktop shortcut. Cashiers in a normal
browser window always see a print dialog on receipt.

Plan B removes that constraint entirely. A tiny standalone Node.js app — the
**local print agent** — runs on the shop PC and exposes a local HTTP endpoint on
`127.0.0.1:9100`. The POS web app pings the agent on page load; when the agent is
present it routes all receipt printing through it (ESC/POS bytes, no dialog); when
absent it falls back silently to the existing `BrowserPrintService` / Plan A kiosk
path — the cashier experience is unchanged.

**True silent printing = install once, open any browser, no shortcut, no dialog.**

---

## Feature Folder Recommendation

Receipt-printing artifacts now number 5+:

1. `src/lib/print/` — the shipped print abstraction (interface, BrowserPrintService,
   PrintAgentService stub, types)
2. `deploy/kiosk-print-setup.bat`
3. `deploy/RECEIPT-PRINTING.md`
4. `process/general-plans/active/silent-print-onboarding_PLAN_01-07-26.md` (Plan A)
5. `process/general-plans/active/silent-print-agent-planB_PLAN_01-07-26.md` (this plan)

**Recommendation:** Promote `process/features/receipt-printing/` in the next UPDATE
PROCESS pass after both Plan A and Plan B are complete. Do NOT move files during Plan B
execution — housekeeping can wait until both plans are implemented and verified.

---

## Cross-Reference: Plan A

Plan A is shipped as a separate session and is the prerequisite for the onboarding
modal logic this plan extends.

Plan A delivered:
- `public/kiosk-print-setup.bat` (static asset at `/kiosk-print-setup.bat`)
- `deploy/kiosk-print-setup.bat` (with `?kiosk=1` appended to POS_URL)
- `src/lib/kioskMode.ts` — localStorage helpers:
  `persistKioskModeIfFlagged`, `isKioskMode`, `isDismissed`, `markDismissed`,
  `shouldShowOnboardingModal`
- `src/components/pos/SilentPrintOnboardingModal.tsx` — first-run modal
- `src/app/(shell)/pos/page.tsx` — mount effect + `onboardingOpen` state
- `next.config.mjs` — `Content-Disposition: attachment` for `/kiosk-print-setup.bat`
- `deploy/RECEIPT-PRINTING.md` — in-app onboarding section

Plan B **extends** Plan A's onboarding modal and **replaces** the browser print path
when the agent is detected. Plan A remains the silent fallback when the agent is
absent. Both plans must be independently deployable.

---

## What Is Already Shipped (Build On These — Do Not Re-implement)

All four files in `src/lib/print/` are LIVE. Read them before every execution.

### `src/lib/print/types.ts`
- `ReceiptData`: `{ order: OrderDTO; seller: Partial<ShopSettingsDTO>|null; sizeSettings: ShopSettingsDTO|null }`
- `ReceiptPrintService`: `{ printReceipt(receipt: ReceiptData): Promise<void> }`

### `src/lib/print/browserPrintService.ts`
- `BrowserPrintService` — wraps `window.print()`; polls DOM for `.print-receipt`
  via `requestAnimationFrame`; resolves on `afterprint` or 5 s fallback.
  Currently returned by `getReceiptPrintService()`.

### `src/lib/print/printAgentService.ts`
- `PrintAgentService` — already stubs the POST to `http://localhost:9100/print-receipt`
  with `AbortController` timeout (default `timeoutMs: 4000`) and `failOpen` option.
  **Not wired by default.**
- `PrintAgentOptions`: `{ endpoint?: string; timeoutMs?: number; failOpen?: boolean }`

### `src/lib/print/index.ts`
- `getReceiptPrintService(): ReceiptPrintService` — returns `new BrowserPrintService()`
  today. The plan comment already documents the one-line swap to `PrintAgentService`.

### Receipt visual specification (`src/components/pos/ReceiptModal.tsx` `.print-receipt`)

The ESC/POS agent must faithfully reproduce this layout:

```
HEADER (dashed border below, centre-aligned):
  <sellerName>                   bold, ~14px equivalent
  <branchLine>                   secondary
  โทร <sellerPhone>              if non-empty
  POS: <sellerPosId>             if non-empty
  <sellerAddress>                if non-empty (may wrap)
  เลขประจำตัวผู้เสียภาษี <taxId>  if non-empty
  ใบเสร็จรับเงินสด              bold, centred

META section (dashed borders above + below):
  เลขที่ POS        | <orderNumber>      (left label, right value, 48-char width)
  เลขเอกสารบัญชี   | <acctNo>
  วันที่            | <formatted date>
  แคชเชียร์         | <cashierName>

LINE ITEMS (for each item):
  <productName>               <lineTotal>    (columns, 48 chars total)
    <qty> × <unitPrice>                      (indented 2 chars)

TOTALS (double-rule separator):
  รวมสุทธิ                    <total>        bold

PAYMENT LINES (dashed border above):
  <methodLabel>               <amount>
  เงินทอน                     <change>       bold (only if change > 0)

TAX-PAYER BLOCK (conditional: order.taxRequested && order.customer?.taxId):
  ข้อมูลผู้เสียภาษี
  <customer.name>
  <customer.address>          (if present)
  TIN <customer.taxId>

FOOTER:
  ราคานี้รวมภาษีมูลค่าเพิ่ม 7% แล้ว  (centred)
  ขอบคุณที่ใช้บริการ · Thank you       (centred)

PARTIAL CUT
```

### Payment method labels (`src/components/pos/paymentMeta.ts`)

The agent must replicate this exact Thai mapping (read from `paymentMeta.ts`):

| key (lowercased) | Thai label |
|---|---|
| `cash` | เงินสด |
| `transfer` | โอนเงิน |
| `qr` | QR PromptPay |
| `card` | บัตรเครดิต |
| `ewallet` | e-Wallet |
| `other` | อื่นๆ |

### Money format (`src/lib/money.ts` `money()`)

Output: `฿X,XXX.XX` (baht sign, comma thousands separator, 2 decimal places).
The agent must produce identical output for all price/total fields.

---

## Architecture Summary

```
shop PC (Windows)
  tools/krs-print-agent/        ← NEW standalone package, NOT deployed to server
    krs-print-agent.exe          (pkg-bundled Node.js app, runs on boot via Startup folder)
      HTTP server → 127.0.0.1:9100 ONLY
        GET  /health             → 200 {name, version, status}
        POST /print-receipt      → accepts ReceiptData JSON → ESC/POS → XP-80C
        OPTIONS *                → CORS + Private Network Access preflight

web app (browser on same shop PC, any browser — Chrome/Edge)
  src/lib/print/index.ts
    resolveReceiptPrintService() ← NEW async resolver (B4); module-level cache
      ├─ ping GET http://127.0.0.1:9100/health (1500 ms timeout)
      │   ├─ 200 → cache PrintAgentService(failOpen:true)
      │   └─ failure/timeout → cache BrowserPrintService
      └─ subsequent calls: return cached service immediately

  src/app/(shell)/pos/page.tsx
    mount:
      1. persistKioskModeIfFlagged()  (Plan A, unchanged)
      2. await resolveReceiptPrintService() → printServiceRef.current
      3. agentDetected = instanceof PrintAgentService
      4. modal suppression: agentDetected || isKioskMode || isDismissed → open=false
    payment confirm:
      svc = printServiceRef.current
      isAgent = svc instanceof PrintAgentService
      void svc.printReceipt(receipt)   ← fire-and-forget
      openReceiptModal(order, { autoPrint: !isAgent })

PrintAgentService path: POST ReceiptData → agent ESC/POS → XP-80C (NO dialog)
BrowserPrintService path: window.print() (kiosk or browser dialog — existing behavior)
```

**The agent is NOT a Docker service and is NOT deployed to the server.**
Web app changes ARE deployed via existing Docker/Caddy to `krspos.innoveraappcenter.com`.

---

## Phase B1 — Agent Scaffold + Detection Contract

### Goal

A working HTTP server at `127.0.0.1:9100` that:
- Returns `{ name: "krs-print-agent", version: "1.0.0", status: "ok" }` from GET /health.
- Accepts POST /print-receipt with ReceiptData JSON and returns `{ ok: true, stub: true }` (no real printing yet).
- Handles OPTIONS preflights with correct CORS + Private Network Access headers.
- Can be started with `node index.js` from `tools/krs-print-agent/`.

This phase is the first buildable slice. The web app can integrate against it (Phase B4
detection logic) before Phase B2's ESC/POS is complete.

### Phase B1 Touchpoints

| Path | Change | Description |
|---|---|---|
| `tools/krs-print-agent/` | CREATE DIR | Standalone agent app root (NOT inside `src/`) |
| `tools/krs-print-agent/package.json` | CREATE | Own package.json, private: true |
| `tools/krs-print-agent/config.js` | CREATE | PORT, HOST, ALLOWED_ORIGINS, PRINTER_NAME, MAX_BODY_BYTES |
| `tools/krs-print-agent/index.js` | CREATE | HTTP server entry point — health + print-receipt + OPTIONS |
| `tools/krs-print-agent/.gitignore` | CREATE | Exclude node_modules/, dist/, *.exe, config.local.js |
| `tools/krs-print-agent/README.md` | CREATE | Developer + operator guide |
| `deploy/RECEIPT-PRINTING.md` | EDIT | Add Plan B architecture section |

### Phase B1 Steps

**B1-1. Create `tools/krs-print-agent/package.json`**

Required fields:
- `name`: `"krs-print-agent"`
- `version`: `"1.0.0"`
- `description`: `"Local ESC/POS print bridge for KRS POS thermal receipts"`
- `main`: `"index.js"`
- `scripts.start`: `"node index.js"`
- `scripts.build`: `"npx pkg . --target node20-win-x64 --output dist/krs-print-agent.exe"` (used in B3)
- `engines.node`: `">=20"`
- `private`: `true`
- `license`: `"UNLICENSED"`
- `dependencies`: `{}` (ESC/POS library added in B2)
- `devDependencies`: `{}` (pkg added in B3)

**B1-2. Create `tools/krs-print-agent/config.js`**

CommonJS module exporting:
- `PORT`: `9100`
- `HOST`: `"127.0.0.1"` — NEVER `"0.0.0.0"`
- `ALLOWED_ORIGINS`: array containing:
  - `"https://krspos.innoveraappcenter.com"` (production)
  - `"http://localhost:3000"` (Next.js dev)
  - `"http://127.0.0.1:3000"` (Next.js dev alt)
- `PRINTER_NAME`: `process.env.KRS_PRINTER_NAME ?? ""` — empty string = Windows default printer
- `MAX_BODY_BYTES`: `131072` (128 KB; a receipt JSON is ~2–5 KB)
- `THAI_CODEPAGE`: `parseInt(process.env.KRS_THAI_CODEPAGE ?? "20", 10)` (used in B2)

Document that `config.local.js` (git-ignored) may re-export overrides for shop-specific
settings (printer name, codepage) without modifying the committed file.

**B1-3. Create `tools/krs-print-agent/index.js` — HTTP server**

Use Node.js built-in `http` module. No Express or external framework.

Implementation contract:

a. `require('./config')` for PORT, HOST, ALLOWED_ORIGINS, MAX_BODY_BYTES.

b. `function setCorsHeaders(req, res)` helper:
   - Read `req.headers.origin`.
   - If origin is in `ALLOWED_ORIGINS`:
     - `Access-Control-Allow-Origin: <request origin>` (exact, not `*`)
     - `Access-Control-Allow-Methods: GET, POST, OPTIONS`
     - `Access-Control-Allow-Headers: Content-Type`
     - `Access-Control-Allow-Private-Network: true` (Chrome PNA requirement)
     - `Access-Control-Max-Age: 86400`
   - If origin is NOT in `ALLOWED_ORIGINS`:
     - Set `Access-Control-Allow-Origin` to empty string; write a warning to stderr.
   - Call on every request handler before any other response header.

c. `OPTIONS *` preflight: call `setCorsHeaders`, respond `204 No Content`, no body.

d. `GET /health`: call `setCorsHeaders`, respond `200 application/json`
   `{ name: "krs-print-agent", version: "1.0.0", status: "ok" }`.

e. `POST /print-receipt`:
   - Call `setCorsHeaders`.
   - Stream-accumulate request body chunks; if cumulative size exceeds `MAX_BODY_BYTES`,
     drain and respond `413 { error: "payload too large" }`.
   - Parse JSON; if malformed respond `400 { error: "invalid JSON" }`.
   - Validate: body must have `order` (object). If missing, respond `400 { error: "order required" }`.
   - **STUB (B1):** `console.log('[krs-print-agent] print-receipt stub, orderId=', body.order?.id)`.
     Respond `200 { ok: true, stub: true }`.
   - The real print call is added in B2.

f. All other method/path combinations: respond `404 { error: "not found" }`.

g. `server.listen(PORT, HOST, () => { console.log('[krs-print-agent] listening on http://' + HOST + ':' + PORT) })`.

h. Graceful shutdown: listen for `SIGTERM` and `SIGINT`; call `server.close()` and `process.exit(0)`.

**B1-4. Create `tools/krs-print-agent/.gitignore`**

```
node_modules/
dist/
*.exe
config.local.js
```

**B1-5. Create `tools/krs-print-agent/README.md`**

Document:
- Purpose: local ESC/POS print bridge, runs on the cashier's Windows PC
- Requirements: Node.js 20+, Windows (for production .exe — dev/test on any OS)
- Quick start: `cd tools/krs-print-agent && npm install && npm start`
- Configuration: `config.local.js` overrides (printer name, Thai codepage, port)
- Security: binds 127.0.0.1 only; accepts listed POS origins only; no auth beyond origin
- Endpoints: `GET /health`, `POST /print-receipt`
- Build: Phase B3 delivers `npm run build` → `dist/krs-print-agent.exe`
- Thai codepage: default ESC t code-table 20 (TIS-620); override via `KRS_THAI_CODEPAGE`

**B1-6. Edit `deploy/RECEIPT-PRINTING.md` — add Plan B architecture section**

Add a new section before "Developer / architecture notes":
```
## Plan B — Local Print Agent (dialog-free in any browser)
```
Include:
- What the agent is and why it eliminates the kiosk-shortcut requirement
- Text-art architecture diagram (matching the one in this plan's Architecture Summary section)
- Install path: Phase B3 delivers `deploy/setup-print-agent.bat`
- Detection: automatic (web app pings /health on every POS page load)
- Fallback: when agent is absent, Plan A kiosk path continues to work unchanged
- Status note: "Agent integration is in active development — see Plan B for phase status"

### Phase B1 Verification Gates

**Required before B1 is code-done:**

1. `cd tools/krs-print-agent && node index.js` logs `listening on http://127.0.0.1:9100` without error.
2. `curl -s http://127.0.0.1:9100/health` returns `{"name":"krs-print-agent","version":"1.0.0","status":"ok"}`.
3. `curl -s -X OPTIONS http://127.0.0.1:9100/health -H "Origin: https://krspos.innoveraappcenter.com" -H "Access-Control-Request-Private-Network: true" -v 2>&1 | grep -i "Allow-Private-Network"` confirms `Access-Control-Allow-Private-Network: true`.
4. `curl -s -X OPTIONS http://127.0.0.1:9100/health -H "Origin: https://evil.example.com" -v 2>&1` confirms `Access-Control-Allow-Origin` is NOT `https://evil.example.com`.
5. `curl -s -X POST http://127.0.0.1:9100/print-receipt -H "Content-Type: application/json" -d '{"order":{"id":"test-001"}}'` returns `{"ok":true,"stub":true}` and agent stdout shows the stub log.
6. Oversized body (generate with `python3 -c "print('x'*200000)"` piped to curl POST): confirm `413` response.
7. `curl -s http://127.0.0.1:9100/unknown-path` returns `404`.
8. `npm run type-check` and `npm run build` for the Next.js app both pass (B1 adds no web-app changes; confirm the app is clean before B4 editing begins).

**No owner hardware test required in B1.** The agent prints nothing yet.

---

## Phase B2 — ESC/POS Receipt Rendering

### Goal

The POST /print-receipt handler renders the full `ReceiptData` payload as ESC/POS bytes
and submits a print job to the Windows printer spooler (XP-80C or any configured
default printer). The output faithfully mirrors the `.print-receipt` HTML layout.

**This is the hardest phase.** Thai character encoding requires iteration on the real
XP-80C to confirm the correct codepage selector. This plan documents the expected
approach and flags every owner-test point honestly. B2 cannot be VERIFIED without
a real-printer test.

### Phase B2 Touchpoints

| Path | Change | Description |
|---|---|---|
| `tools/krs-print-agent/package.json` | EDIT | Add `node-thermal-printer` dependency |
| `tools/krs-print-agent/printer.js` | CREATE | ESC/POS receipt renderer — accepts ReceiptData, submits print job |
| `tools/krs-print-agent/encoding.js` | CREATE | Thai string encoding helper (TIS-620 via iconv-lite) |
| `tools/krs-print-agent/scripts/test-print.js` | CREATE | Standalone CLI: print a hardcoded sample receipt for owner codepage testing |
| `tools/krs-print-agent/index.js` | EDIT | Replace B1 stub with real `await printReceipt(body)` call |

### Library Recommendation: `node-thermal-printer`

**Primary: `node-thermal-printer`** (`npm install node-thermal-printer`)
- High-level API for ESC/POS printers; XP-80 series known compatible
- Prints by Windows printer name (uses Windows spooler — no USB/TCP addressing needed)
- Thai codepage support via `iconv-lite` under the hood
- API surface used: `alignCenter()`, `alignLeft()`, `bold(true/false)`, `println(text)`,
  `newLine()`, `drawLine()`, `tableCustom([{text, align, width}])`, `cut()`, `execute()`
- Printer instantiation: `type: PrinterTypes.EPSON`, `interface: InterfaceType.PRINTER`,
  `options: { printerName: config.PRINTER_NAME || undefined }` (undefined = system default)

**Alternative: raw `escpos` + `iconv-lite` + `escpos-usb`**
- Lower-level, more control; requires explicit USB/TCP addressing not printer-name-based
- Consider if `node-thermal-printer` codepage detection fails for the XP-80C firmware

### ESC/POS Layout Specification (80mm / 48-char Font A)

All character counts assume Font A (standard 80mm / 9600 baud = 48 columns).

```
[ESC @]        — initialize printer, clear buffer

--- HEADER (centre align) ---
[bold ON]
<sellerName, TIS-620 encoded>
[bold OFF]
<branchLine, TIS-620 encoded>
<"โทร " + sellerPhone>         if sellerPhone non-empty
<"POS: " + sellerPosId>        if sellerPosId non-empty
<sellerAddress>                if sellerAddress non-empty; wrap at 40 chars
<"เลขประจำตัวผู้เสียภาษี " + sellerTaxId>  if sellerTaxId non-empty
[bold ON]
ใบเสร็จรับเงินสด
[bold OFF]
<48 hyphens>   — dashed rule

--- META (left align, 2-column table) ---
เลขที่ POS         | <orderNumber>
เลขเอกสารบัญชี    | <acctNo>       (if accountingDocNo null: "— รอออกเอกสาร —")
วันที่             | <formatDateTime(order.createdAt)>
แคชเชียร์          | <cashierName>
<48 hyphens>

--- LINE ITEMS ---
(for each item in order.items)
  tableCustom: [ {text: productName, align: 'LEFT', width: 0.67},
                 {text: money(lineTotal), align: 'RIGHT', width: 0.33} ]
  println("  " + quantity + " × " + money(unitPrice))   — indented 2 spaces

<48 "=" chars>   — double-rule separator

--- TOTALS (centre align or explicit row) ---
[bold ON, larger size if supported]
tableCustom: [ {text: "รวมสุทธิ", align: 'LEFT', width: 0.6},
               {text: money(order.total), align: 'RIGHT', width: 0.4} ]
[bold OFF, normal size]
<48 hyphens>

--- PAYMENT LINES ---
(for each payment in payLines)
  tableCustom: [ {text: methodLabel(p.method), align: 'LEFT', width: 0.6},
                 {text: money(p.amount), align: 'RIGHT', width: 0.4} ]
(if change > 0.01)
  [bold ON]
  tableCustom: [ {text: "เงินทอน", align: 'LEFT', width: 0.6},
                 {text: money(order.change), align: 'RIGHT', width: 0.4} ]
  [bold OFF]

--- TAX-PAYER BLOCK (conditional) ---
(if order.taxRequested && order.customer?.taxId)
  <48 hyphens>
  ข้อมูลผู้เสียภาษี
  <order.customer.name>
  <order.customer.address>     if present
  TIN <order.customer.taxId>

--- FOOTER (centre align) ---
<48 "=" chars>
ราคานี้รวมภาษีมูลค่าเพิ่ม 7% แล้ว
ขอบคุณที่ใช้บริการ · Thank you

[PARTIAL CUT]   (ESC i)
```

### Thai Encoding — Critical Path

**The single highest-risk technical item in Plan B.**

The XP-80C prints Thai via its built-in Thai code page. The ESC t command (`0x1B 0x74 <n>`)
selects the active code table. After selection, any byte sent in the 0x80–0xFF range is
interpreted as that code table's character.

**Approach:**
1. At printer initialisation set `characterSet` to the Thai character set enum value
   in `node-thermal-printer`. This issues `ESC t <n>` automatically.
2. For every string containing Thai characters, encode via
   `iconv-lite.encode(str, 'tis620')` (or `'cp874'` — same encoding, different alias)
   before sending to the printer. ASCII-only strings (order numbers, prices) do not need
   re-encoding.
3. Wrap encoded Buffer in the printer's raw-write method if the library's `println`
   does not accept Buffers directly.

**Code table number risk:** The XP-80C firmware's Thai code table number is
printer-firmware-specific and not standardised across OEM clones. Common candidates:
- Table 20 (`ESC t 0x14`) — most common TIS-620 in Chinese OEM thermal printers
- Table 21 (`ESC t 0x15`) — sometimes used for CP874
- Table 18 (`ESC t 0x12`) — found in some Xprinter firmware revisions
- Table 17 (`ESC t 0x11`) — occasional alternate

**Owner must iterate through these candidates on the real XP-80C.** The `config.js`
`THAI_CODEPAGE` value (default 20, overridable via `KRS_THAI_CODEPAGE` env var) allows
switching without a code change.

**Baht sign risk:** The `฿` character (U+0E3F) occupies 0x80 in TIS-620. If the
selected code page maps 0x80 differently, `฿` will render wrong. Safe fallback: if
`฿` does not render, replace with `B` in the `money()` equivalent inside `printer.js`.
The owner confirms during the test-print step.

### Phase B2 Steps

**B2-1. Add `node-thermal-printer` dependency**

`cd tools/krs-print-agent && npm install node-thermal-printer`

Commit `package.json` and `package-lock.json` in `tools/krs-print-agent/`.

**B2-2. Create `tools/krs-print-agent/encoding.js`**

Exports:
- `function encodeThai(str)` — converts a JS string to a TIS-620 Buffer via iconv-lite.
  Guard: if `str` contains no characters above U+007F, return the string directly
  (no encoding needed for ASCII-only content).
- `function moneyAgent(num)` — mirrors `src/lib/money.ts` `money()`:
  returns `"฿X,XXX.XX"`. Include a `BAHT_SIGN_FALLBACK = 'B'` constant and a
  config option to switch to it if the baht sign does not render on the printer.

**B2-3. Create `tools/krs-print-agent/printer.js`**

Exports:
- `async function printReceipt(receiptData)` — accepts the parsed POST body,
  renders the ESC/POS layout per the specification above, submits to printer.

Implementation decisions:
- Instantiate `ThermalPrinter` from `node-thermal-printer`.
- `type`: `PrinterTypes.EPSON` (XP-80C is ESC/POS compatible).
- `interface`: `InterfaceType.PRINTER`.
- `options.printerName`: `config.PRINTER_NAME` if non-empty; omit (system default) if empty.
- `characterSet`: the Thai character set enum. Resolve `THAI_CODEPAGE` from `config.js`
  and pass the matching `CharacterSet.*` value. Note: if `node-thermal-printer` does not
  expose the exact code table needed, use the library's `setPrinterCharacterSet()` raw
  method to send `ESC t THAI_CODEPAGE` directly.
- After building the ESC/POS buffer with the layout above, call `printer.execute()`.
- Wrap in try/catch; throw a `PrintError` class (defined in this file) on failure.
- Log `[printer] job submitted, orderId=<id>` on success.
- Log `[printer] ERROR: <message>, orderId=<id>` on failure.

**B2-4. Edit `tools/krs-print-agent/index.js` — replace stub with real print call**

In the POST /print-receipt handler, replace the stub block:
- `require('./printer')` at the top of the file.
- After validation: `await printReceipt(body)`.
- Success: respond `200 { ok: true }`.
- `PrintError` (known error): respond `500 { ok: false, error: err.message }`.
- Unknown error: respond `500 { ok: false, error: "internal error" }`.

**B2-5. Create `tools/krs-print-agent/scripts/test-print.js`**

A standalone script (not served via HTTP) that hardcodes a sample ReceiptData object
covering all receipt sections (Thai shop name, branch, TIN, multiple line items
including a long Thai product name, split payment with change, tax-payer block) and
calls `printReceipt(sampleData)` directly.

Invoke via: `cd tools/krs-print-agent && node scripts/test-print.js`

This lets the owner test Thai codepage without needing the web app or the HTTP server.

Add to `package.json` scripts: `"test-print": "node scripts/test-print.js"`.

### Phase B2 Verification Gates

**Developer verification (no real printer required — confirms code structure only):**

1. `cd tools/krs-print-agent && node index.js` starts without error (B2 dependencies load).
2. POST a full ReceiptData JSON to `/print-receipt`. Agent logs a print attempt. If no
   printer is connected the job fails at the spooler level with a printer-not-found error;
   confirm `{ ok: false, error: "..." }` is returned (not a crash/hang).
3. POST with malformed JSON: confirm `400`.
4. POST with missing `order` key: confirm `400`.

**Owner test — REAL XP-80C required (mandatory before B2 is VERIFIED):**

These steps cannot be verified in a headless or dev session. The owner must run them
on the shop Windows PC with the XP-80C installed and the Windows driver active.

O1. Start agent: `node index.js` (or via the packaged .exe from B3 if available).
O2. Run test print: `npm run test-print`. Inspect the physical receipt:
   - ASCII text (order number, prices, numbers): crisp, correctly aligned.
   - Thai text (company name, title, item labels): **inspect character-by-character**.
     - Correct: move on.
     - Garbled / wrong characters: change `KRS_THAI_CODEPAGE` to the next candidate
       (default 20 → try 21 → 18 → 17) and rerun. Record the working value.
O3. Confirm `฿` renders as the baht sign (not garbage). If not, switch
    `BAHT_SIGN_FALLBACK` to `'B'` in `encoding.js`.
O4. Confirm the 48-hyphen dashed rules fit the 80mm width without wrapping.
O5. Confirm the partial cut triggers cleanly (receipt separates from the roll).
O6. Confirm a receipt with a product name exceeding 24 Thai characters does not
    overflow the column layout (truncation with "..." expected).
O7. Confirm the tax-payer block renders correctly (full name, address, TIN row).

**B2 is NOT VERIFIED until O2 passes with correct Thai output on the physical XP-80C.**
If no candidate codepage produces correct Thai, contact Xprinter for the firmware
code-table specification before proceeding to B3.

---

## Phase B3 — Printer Targeting, Packaging, and Autostart

### Goal

Package the agent as a single Windows `.exe` (`krs-print-agent.exe`) and deliver a
one-click install script (`deploy/setup-print-agent.bat`) that:
1. Copies the .exe to `%LOCALAPPDATA%\KrsPrintAgent\`.
2. Sets the XP-80C as the Windows default printer (reusing the `printui.dll` pattern
   from `deploy/kiosk-print-setup.bat`).
3. Registers the agent for autostart on Windows logon via the user Startup folder.
4. Starts the agent immediately and verifies it responds on port 9100.
5. Includes an uninstall section.

After this script runs once, the agent starts automatically on every logon and the
cashier only needs a normal browser.

### Phase B3 Touchpoints

| Path | Change | Description |
|---|---|---|
| `tools/krs-print-agent/package.json` | EDIT | Add `pkg` devDependency; add `pkg.targets` section |
| `deploy/setup-print-agent.bat` | CREATE | One-click install script for the agent |
| `public/setup-print-agent.bat` | CREATE | Mirror of deploy version served at `/setup-print-agent.bat` |
| `next.config.mjs` | EDIT | Add `Content-Disposition: attachment` header for `/setup-print-agent.bat` |
| `deploy/RECEIPT-PRINTING.md` | EDIT | Add step-by-step install guide for Plan B agent |

### Packaging Specification (`pkg`)

**Recommended: `pkg`**
- `npm install --save-dev pkg`
- Build command: `npx pkg . --target node20-win-x64 --output dist/krs-print-agent.exe`
- Bundles Node.js 20 runtime + all dependencies + `index.js` into a single `.exe`
  (approx. 50–80 MB)
- No Node.js installation required on the shop PC
- Add `"pkg": { "targets": ["node20-win-x64"], "assets": [] }` section in `package.json`

**Alternative: nexe** — similar capability, slightly smaller output, less actively maintained.

**Alternative: Node SEA (Node.js Single Executable Application, Node 20+)** — native to
Node.js, no third-party tool, more complex setup (requires explicit asset compilation step).
Suitable if `pkg` is deprecated in the future.

**Build artifact:** `tools/krs-print-agent/dist/krs-print-agent.exe`

The `dist/` directory is git-ignored (`.gitignore` entry from B1).

**Distribution:** GitHub Releases (recommended — keeps binary out of git history) or
placed directly in `public/` in the Next.js app (simpler, increases repo size). For
this plan, assume GitHub Releases; the setup script downloads from a release URL.
The `public/setup-print-agent.bat` instructs the operator to download the `.exe` from
the GitHub Release page (or a direct URL if hosted elsewhere) before running setup.

### `deploy/setup-print-agent.bat` Specification

The script must follow the same bilingual style as `deploy/kiosk-print-setup.bat`.

Section order:
1. `@echo off`, `chcp 65001 >nul`, title, REM block header (purpose, usage, safety).
2. CONFIG block:
   - `PRINTER=XP-80C`
   - `AGENT_DIR=%LOCALAPPDATA%\KrsPrintAgent`
   - `AGENT_EXE=%AGENT_DIR%\krs-print-agent.exe`
   - `STARTUP_SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\KRS Print Agent.lnk`
   - `DOWNLOAD_URL` — placeholder comment (operator downloads .exe manually from GitHub Releases or
     provided link before running this script)
3. Check if `%AGENT_EXE%` exists. If not, print an error instructing the operator to
   download `krs-print-agent.exe` first and place it in the same directory as this .bat.
4. Step 1 — Create agent directory:
   `if not exist "%AGENT_DIR%" mkdir "%AGENT_DIR%"`
5. Step 2 — Copy .exe:
   `copy /Y "krs-print-agent.exe" "%AGENT_EXE%"` (copies from the script's directory)
6. Step 3 — Set XP-80C as default printer:
   `rundll32 printui.dll,PrintUIEntry /y /n "%PRINTER%"` (identical to kiosk-print-setup.bat)
7. Step 4 — Register autostart via Startup folder shortcut (Option A — recommended):
   Use PowerShell (same pattern as kiosk-print-setup.bat shortcut creation):
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -Command ^
     "$ws=New-Object -ComObject WScript.Shell; ^
      $sc=$ws.CreateShortcut($env:STARTUP_SHORTCUT); ^
      $sc.TargetPath=$env:AGENT_EXE; ^
      $sc.WindowStyle=7; ^
      $sc.Description='KRS Print Agent'; ^
      $sc.Save()"
   ```
   `WindowStyle=7` = minimised (no console window visible on boot).
8. Step 5 — Start agent immediately (in background, minimised):
   `start /B /MIN "" "%AGENT_EXE%"`
9. Step 6 — Wait 2 seconds: `timeout /t 2 /nobreak >nul`
10. Step 7 — Verify agent is running:
    `curl -s http://127.0.0.1:9100/health` and check if output contains `krs-print-agent`.
    Print "Agent is running" or "Agent did not start — see error above".
11. Confirm current default printer (same pattern as kiosk-print-setup.bat).
12. Print bilingual success message. `pause`. `exit /b 0`.
13. `:no_exe` error label — bilingual error if the .exe was not found.
14. `:uninstall` label (optional, reachable by editing the top CONFIG block):
    - `taskkill /F /IM krs-print-agent.exe /T >nul 2>&1`
    - `del "%AGENT_EXE%" /Q`
    - Delete startup shortcut: `del "%STARTUP_SHORTCUT%" /Q`
    - Print "Uninstalled".

**SmartScreen note (must appear in script REM header and in the modal copy):**
The `.bat` file downloaded from the internet triggers Windows SmartScreen. Instruct
the operator: "If Windows shows a security warning, click 'More info' then 'Run anyway'."

**Autostart method rationale (Startup folder over HKCU Run key):**
- No registry writes — easier to audit and remove
- HKCU Startup folder works without administrator rights
- `WindowStyle=7` hides the console on boot
- Operator can disable by deleting the shortcut from the Startup folder

### Phase B3 Verification Gates

**Developer verification:**

1. `cd tools/krs-print-agent && npm run build` succeeds and produces `dist/krs-print-agent.exe`.
2. `dist/` is not tracked by git (`git status` shows no new tracked files under `dist/`).
3. `deploy/setup-print-agent.bat` has valid batch syntax (review for unmatched quotes,
   undefined variables, correct PowerShell escaping — same standard as the existing `.bat`).
4. `npm run type-check` and `npm run build` for the Next.js app pass (B3 adds minimal
   web-app changes: one header rule in `next.config.mjs`).

**Owner test — Windows PC required (mandatory before B3 is VERIFIED):**

O1. Place `krs-print-agent.exe` and `setup-print-agent.bat` in the same directory.
O2. Double-click `setup-print-agent.bat`. Observe the script:
    - Creates `%LOCALAPPDATA%\KrsPrintAgent\`.
    - Copies the .exe.
    - Sets XP-80C as default printer (script echoes confirmation at the end).
    - Creates shortcut in `%APPDATA%\...\Startup\`.
    - Starts the agent and pings `/health` — reports "Agent is running".
O3. Reboot the PC. After logon, without any manual action:
    - `curl -s http://127.0.0.1:9100/health` returns `{"name":"krs-print-agent",...}`.
    - No console window is visible on the desktop (WindowStyle=7).
O4. Confirm the Startup folder shortcut is present and removable.
O5. Confirm the uninstall path (`:uninstall` label) removes the .exe and startup shortcut cleanly.

---

## Phase B4 — Web Integration

### Goal

Wire the web app to detect the agent and route printing correctly:
1. **Detect** the agent on POS page load (async ping, session-cached).
2. **Use `PrintAgentService`** when the agent responds (no browser dialog, no DOM dependency).
3. **Fall back to `BrowserPrintService`** silently when the agent is absent (no regression).
4. **Update `SilentPrintOnboardingModal`**: agent detected → suppress modal; agent absent
   → primary action is "install print agent", secondary action is "kiosk mode".
5. **Zero change to money, stock, checkout, auth, or any other screen.**

### Phase B4 Touchpoints

| Path | Change | Description |
|---|---|---|
| `src/lib/print/index.ts` | EDIT | Add `resolveReceiptPrintService()` async resolver + module-level cache |
| `src/app/(shell)/pos/page.tsx` | EDIT | Mount detection; conditional autoPrint; pass `agentDetected` to modal |
| `src/components/pos/SilentPrintOnboardingModal.tsx` | EDIT | New `agentDetected` prop; updated modal copy (agent installer as primary) |
| `public/setup-print-agent.bat` | CREATE | Static asset served at `/setup-print-agent.bat` (download from modal) |
| `next.config.mjs` | EDIT | Add `Content-Disposition: attachment` for `/setup-print-agent.bat` |
| `deploy/RECEIPT-PRINTING.md` | EDIT | Document B4 detection flow and the two-action modal |

### Phase B4 Public Contracts

#### `src/lib/print/index.ts` — new async resolver

```
HEALTH_ENDPOINT = "http://127.0.0.1:9100/health"   (constant, not imported from agent)
DETECTION_TIMEOUT_MS = 1500                          (constant)

let _cachedService: ReceiptPrintService | null = null   (module-level, null = not yet resolved)

export async function resolveReceiptPrintService(): Promise<ReceiptPrintService>
  Semantics:
  — If not in browser (typeof window === "undefined"): return new BrowserPrintService() immediately.
  — If _cachedService is not null: return _cachedService (zero additional network round-trips).
  — Attempt detection:
      • Create an AbortController with a 1500 ms timeout.
      • fetch(HEALTH_ENDPOINT, { signal: controller.signal })
      • If response is 200 and JSON body has name === "krs-print-agent":
          _cachedService = new PrintAgentService({ failOpen: true })
      • Any other outcome (timeout, network error, non-200, wrong JSON, fetch not available):
          _cachedService = new BrowserPrintService()
  — NEVER rejects or throws. All failure paths resolve with BrowserPrintService.
  — Returns _cachedService.

export function getReceiptPrintService(): ReceiptPrintService   ← UNCHANGED (sync, always BrowserPrintService)
  Retained for any existing synchronous callers. Do not remove or modify.
```

**PNA preflight note:** Chrome/Edge will send an OPTIONS preflight with
`Access-Control-Request-Private-Network: true` before the GET /health fetch. The
agent (B1) already returns `Access-Control-Allow-Private-Network: true` in its
OPTIONS response. The 1500 ms timeout must cover both the OPTIONS round-trip and the
GET. If PNA preflight delays detection noticeably on first load, increase the timeout
to 2000 ms and note in a comment.

#### `src/components/pos/SilentPrintOnboardingModal.tsx` — updated props

```typescript
type SilentPrintOnboardingModalProps = {
  open: boolean
  onClose: () => void
  onDismissPermanently: () => void
  agentDetected: boolean    // NEW: caller passes true when PrintAgentService was resolved.
                            // Currently used only for suppression (caller sets open=false).
                            // Kept in props for future differentiation (success banner, etc.)
}
```

Modal copy when `agentDetected` is false (agent absent):
- Title: "ตั้งค่าพิมพ์ใบเสร็จอัตโนมัติ / Silent Receipt Printing Setup" (unchanged)
- PRIMARY action (button, full-width, forest green):
  `<a href="/setup-print-agent.bat" download="setup-print-agent.bat">`
  Label: "ดาวน์โหลดตัวติดตั้ง Print Agent / Download Print Agent Installer"
  Sub-note: "แนะนำ — พิมพ์ไม่มี dialog ในทุกเบราว์เซอร์ / Recommended — no dialog in any browser"
- SECONDARY action (text link or outlined button, below primary):
  `<a href="/kiosk-print-setup.bat" download="kiosk-print-setup.bat">`
  Label: "ใช้โหมด Kiosk แทน / Use Kiosk Mode Instead"
  Sub-note: "สำหรับเครื่องที่ติดตั้ง Agent ไม่ได้ / For PCs where the agent cannot be installed"
- Step explanation: update Step 2 to describe running `setup-print-agent.bat`
  (not kiosk-print-setup.bat). Add a note: after the agent is installed, opening the
  POS in any browser will detect it automatically and this modal will not reappear.
- SmartScreen note (below primary button): same as Plan A — "More info → Run anyway".
- Dismiss button: unchanged ("ตั้งค่าเสร็จแล้ว · ไม่ต้องแสดงอีก").

#### Receipt auto-print flow change

`BrowserPrintService` requires `ReceiptModal` to render `.print-receipt` in the DOM
(`autoPrint={true}` mode). `PrintAgentService` does not need or use the DOM.

The confirm handler in `pos/page.tsx` must conditionally set `autoPrint`:

```
const svc = printServiceRef.current ?? getReceiptPrintService();
const isAgent = svc instanceof PrintAgentService;

// Fire print (fail-open: resolve never blocks checkout)
void svc.printReceipt({ order, seller: sellerInfo, sizeSettings }).catch((err) => {
  console.error("[pos] print error:", err);
  // Optionally: surface a toast ("ใบเสร็จพิมพ์ไม่ได้ / Receipt print failed")
});

// Open the receipt modal to show the cashier the confirmation screen.
// autoPrint=true only when BrowserPrintService is active (it drives window.print()).
// When PrintAgentService is active, autoPrint=false (printing already in flight above).
openReceiptModal(order, { autoPrint: !isAgent });
```

This preserves the existing behaviour for `BrowserPrintService` (autoPrint drives
`window.print()` via the DOM path) and does not require DOM rendering for PrintAgentService.

#### Detection-to-modal suppression logic

```
// In pos/page.tsx mount useEffect([]):
persistKioskModeIfFlagged()                   // Plan A, unchanged
const svc = await resolveReceiptPrintService()
printServiceRef.current = svc
const agentRunning = svc instanceof PrintAgentService

// Onboarding modal decision:
if (agentRunning || isKioskMode() || isDismissed()) {
  setOnboardingOpen(false)     // suppress: agent covers the need; or already set up
} else {
  setOnboardingOpen(true)      // first-run: guide the operator
}
setAgentDetected(agentRunning)  // pass to modal as prop
```

**Timing:** `resolveReceiptPrintService()` takes up to 1500 ms on a miss (agent absent).
During this wait the modal is in its initial state (`false`) — no flash. When the
await resolves, the modal opens (if needed). Acceptable delay for a first-run onboarding
modal. If the owner finds the 1.5 s delay notable, switch to the "show immediately,
then hide if agent responds" pattern: set `onboardingOpen(true)` immediately (if not
kiosk/dismissed), then hide on detection success within the same effect.

### Phase B4 Steps

**B4-1. Edit `src/lib/print/index.ts`**

Add the `HEALTH_ENDPOINT` constant, `DETECTION_TIMEOUT_MS` constant,
`_cachedService` module-level variable, and `resolveReceiptPrintService()` function
per the public contract above. Export the new function alongside the existing exports.

The existing `getReceiptPrintService()` function is NOT modified.
The existing `export type { ReceiptData, ReceiptPrintService }` re-exports are NOT modified.

**B4-2. Edit `src/app/(shell)/pos/page.tsx`**

Additions (changes ONLY — do not rewrite the file):

Imports to add:
```
import { resolveReceiptPrintService, PrintAgentService, getReceiptPrintService } from "@/lib/print"
```

State to add:
```
const [agentDetected, setAgentDetected] = useState(false)
```

Ref to add (instead of state for the service to avoid re-renders):
```
const printServiceRef = useRef<import("@/lib/print").ReceiptPrintService | null>(null)
```

In the mount `useEffect([])` (the Plan A effect that already calls
`persistKioskModeIfFlagged` and sets `onboardingOpen`):
- Prepend `await resolveReceiptPrintService()` before the modal decision.
- Store result in `printServiceRef.current`.
- Compute `const agentRunning = printServiceRef.current instanceof PrintAgentService`.
- Replace `if (shouldShowOnboardingModal())` with the 3-condition check above.
- Call `setAgentDetected(agentRunning)`.
- Because this effect is now async, wrap in an async IIFE:
  `useEffect(() => { (async () => { /* ... */ })() }, [])`.

In the payment confirm handler (wherever `getReceiptPrintService().printReceipt(...)` is called):
- Replace with the conditional `svc` / `isAgent` / `autoPrint` pattern above.

Pass `agentDetected={agentDetected}` to `<SilentPrintOnboardingModal>`.

**B4-3. Edit `src/components/pos/SilentPrintOnboardingModal.tsx`**

- Add `agentDetected: boolean` to the props type (even if unused in this phase — it
  documents the intent and prevents a TS error from B4-2's prop pass).
- Change the PRIMARY download anchor to point to `/setup-print-agent.bat`.
- Add the SECONDARY anchor for `/kiosk-print-setup.bat`.
- Update the modal step copy to describe the agent installer as the recommended path.
- Preserve all existing dismiss logic (`onClose`, `onDismissPermanently`, `markDismissed`).
- Preserve `Modal` import, props `open`, `onClose`, `onDismissPermanently`.
- Do NOT change the modal's visual design or font/colour tokens.

**B4-4. Create `public/setup-print-agent.bat`**

Content: identical to `deploy/setup-print-agent.bat` (B3 output). Add a comment at
the top: `REM *** IN-PRODUCT COPY — served at /setup-print-agent.bat by Next.js ***`.
Add the "keep in sync with deploy/ copy" note matching the pattern from `public/kiosk-print-setup.bat`.

**B4-5. Edit `next.config.mjs` — add download header for `/setup-print-agent.bat`**

In the existing `headers()` array (added in Plan A for `/kiosk-print-setup.bat`),
add a second entry with `source: "/setup-print-agent.bat"` and headers:
- `Content-Disposition: attachment; filename="setup-print-agent.bat"`
- `Content-Type: application/octet-stream`

**B4-6. Verify type-check and build**

`npm run type-check` and `npm run build` must both pass before B4 is code-done.

### Phase B4 Verification Gates

**Automated (required before B4 is code-done):**

1. `npm run type-check` passes — zero errors in all B4-edited files.
2. `npm run build` passes — Next.js production build succeeds.

**Manual — agent absent (fallback path verification):**

3. Start `npm run dev`. Open `/pos` in a normal browser with no agent on port 9100.
4. DevTools Network tab: observe the OPTIONS + GET to `http://127.0.0.1:9100/health`
   fail (connection refused or timeout after ~1500 ms). Confirm no unhandled errors.
5. Onboarding modal appears. Primary button href is `/setup-print-agent.bat`.
   Secondary link href is `/kiosk-print-setup.bat`.
6. Complete a checkout. Browser print dialog appears (BrowserPrintService active).
   Confirm `autoPrint={true}` was passed to ReceiptModal (check DevTools React props).
7. Click primary button. Confirm `setup-print-agent.bat` downloads (not rendered as text).
8. Confirm `localStorage.getItem('krspos_silentprint_dismissed')` is null until dismiss is clicked.

**Manual — agent running (agent path verification):**

9. Start agent: `cd tools/krs-print-agent && node index.js`.
10. Open `/pos` in a normal browser. DevTools Network: OPTIONS + GET to `/health` succeed.
11. Onboarding modal does NOT appear.
12. `agentDetected` state is true (check via React DevTools or a temporary console.log).
13. Complete a checkout. No browser print dialog. Agent stdout logs print attempt.
    If B2 is complete: physical receipt prints on XP-80C.
14. `autoPrint={false}` was passed to ReceiptModal.
15. Stop the agent. Reload `/pos`. Onboarding modal reappears (detection miss).

**Owner test — full E2E with real XP-80C (mandatory before B4 is VERIFIED):**

O1. Shop Windows PC with agent installed (B3 verified), XP-80C driver active.
O2. Agent autostarts after logon. Confirm via `curl -s http://127.0.0.1:9100/health`.
O3. Open `https://krspos.innoveraappcenter.com` in a **normal** Chrome or Edge
    window (NOT the kiosk shortcut — the whole point of Plan B).
O4. POS page loads. Onboarding modal does NOT appear.
O5. Ring up a sale and confirm payment. Observe:
    - No print dialog appears.
    - Receipt prints on XP-80C within 3 seconds.
    - All Thai text on the physical receipt is correct (no garbled characters).
    - Prices and totals match the screen.
O6. Open a second browser tab (`/pos`). Confirm the detection is cached (agent
    stdout shows no additional /health log lines).
O7. Stop the agent (Task Manager → End Task on `krs-print-agent.exe`).
    Reload `/pos`. Onboarding modal appears. Complete a checkout:
    browser print dialog appears (BrowserPrintService fallback active).
O8. Restart the agent. Reload `/pos`. Modal suppresses again.

---

## Phase Sequencing

```
B1 (Agent HTTP scaffold)    → agent detectable; web can begin B4 detection wiring
    ↓
B2 (ESC/POS rendering)      → real printing; REQUIRES owner XP-80C iteration
    ↓
B3 (Packaging + setup)      → deployable .exe; REQUIRES B2 verified (do not ship stub .exe)
    ↓
B4 (Web integration)        → full swap; REQUIRES B1 for detection; B2+B3 for E2E owner test
```

**Parallelism permitted:**
- B4-1 and B4-2 (detection logic in the web app) may be written while B2 is being
  iterated on the real printer. The web-side detection works against the B1 /health stub.
- B3 packaging infrastructure (pkg setup, install script structure) may be drafted
  while B2 ESC/POS is in progress, but do NOT publish a .exe until B2 is verified.

**Suggested first EXECUTE phase: B1.**

B1 is the natural first buildable slice because it has zero ESC/POS complexity, zero
packaging complexity, and zero web-app changes. After B1 is verified with the curl
gates, the web-side detection (B4) can be written and tested immediately.

---

## Public Contracts

| Contract | Location | Notes |
|---|---|---|
| `ReceiptData` | `src/lib/print/types.ts` | FROZEN. Agent POST body must deserialize to this exact type. |
| `ReceiptPrintService` | `src/lib/print/types.ts` | FROZEN. Both services implement `printReceipt(receipt): Promise<void>`. |
| `getReceiptPrintService()` | `src/lib/print/index.ts` | UNCHANGED. Returns BrowserPrintService synchronously. |
| `resolveReceiptPrintService()` | `src/lib/print/index.ts` | NEW in B4. Async, never rejects, session-cached. |
| Agent /health | `tools/krs-print-agent/index.js` | `GET http://127.0.0.1:9100/health` → `200 { name, version, status }` |
| Agent /print-receipt | `tools/krs-print-agent/index.js` | `POST` body = serialised ReceiptData → `200 { ok: true }` on success |
| `PRINTER_NAME` config | `tools/krs-print-agent/config.js` | `""` = Windows default. Override via `KRS_PRINTER_NAME` env var. |
| `THAI_CODEPAGE` config | `tools/krs-print-agent/config.js` | Integer code-table for `ESC t`. Default: 20. Override via `KRS_THAI_CODEPAGE`. |
| Payment label map | `src/components/pos/paymentMeta.ts` | `cash→เงินสด`, `transfer→โอนเงิน`, `qr→QR PromptPay`, `card→บัตรเครดิต`, `ewallet→e-Wallet`, `other→อื่นๆ`. Agent must replicate exactly. |

---

## Blast Radius

**New (agent — shop-side only, NOT deployed to server):**
- `tools/krs-print-agent/` — entirely new directory; zero coupling to Next.js production build
- No new Docker service, no new Dockerfile, no docker-compose change, no Caddy change,
  no Lightsail change, no server-side deployment change

**Web app changes (deployed; minimal surface):**
- `src/lib/print/index.ts` — one new async function + module-level cache; existing
  `getReceiptPrintService()` is NOT modified
- `src/app/(shell)/pos/page.tsx` — one new `useRef`, one async call in the mount effect,
  one `instanceof` check in the confirm handler; checkout/payment/stock/money logic
  is NOT touched
- `src/components/pos/SilentPrintOnboardingModal.tsx` — one new prop, updated copy,
  second download anchor added; no checkout logic
- `next.config.mjs` — one additional Content-Disposition header rule
- `public/setup-print-agent.bat` — new static asset

**Files NOT touched (zero blast radius):**
- `src/app/api/orders/route.ts` (checkout) — NOT TOUCHED
- `prisma/schema.prisma` — NO SCHEMA CHANGE, NO MIGRATION
- `src/lib/pricing.ts`, `src/lib/money.ts` — NOT TOUCHED
- Auth, session, RBAC — NOT TOUCHED
- Products, users, sales, shift, data, settings screens — NOT TOUCHED
- Docker, docker-compose, Dockerfile, Caddy — NOT TOUCHED

---

## Data Flow

```
AGENT-PRESENT PATH (after B4 integration):

  cashier confirms payment
    → pos/page.tsx confirm handler
    → svc = printServiceRef.current           (PrintAgentService, set on mount)
    → isAgent = true
    → openReceiptModal(order, { autoPrint: false })   ← cashier sees receipt; no auto-print
    → void svc.printReceipt({ order, seller, sizeSettings })
        → POST "http://127.0.0.1:9100/print-receipt"
          headers: Content-Type: application/json
          body: JSON.stringify(receiptData)
          AbortController timeout: 4000 ms
        → agent receives body
        → validates: order object present
        → printReceipt(body) in printer.js
        → ThermalPrinter: select Thai codepage (ESC t <n>)
        → encode Thai strings → iconv-lite TIS-620 Buffer
        → build ESC/POS buffer (header → meta → items → totals → payment → footer → cut)
        → printer.execute() → Windows spooler → XP-80C
        → 200 { ok: true }
    → PrintAgentService resolves
    → NO browser dialog; NO DOM polling

AGENT-ABSENT PATH (fallback — identical to pre-Plan-B behaviour):

  cashier confirms payment
    → svc = printServiceRef.current           (BrowserPrintService, set on mount)
    → isAgent = false
    → openReceiptModal(order, { autoPrint: true })  ← drives window.print()
    → void svc.printReceipt({ order, seller, sizeSettings })
        → BrowserPrintService polls DOM for .print-receipt (rAF, MAX_FRAMES=60)
        → printReceiptWithSize(sizeSettings) → window.print()
        → browser dialog or kiosk-mode silent print
        → resolves on afterprint / 5 s fallback
    → NO change from current behaviour

DETECTION FLOW (on every pos/page.tsx mount, once per session):

  mount
    → (async IIFE in useEffect([]))
    → persistKioskModeIfFlagged()      (Plan A, unchanged)
    → if (_cachedService) return _cachedService
    → AbortController signal, 1500 ms timeout
    → browser: OPTIONS http://127.0.0.1:9100/health  ← Chrome PNA preflight
      agent: 204 + CORS/PNA headers
    → browser: GET http://127.0.0.1:9100/health
      agent: 200 { name: "krs-print-agent", version, status }
    → cache: PrintAgentService(failOpen: true)
    → printServiceRef.current = cached service
    → agentRunning = true
    → setAgentDetected(true)
    → setOnboardingOpen(false)

  (if ping times out / fails):
    → cache: BrowserPrintService
    → agentRunning = false
    → setAgentDetected(false)
    → apply shouldShowOnboardingModal() as before (Plan A logic)
```

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Thai codepage mismatch on XP-80C | Medium | High — garbled Thai on paper | `config.js` THAI_CODEPAGE is overridable; 4 candidate values documented; `test-print.js` lets owner iterate offline without the web app |
| PNA preflight blocked (Chrome <98, or missing header) | Low–Medium | High — detection silently fails; agent treated as absent | Agent sends `Access-Control-Allow-Private-Network: true` in all OPTIONS responses; B1 verification includes explicit curl test of this header |
| Port 9100 conflict (Zebra printers, other services) | Low | Medium — agent fails to bind | Agent logs clear "address already in use" error; PORT is configurable in config.js; setup script pings /health and reports failure |
| SmartScreen blocks .bat/.exe on first install | High (expected Windows behaviour) | Medium — operator blocked at install | Setup script includes bilingual "More info → Run anyway" note; modal copy repeats it; code-signing is a future improvement |
| Agent not running when POS page opens | Medium (first-run, post-reboot before agent starts) | Low — graceful fallback to BrowserPrintService + onboarding modal | Detection timeout bounded to 1500 ms; fail-open; onboarding modal guides install |
| ESC/POS layout drifts from HTML receipt (new fields added to ReceiptModal) | Medium | Low–Medium — missing fields on physical receipt | `printer.js` is explicitly spec'd against the ReceiptModal layout; any ReceiptModal change in future must audit `printer.js` |
| Long Thai product names overflow 48-char column | Medium | Low | `printer.js` truncates product names at 30 chars with "…" suffix; B2 owner test O6 checks this |
| pkg produces corrupted binary | Low | Medium — .exe won't start | Test .exe before distribution; nexe and Node SEA are documented alternatives |
| Baht sign `฿` not in selected TIS-620 codepage position | Low–Medium | Low — displays `B` instead of `฿` | `encoding.js` includes `BAHT_SIGN_FALLBACK = 'B'`; owner checks in B2 test O3 |
| Agent absent → checkout blocked | Critical (non-negotiable risk) | Critical | `resolveReceiptPrintService()` NEVER rejects; all failure paths return BrowserPrintService; `failOpen: true` on PrintAgentService means a failed POST resolves (not throws) |
| B2 owner iteration takes multiple sessions | High (expected) | Medium — delays B3/B4 | B4 web detection can be written against B1 stub in parallel; B2 gate is explicitly "real printer test" — block B3 packaging on B2, not the web side |
| `ReceiptData` contract changed without updating agent | Medium (future) | Medium — serialisation mismatch | `ReceiptData` is FROZEN per Public Contracts; any future change requires a coordinated agent update |

---

## Acceptance Criteria (Full Program)

All of the following must pass for the Plan B program to be marked VERIFIED:

1. `npm run type-check` and `npm run build` for the Next.js app pass (zero errors).
2. `cd tools/krs-print-agent && node index.js` starts on port 9100 without error.
3. `GET http://127.0.0.1:9100/health` returns `{ name: "krs-print-agent", version: "1.0.0", status: "ok" }`.
4. `POST http://127.0.0.1:9100/print-receipt` with a full `ReceiptData` payload triggers a print job to XP-80C.
5. All Thai characters on the physical receipt render correctly.
6. Opening `/pos` in a normal browser while the agent is running: no print dialog; receipt prints silently on XP-80C within 3 seconds.
7. Opening `/pos` while the agent is NOT running: browser print dialog appears (BrowserPrintService fallback — identical to pre-Plan-B behaviour).
8. The `SilentPrintOnboardingModal` is suppressed when agent is detected; appears with "install print agent" as the primary action when agent is absent.
9. `setup-print-agent.bat` installs the agent on a shop Windows PC, registers autostart, and the agent starts automatically on the next logon.
10. Money totals, stock levels, and order records are correct after a Plan-B checkout (no regression).
11. Plan A kiosk path (`?kiosk=1` shortcut) still works independently — removing or not installing the agent does not break the kiosk fallback.

---

## Failure Modes (Exhaustive)

| Failure | Behaviour | Recovery |
|---|---|---|
| Agent not installed | Detection times out (1500 ms) → BrowserPrintService → onboarding modal | Install agent via `setup-print-agent.bat` |
| Agent installed but not running (crashed / not yet started after boot) | Same as not installed | Restart agent; on next logon it autostarts |
| Agent running but /print-receipt returns 500 (printer error) | `failOpen: true` → resolves silently; sale already recorded; no auto-reprint | Check XP-80C is online/connected; reprint from Sales History |
| Agent POST times out (4000 ms default) | AbortController fires → `failOpen: true` resolves; no reprint | Check agent responsiveness; restart if hung |
| PNA preflight fails (old browser) | /health fetch blocked → detection fails → BrowserPrintService | Update Chrome/Edge to v98+ |
| Port 9100 in use by another service | Agent fails to bind; does not start | Change `KRS_PORT` env var in config.local.js; re-run setup script |
| Thai codepage wrong | Garbled Thai on paper; correct ASCII | Change `KRS_THAI_CODEPAGE` env var; restart agent; reprint test |
| .exe quarantined by antivirus | Agent won't start | Add antivirus exclusion for `%LOCALAPPDATA%\KrsPrintAgent\`; code-sign future releases |
| Multiple cashier PCs at same shop | Each PC installs the agent independently | Agent is per-PC; no shared state; no coordination needed |
| Oversized ReceiptData (> 128 KB) | Agent returns 413; `PrintAgentService` throws; `failOpen:true` resolves | Not a realistic scenario (100 line items ≈ 10 KB); limit is a safety guard only |
| `resolveReceiptPrintService()` called during SSR | `typeof window === "undefined"` guard fires → returns `new BrowserPrintService()` immediately | No action needed; guard is in the spec |

---

## Integration Notes

- **`PrintAgentService` is already STUBBED** in `src/lib/print/printAgentService.ts`. Do not re-create it. Only add the async detection wrapper in Phase B4.
- **`ReceiptData` contract is FROZEN.** The agent's POST body must match this type exactly. `types.ts` must not be modified.
- **`money()` from `src/lib/money.ts`** is the formatting specification. The agent's `moneyAgent()` in `encoding.js` must produce identical output.
- **`methodLabel()` from `paymentMeta.ts`** defines the Thai payment names the agent must replicate. Read the exact values from that file; do not hardcode guesses.
- **Tax-payer block** (`order.taxRequested && order.customer?.taxId`) must be rendered by the agent. Do not silently omit it — tax-invoice receipts require this information.
- **`sellerAddress` may contain newlines or be long** — the agent must wrap it at approximately 40 characters to fit 80mm paper.
- **No new npm packages for the Next.js web app** — B4 adds zero web-app dependencies.
- **`tools/krs-print-agent/` must NOT be treated as part of the Next.js build.** It has its own `package.json`. Running `npm install` in the repo root does NOT install agent dependencies. The agent is built separately.
- **The root `.gitignore` should exclude `tools/krs-print-agent/dist/`** if it does not already. Add this entry if the global `.gitignore` does not cover it.

---

## Resume and Execution Handoff

**Selected plan file:** `process/general-plans/active/silent-print-agent-planB_PLAN_01-07-26.md`

**Phase readiness at plan creation:**

| Phase | Status | Blocker |
|---|---|---|
| B1 | READY — start here | None |
| B2 | Blocked on B1 completion; also requires owner hardware test on XP-80C | B1 + real printer |
| B3 | Blocked on B2 verified (do not package a stub .exe) | B2 verified |
| B4 web detection | Can start after B1 | B1 only |
| B4 E2E owner test | Blocked on B2 + B3 + B4 code | All prior phases |

**Recommended first EXECUTE scope:** Phase B1 only. Deliver and verify the HTTP server scaffold. After B1 curl gates pass, the executor may begin B4-1 (resolveReceiptPrintService) and B4-2 (pos/page.tsx wiring) in parallel while the owner iterates B2 on the real XP-80C.

**Files EXECUTE must read before starting B1:**
- `src/lib/print/types.ts` — ReceiptData and ReceiptPrintService (FROZEN; do not modify)
- `src/lib/print/printAgentService.ts` — the existing stub (do not re-implement)
- `src/lib/print/index.ts` — the factory (extend in B4, not B1)
- `deploy/kiosk-print-setup.bat` — reference for setup script style (B3)
- `deploy/RECEIPT-PRINTING.md` — the doc to extend in B1 and B3

**Files EXECUTE must read before starting B4:**
- `src/app/(shell)/pos/page.tsx` — existing mount effect + confirm handler (understand before editing)
- `src/components/pos/SilentPrintOnboardingModal.tsx` — existing props and modal structure
- `src/lib/kioskMode.ts` — Plan A detection logic (must not regress)
- `process/general-plans/active/silent-print-onboarding_PLAN_01-07-26.md` — Plan A full spec

**Re-research trigger:** If more than 2 weeks elapse between phases, re-read this plan
and inspect the current state of `src/lib/print/` and `tools/krs-print-agent/` for drift
before beginning the next phase.

**Validate this plan artifact:**
```
node .claude/skills/vc-generate-plan/scripts/validate-plan-artifact.mjs \
  process/general-plans/active/silent-print-agent-planB_PLAN_01-07-26.md
```

---

## Touchpoints

All new or edited paths across the full Plan B program. Phase column indicates when
each path is first created or edited. Read `process/context/all-context.md` to
understand the repo structure before implementing any item in the agent or web tiers.

| Path | Phase | Change | Description |
|---|---|---|---|
| `tools/krs-print-agent/` | B1 | CREATE DIR | Standalone Node.js agent package root |
| `tools/krs-print-agent/package.json` | B1 | CREATE | Own package.json (private, not in Next.js build) |
| `tools/krs-print-agent/config.js` | B1 | CREATE | PORT, HOST, ALLOWED_ORIGINS, PRINTER_NAME, MAX_BODY_BYTES, THAI_CODEPAGE |
| `tools/krs-print-agent/index.js` | B1–B2 | CREATE → EDIT | HTTP server entry point; B1=stub handler, B2=real ESC/POS call |
| `tools/krs-print-agent/.gitignore` | B1 | CREATE | Excludes node_modules/, dist/, *.exe, config.local.js |
| `tools/krs-print-agent/README.md` | B1 | CREATE | Developer + operator guide |
| `tools/krs-print-agent/encoding.js` | B2 | CREATE | Thai TIS-620 encoder + moneyAgent() |
| `tools/krs-print-agent/printer.js` | B2 | CREATE | ESC/POS receipt renderer using node-thermal-printer |
| `tools/krs-print-agent/scripts/test-print.js` | B2 | CREATE | CLI test-print for owner codepage iteration |
| `tools/krs-print-agent/package.json` | B2 | EDIT | Add node-thermal-printer dependency |
| `tools/krs-print-agent/package.json` | B3 | EDIT | Add pkg devDependency + pkg.targets |
| `deploy/setup-print-agent.bat` | B3 | CREATE | One-click agent install script (bilingual) |
| `public/setup-print-agent.bat` | B3–B4 | CREATE | Mirror of deploy version, served at /setup-print-agent.bat |
| `deploy/RECEIPT-PRINTING.md` | B1, B3, B4 | EDIT | Add Plan B architecture section (B1); install guide (B3); detection flow (B4) |
| `src/lib/print/index.ts` | B4 | EDIT | Add resolveReceiptPrintService() async resolver + module-level cache |
| `src/app/(shell)/pos/page.tsx` | B4 | EDIT | Async detection in mount effect; conditional autoPrint; agentDetected state |
| `src/components/pos/SilentPrintOnboardingModal.tsx` | B4 | EDIT | agentDetected prop; agent installer as primary action; kiosk .bat as secondary |
| `next.config.mjs` | B3–B4 | EDIT | Add Content-Disposition: attachment for /setup-print-agent.bat |

---

## Verification Evidence

Per-phase verification gates (Post-Phase Testing). Each gate must pass before the phase is marked done. No automated test runner exists for this project yet — see `process/context/tests/all-tests.md` for the current testing status. All verification is manual (curl, DevTools, owner hardware) or build-time (`npm run type-check` + `npm run build`).
"Owner test" items require the real XP-80C printer on a Windows shop PC and cannot
be performed in a headless dev session.

### Phase B1 Gates (developer only — no hardware)

| # | Verification | Method |
|---|---|---|
| B1-V1 | Agent starts and logs listening message | `cd tools/krs-print-agent && node index.js` |
| B1-V2 | /health returns correct JSON | `curl -s http://127.0.0.1:9100/health` |
| B1-V3 | CORS + PNA headers on OPTIONS preflight | `curl -s -X OPTIONS ... -H "Access-Control-Request-Private-Network: true" -v` |
| B1-V4 | CORS blocks unlisted origin | Confirm no Allow-Origin for evil.example.com |
| B1-V5 | Stub print returns correct JSON | `curl -s -X POST ... -d '{"order":{"id":"test-001"}}'` |
| B1-V6 | Body size limit returns 413 | POST with 200 KB payload |
| B1-V7 | Unknown path returns 404 | `curl -s http://127.0.0.1:9100/unknown` |
| B1-V8 | Next.js app clean before B4 | `npm run type-check` + `npm run build` both pass |

### Phase B2 Gates (developer + owner hardware)

| # | Verification | Method |
|---|---|---|
| B2-V1 | Agent starts with ESC/POS dependencies | `node index.js` no error |
| B2-V2 | POST to /print-receipt triggers print attempt (no crash) | `curl -X POST ...` with full ReceiptData JSON |
| B2-V3 | Malformed body → 400 | POST with `{invalid json` |
| B2-V4 | Missing order → 400 | POST with `{}` |
| B2-V5 [OWNER] | Thai text renders correctly on XP-80C | `npm run test-print` on shop PC |
| B2-V6 [OWNER] | Baht sign renders or falls back to `B` | Visual inspect of test receipt |
| B2-V7 [OWNER] | 48-char dashed rules fit paper width | Visual inspect |
| B2-V8 [OWNER] | Partial cut triggers cleanly | Physical cut check |
| B2-V9 [OWNER] | Long Thai product name truncates correctly | Test receipt with 25+ char product name |

### Phase B3 Gates (developer + owner hardware)

| # | Verification | Method |
|---|---|---|
| B3-V1 | `npm run build` produces dist/krs-print-agent.exe | Build command in tools/krs-print-agent/ |
| B3-V2 | dist/ not tracked by git | `git status` shows no new tracked files in dist/ |
| B3-V3 | setup-print-agent.bat valid batch syntax | Code review + Windows test |
| B3-V4 | Next.js build clean | `npm run type-check` + `npm run build` |
| B3-V5 [OWNER] | Setup script completes all steps without error | Run on shop Windows PC |
| B3-V6 [OWNER] | Agent autostarts after reboot | Reboot PC, verify /health returns 200 |
| B3-V7 [OWNER] | Startup shortcut visible and removable | Check Startup folder; delete and re-run |
| B3-V8 [OWNER] | Uninstall path cleans up all artifacts | Run `:uninstall` section |

### Phase B4 Gates (developer + owner hardware)

| # | Verification | Method |
|---|---|---|
| B4-V1 | `npm run type-check` passes | Zero errors in all B4-edited files |
| B4-V2 | `npm run build` passes | Next.js production build succeeds |
| B4-V3 | Agent-absent: detection timeout within 1500 ms | DevTools Network tab, no agent running |
| B4-V4 | Agent-absent: onboarding modal appears with correct actions | Manual browser check |
| B4-V5 | Agent-absent: primary button downloads setup-print-agent.bat | Click + inspect download |
| B4-V6 | Agent-absent: checkout shows browser print dialog | Manual checkout |
| B4-V7 | Agent-present: /health ping succeeds in DevTools | DevTools Network, agent running |
| B4-V8 | Agent-present: modal suppressed | Visual check |
| B4-V9 | Agent-present: no print dialog on checkout | Manual checkout |
| B4-V10 | Agent-present: autoPrint={false} passed to ReceiptModal | React DevTools or log |
| B4-V11 | Stop agent: modal reappears on reload | Manual check |
| B4-V12 [OWNER] | Full E2E: normal browser → agent → XP-80C silent print | Owner runs on shop PC |
| B4-V13 [OWNER] | All Thai text correct on physical receipt | Owner visual inspect |
| B4-V14 [OWNER] | Plan A kiosk fallback still works when agent absent | Owner runs kiosk shortcut |

---

## Implementation Checklist

Ordered by phase. Execute one phase at a time; verify gates before advancing.

### Phase B1 — Agent Scaffold

1. Create `tools/krs-print-agent/package.json` (B1-1)
2. Create `tools/krs-print-agent/config.js` with PORT, HOST, ALLOWED_ORIGINS, PRINTER_NAME, MAX_BODY_BYTES, THAI_CODEPAGE (B1-2)
3. Create `tools/krs-print-agent/index.js` — HTTP server with health, print-receipt stub, OPTIONS, CORS+PNA helper, body limit, graceful shutdown (B1-3)
4. Create `tools/krs-print-agent/.gitignore` (B1-4)
5. Create `tools/krs-print-agent/README.md` (B1-5)
6. Edit `deploy/RECEIPT-PRINTING.md` — add Plan B architecture section (B1-6)
7. Verify B1 gates B1-V1 through B1-V8

### Phase B2 — ESC/POS Rendering

8. Add `node-thermal-printer` to `tools/krs-print-agent/package.json` (B2-1)
9. Create `tools/krs-print-agent/encoding.js` — `encodeThai()` + `moneyAgent()` (B2-2)
10. Create `tools/krs-print-agent/printer.js` — `printReceipt()` with full ESC/POS layout spec (B2-3)
11. Edit `tools/krs-print-agent/index.js` — replace stub with `await printReceipt(body)` (B2-4)
12. Create `tools/krs-print-agent/scripts/test-print.js` + `npm run test-print` script (B2-5)
13. Verify B2 developer gates B2-V1 through B2-V4
14. OWNER: run `npm run test-print` on XP-80C; iterate THAI_CODEPAGE until Thai is correct; verify B2-V5 through B2-V9

### Phase B3 — Packaging + Autostart

15. Add `pkg` devDependency + `pkg.targets` to `tools/krs-print-agent/package.json`
16. Build `dist/krs-print-agent.exe` via `npm run build`
17. Create `deploy/setup-print-agent.bat` per specification (B3 steps)
18. Create `public/setup-print-agent.bat` (mirror of deploy version)
19. Edit `next.config.mjs` — add Content-Disposition header for `/setup-print-agent.bat`
20. Edit `deploy/RECEIPT-PRINTING.md` — add B3 install guide
21. Verify B3 developer gates B3-V1 through B3-V4
22. OWNER: run setup-print-agent.bat on shop PC; reboot; verify autostart; verify B3-V5 through B3-V8

### Phase B4 — Web Integration

23. Edit `src/lib/print/index.ts` — add `resolveReceiptPrintService()` + HEALTH_ENDPOINT + DETECTION_TIMEOUT_MS + module-level cache (B4-1)
24. Edit `src/app/(shell)/pos/page.tsx` — add printServiceRef, agentDetected state, async mount effect, conditional autoPrint in confirm handler, pass agentDetected to modal (B4-2)
25. Edit `src/components/pos/SilentPrintOnboardingModal.tsx` — add agentDetected prop, update modal copy and download targets (B4-3)
26. Create `public/setup-print-agent.bat` if not already created in B3 (B4-4)
27. Edit `next.config.mjs` — confirm setup-print-agent.bat Content-Disposition rule is present (B4-5)
28. Run `npm run type-check` + `npm run build` — must both pass (B4-6)
29. Verify B4 developer gates B4-V1 through B4-V11
30. OWNER: full E2E test on shop PC; verify B4-V12 through B4-V14

---

## Phase Completion Rules

A phase may only be marked **VERIFIED** when ALL of the following are true:

1. All developer verification gates for the phase pass (curl tests, type-check, build).
2. Owner hardware tests (marked [OWNER]) pass on the real XP-80C Windows shop PC.
3. No regression is introduced in previously verified phases:
   - B2 must not break B1 HTTP endpoints.
   - B3 must not introduce errors in the Next.js build.
   - B4 must not regress the Plan A kiosk path (BrowserPrintService fallback must still work).
4. The phase report is written (durable capture) before moving to the next phase.

Phase status conventions (per `process/development-protocols/phase-programs.md`):
- `PLANNED` — not started
- `CODE DONE` — implementation complete, developer gates pass, owner tests not yet run
- `VERIFIED` — all gates (developer + owner hardware) confirmed
- `BLOCKED` — real blocker documented; next action stated

**B2 block condition:** B2 is BLOCKED if no candidate THAI_CODEPAGE value (20, 21, 18, 17) produces
correct Thai output on the real XP-80C. Resolution: contact Xprinter for firmware code-table spec.

**B3 block condition:** B3 must not be executed until B2 is VERIFIED — do not ship a .exe that prints garbled Thai.

---

**Plan complete. Review carefully.**

Say **ENTER EXECUTE MODE** when ready to implement Phase B1 (agent scaffold).

Note: recommended first EXECUTE scope is Phase B1 only. After B1 curl gates pass, B4 web
detection logic may be written in parallel while the owner iterates B2 on the real XP-80C.

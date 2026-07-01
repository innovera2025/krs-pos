# KRS POS — Silent thermal-receipt printing / การพิมพ์ใบเสร็จแบบเงียบ

This document explains how to make a shop PC print 80mm thermal receipts **silently**
(no browser print dialog) with a single double-click, and documents the print
architecture for developers.

- **Receipt printer:** `XP-80C` (80mm thermal)
- **POS:** web app at `https://krspos.innoveraappcenter.com`
- **One-file setup:** [`kiosk-print-setup.bat`](./kiosk-print-setup.bat)

---

## Operator guide / คู่มือผู้ใช้งาน

### Why a print dialog appears / ทำไมถึงมีหน้าต่างสั่งพิมพ์เด้งขึ้นมา

**EN —** When the cashier confirms a sale, the POS calls the browser's
`window.print()`. By default every browser shows a **print dialog** and waits for
the user to click *Print*. Chromium browsers (Microsoft Edge, Google Chrome) only
skip that dialog and print **silently to the default printer** when they were
launched with the `--kiosk-printing` command-line flag. A normal
double-click on Edge/Chrome does **not** pass that flag, which is why the dialog
keeps showing.

**TH —** เมื่อแคชเชียร์กดยืนยันการขาย ระบบ POS จะเรียก `window.print()` ของเบราว์เซอร์
ปกติเบราว์เซอร์จะเปิด **หน้าต่างสั่งพิมพ์** ขึ้นมาให้กดยืนยันทุกครั้ง เบราว์เซอร์ตระกูล Chromium
(Microsoft Edge / Google Chrome) จะพิมพ์แบบ **เงียบไปที่เครื่องพิมพ์เริ่มต้น** โดยไม่เด้ง
หน้าต่าง ก็ต่อเมื่อถูกเปิดด้วยแฟล็ก `--kiosk-printing` เท่านั้น การเปิดเบราว์เซอร์แบบดับเบิลคลิก
ธรรมดา **จะไม่** ส่งแฟล็กนี้ จึงยังเห็นหน้าต่างสั่งพิมพ์อยู่

> Fully zero-touch is impossible: browsers block a website from forcing a printer
> for security reasons. The best achievable is **run one file once per PC**, then
> always open the POS from the shortcut it creates.
>
> ไม่สามารถทำแบบไม่แตะเครื่องเลยได้ (เบราว์เซอร์บล็อกเพื่อความปลอดภัย) สิ่งที่ทำได้ดีที่สุดคือ
> **รันไฟล์เดียวหนึ่งครั้งต่อเครื่อง** แล้วเปิด POS จากไอคอนที่สร้างให้เสมอ

### How to set up a shop PC / วิธีตั้งค่าเครื่องในร้าน

1. Make sure the `XP-80C` printer is installed and prints a Windows test page.
   / ตรวจสอบว่าติดตั้งเครื่องพิมพ์ `XP-80C` แล้วและพิมพ์หน้าทดสอบของ Windows ได้
2. Copy `kiosk-print-setup.bat` onto the PC and **double-click it once**.
   / คัดลอกไฟล์ `kiosk-print-setup.bat` ไปที่เครื่อง แล้ว **ดับเบิลคลิกหนึ่งครั้ง**
3. It sets `XP-80C` as the default printer and creates a Desktop icon named
   **"KRS POS"**. / ไฟล์จะตั้ง `XP-80C` เป็นเครื่องพิมพ์เริ่มต้น และสร้างไอคอน **"KRS POS"**
   บนเดสก์ท็อป
4. From now on, open the POS **only** by double-clicking the **"KRS POS"** icon.
   / ต่อจากนี้ให้เปิด POS **เฉพาะ** จากไอคอน **"KRS POS"** เท่านั้น
5. On the **first** launch, log in to the POS once. The isolated profile remembers
   the session afterward. / **ครั้งแรก** ให้เข้าสู่ระบบ POS หนึ่งครั้ง โปรไฟล์แยกจะจำ
   การเข้าสู่ระบบไว้ให้

The shortcut launches the browser with exactly:

```
--kiosk-printing --user-data-dir="%LOCALAPPDATA%\KrsPosKiosk" --app=https://krspos.innoveraappcenter.com
```

### Why `--user-data-dir` (an isolated profile) / ทำไมต้องใช้โปรไฟล์แยก

**EN —** `--kiosk-printing` only takes effect for a browser **process** that is
started fresh with the flag. If the cashier already has a normal Edge/Chrome window
open, clicking a plain shortcut would just open a new **tab** in that existing
process — which was started *without* the flag — so printing would still show the
dialog. Passing `--user-data-dir="...\KrsPosKiosk"` forces Windows to start a
**separate, dedicated browser instance** for the POS, guaranteeing the
`--kiosk-printing` flag actually applies. `--app=<url>` opens a clean POS window
with no tabs/address bar.

**TH —** `--kiosk-printing` มีผลเฉพาะกับ **โปรเซส** เบราว์เซอร์ที่เปิดใหม่พร้อมแฟล็กนี้เท่านั้น
ถ้าแคชเชียร์เปิดหน้าต่าง Edge/Chrome ปกติค้างอยู่แล้ว การกดชอร์ตคัตธรรมดาจะไปเปิดเป็น **แท็บใหม่**
ในโปรเซสเดิม (ที่เปิดมาแบบไม่มีแฟล็ก) จึงยังเห็นหน้าต่างสั่งพิมพ์ การใส่
`--user-data-dir="...\KrsPosKiosk"` บังคับให้เปิดเป็น **อินสแตนซ์เบราว์เซอร์แยกเฉพาะ** ของ POS
ทำให้แฟล็ก `--kiosk-printing` มีผลจริง ส่วน `--app=<url>` จะเปิดหน้าต่าง POS สะอาด ไม่มีแท็บ/แถบ URL

### Troubleshooting / การแก้ปัญหา

| Symptom / อาการ | Fix / วิธีแก้ |
| --- | --- |
| **Print dialog still shows / ยังเห็นหน้าต่างสั่งพิมพ์** | Make sure the POS was opened from the **"KRS POS"** icon, not a normal browser window. Close **all** Edge/Chrome windows and reopen via the icon so the isolated `--kiosk-printing` instance starts fresh. / เปิด POS จากไอคอน **"KRS POS"** เท่านั้น ปิดหน้าต่าง Edge/Chrome ทั้งหมดแล้วเปิดใหม่จากไอคอน |
| **Printed to the wrong printer / พิมพ์ผิดเครื่อง** | `--kiosk-printing` always prints to the **Windows default** printer. Re-run `kiosk-print-setup.bat` (it sets `XP-80C` as default) or set it manually in *Settings → Bluetooth & devices → Printers & scanners*. / รันไฟล์ตั้งค่าใหม่ หรือกำหนดเครื่องพิมพ์เริ่มต้นเอง |
| **Wrong paper size / margins / ขนาดกระดาษผิด** | In the `XP-80C` driver (*Printer properties → Preferences*) set the paper size to **80mm** (or 80 x 297mm). The POS also has an admin *Receipt size* setting (default 80mm). / ตั้งขนาดกระดาษเป็น **80mm** ในไดรเวอร์ และตรวจสอบค่า *ขนาดใบเสร็จ* ในหน้าตั้งค่าแอดมิน |
| **No "KRS POS" icon appeared / ไม่มีไอคอน** | Re-run the `.bat`. If the Desktop is redirected to OneDrive, the icon is created on the active Desktop folder. / รันไฟล์อีกครั้ง |
| **Default printer did not change / เครื่องพิมพ์เริ่มต้นไม่เปลี่ยน** | The `XP-80C` driver may not be installed, or it needs elevation — install the driver, then run the `.bat` again or *Run as administrator* once. The script prints the current default printer at the end so you can confirm. / ติดตั้งไดรเวอร์ก่อน แล้วรันไฟล์ใหม่ หรือรันแบบ Run as administrator |
| **Session logged out / ต้องล็อกอินใหม่ทุกครั้ง** | Don't delete `%LOCALAPPDATA%\KrsPosKiosk` — that isolated profile stores the POS login. / อย่าลบโฟลเดอร์โปรไฟล์ |

---

## Developer / architecture notes

### Print abstraction (target design)

Receipt printing is designed to sit behind a single, swappable service so the
checkout flow never needs to know *how* a receipt reaches paper:

```ts
// src/lib/print/ (target abstraction)
interface ReceiptData { /* order lines, totals, shop header, size, ... */ }

interface ReceiptPrintService {
  printReceipt(receipt: ReceiptData): Promise<void>;
}

// Chosen once, at a single seam — checkout just calls the returned service.
function getReceiptPrintService(): ReceiptPrintService;
```

Two backends implement the same interface:

| Backend | Transport | Silent? | Status |
| --- | --- | --- | --- |
| **`BrowserPrintService`** | `window.print()` + Chromium `--kiosk-printing` (this doc) | Yes, when the browser was launched with `--kiosk-printing` (default printer) | **Current** |
| **`PrintAgentService`** | HTTP `POST http://localhost:9100/print-receipt` to a local print agent that emits raw **ESC/POS** to the thermal printer | Yes, always (bypasses the browser entirely) | **Future** |

`getReceiptPrintService()` is the only place that decides which backend is active.
Swapping `BrowserPrintService` → `PrintAgentService` (once a local agent ships)
requires **no changes to the checkout/POS pages** — they keep calling
`printReceipt(receipt)`.

### What exists today (ground truth)

The **current live backend is `BrowserPrintService`**, and its concrete implementation
today is the browser `window.print()` path:

- **`src/lib/receiptPrint.ts`** — exports `printReceiptWithSize(settings)`, which
  injects a computed `@page { size: <W>mm <H> }` rule into `<head>` (the admin
  *Receipt size*, default 80mm), calls `window.print()`, and cleans up on
  `afterprint` (with a timeout fallback). Printing is never blocked on a settings
  load failure — it falls back to the `globals.css` 80mm default.
- **Call sites:** `src/app/(shell)/pos/page.tsx` (sale confirm) and
  `src/app/(shell)/sales/page.tsx` (reprint from history; the A4 tax invoice uses a
  separate `window.print()` on the `@page tax-invoice` named page).

Silence is delivered **entirely at the OS/browser launch layer** — the
`--kiosk-printing` flag on the shortcut created by `kiosk-print-setup.bat`. No app
code enables kiosk printing; the same `window.print()` call shows a dialog in a
normally-launched browser and prints silently in the kiosk-launched one.

### Future: local print agent (`PrintAgentService`)

The planned upgrade is a small local service (installed per PC) listening on
`http://localhost:9100/print-receipt`. `PrintAgentService.printReceipt()` would
`POST` the `ReceiptData` there; the agent renders **ESC/POS** and writes directly to
the `XP-80C`, giving fully silent, browser-independent printing (cash-drawer kick,
partial cut, logo, etc.). Because it satisfies the same `ReceiptPrintService`
interface and is selected only inside `getReceiptPrintService()`, adopting it is a
one-line factory change with **no checkout changes**.

### Kiosk shortcut contract (must stay exact)

`kiosk-print-setup.bat` creates a Desktop shortcut whose arguments are exactly:

```
--kiosk-printing --user-data-dir="<profileDir>" --app=<POS_URL>
```

- `--kiosk-printing` — silent print to the Windows default printer.
- `--user-data-dir="%LOCALAPPDATA%\KrsPosKiosk"` — dedicated instance so the flag
  reliably applies even when a normal browser is already open.
- `--app=<POS_URL>` — clean POS app window (no tabs/omnibox).

Editable variables live at the top of the `.bat`: `POS_URL`, `PRINTER`,
`PROFILE_DIR`. The file is idempotent (safe to re-run: it overwrites the shortcut
and re-applies the default printer).

> Console note: the `.bat` runs `chcp 65001` and is saved as UTF-8 so the Thai
> messages render. On very old console fonts Thai may show as boxes — the English
> lines always remain readable.

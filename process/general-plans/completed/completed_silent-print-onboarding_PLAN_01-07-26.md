# Silent Receipt Printing — In-App Onboarding

**Date:** 01-07-26
**Complexity:** SIMPLE (one session, ~7 atomic steps)
**Status:** PLANNED

---

## Overview

The POS currently ships a Windows batch file (`deploy/kiosk-print-setup.bat`) that a
shop operator must copy onto the cashier PC and run once to enable silent thermal
receipt printing. Finding and distributing that file is a friction point — owners have
to locate it in the repo or receive it out-of-band.

This plan delivers **Plan A**: a web-guided first-run onboarding that surfaces the
setup file directly inside the POS web app. The first time a cashier opens `/pos` in
a normal browser, a bilingual modal explains why a print dialog appears, offers a
one-click `.bat` download, and walks through the three setup steps. Once setup is
complete (either detected automatically via the `?kiosk=1` query flag or confirmed
manually), the modal is permanently suppressed.

**Plan B** (a localhost print agent — `PrintAgentService`) is outlined as a clearly
separated future phase at the end of this document and is NOT implemented here.

---

## Hard Constraint (Browser Sandbox)

A web page **cannot** configure silent printing by itself. The browser sandbox
prevents any website from:
- creating desktop shortcuts
- modifying system default printers
- injecting browser launch flags

Silent printing via `window.print()` ALWAYS requires a one-time on-machine step
(`--kiosk-printing` + `--user-data-dir` on the Chromium shortcut). Plan A makes that
step **discoverable and guided in-product**; it does not remove the OS-layer
requirement.

---

## Goals

1. Make the `.bat` downloadable from inside the POS web app (no file-hunting).
2. Show a first-run bilingual modal that explains the constraint and guides the
   operator through the three setup steps.
3. Suppress the modal automatically when the POS is opened via the kiosk shortcut
   (`?kiosk=1`), and suppress it permanently when the operator clicks "ตั้งค่าเสร็จแล้ว".
4. Update the `.bat` (both copies) to append `?kiosk=1` to the shortcut `--app` URL,
   so the suppression signal reaches the app on first kiosk launch.
5. Keep doc (`deploy/RECEIPT-PRINTING.md`) current with the new in-product flow.

---

## Scope

### In Scope

- `public/kiosk-print-setup.bat` — new static asset served at `/kiosk-print-setup.bat`
- `deploy/kiosk-print-setup.bat` — edit: append `?kiosk=1` to `POS_URL`
- `next.config.mjs` — add `headers()` rule for `/kiosk-print-setup.bat` (force download)
- `src/lib/kioskMode.ts` — new localStorage helper (4 exported functions)
- `src/components/pos/SilentPrintOnboardingModal.tsx` — new modal component
- `src/app/(shell)/pos/page.tsx` — mount effect + state wiring for the modal
- `deploy/RECEIPT-PRINTING.md` — add in-app onboarding section

### Out of Scope

- Any API route for file download (static asset is sufficient)
- Schema / Prisma / DB changes
- Authentication or RBAC changes
- Checkout / money / stock logic
- Plan B (local print agent) — outlined as future phase only
- Multi-tenant `POS_URL` parameterization (called out as a future concern)

---

## Touchpoints

| File | Change Type | Description |
|---|---|---|
| `public/kiosk-print-setup.bat` | CREATE | Static copy of the setup file served at `/kiosk-print-setup.bat` |
| `deploy/kiosk-print-setup.bat` | EDIT | Change `POS_URL` to include `?kiosk=1`; add sync comment |
| `next.config.mjs` | EDIT | Add `async headers()` rule → `Content-Disposition: attachment` for `.bat` path |
| `src/lib/kioskMode.ts` | CREATE | LocalStorage helper: persist, read, dismiss kiosk/onboarding state |
| `src/components/pos/SilentPrintOnboardingModal.tsx` | CREATE | Bilingual first-run onboarding modal |
| `src/app/(shell)/pos/page.tsx` | EDIT | Mount effect + `onboardingOpen` state + modal JSX |
| `deploy/RECEIPT-PRINTING.md` | EDIT | New section: in-app onboarding flow + `?kiosk=1` explanation |

---

## Public Contracts

### `src/lib/kioskMode.ts` — exported surface

```
STORAGE_KEY_KIOSK      = 'krspos_kiosk_mode'      (localStorage key)
STORAGE_KEY_DISMISSED  = 'krspos_silentprint_dismissed'  (localStorage key)

persistKioskModeIfFlagged(): void
  — reads window.location.search; if '?kiosk=1' (or '&kiosk=1') is present,
    sets localStorage[STORAGE_KEY_KIOSK] = '1'. No-op otherwise.
  — MUST be called before shouldShowOnboardingModal() on every page mount.

isKioskMode(): boolean
  — returns localStorage.getItem(STORAGE_KEY_KIOSK) === '1'

isDismissed(): boolean
  — returns localStorage.getItem(STORAGE_KEY_DISMISSED) === '1'

markDismissed(): void
  — sets localStorage[STORAGE_KEY_DISMISSED] = '1'

shouldShowOnboardingModal(): boolean
  — returns !isKioskMode() && !isDismissed()
  — safe to call server-side? NO — guards all localStorage calls with
    typeof window !== 'undefined' checks; returns false when not in browser.
```

### `src/components/pos/SilentPrintOnboardingModal.tsx` — props contract

```
type SilentPrintOnboardingModalProps = {
  open: boolean
  onClose: () => void               // temporary close (modal may re-appear)
  onDismissPermanently: () => void  // sets dismissed flag; modal will not re-appear
}
```

### URL contract — `?kiosk=1` query flag

The `deploy/kiosk-print-setup.bat` shortcut `--app` argument is updated from:
  `https://krspos.innoveraappcenter.com`
to:
  `https://krspos.innoveraappcenter.com/?kiosk=1`

This is the SOLE mechanism for detecting a kiosk session in the web app.
The app persists the flag to localStorage on first load; subsequent navigations
within the same session that drop the query param still read the persisted flag.

**Limitation (acceptable for Plan A):** The web app CANNOT verify that
`--kiosk-printing` is actually active — it trusts the `?kiosk=1` signal and the
operator's explicit "setup complete" action. Plan B removes this limitation entirely
via real agent detection.

---

## Blast Radius

- **No money, stock, or checkout logic touched.** `src/app/api/orders/route.ts` is
  not modified.
- **No Prisma schema changes.** No migration required.
- **No auth surface touched.** Modal is purely client-side UI.
- **No existing print path altered.** `BrowserPrintService`, `getReceiptPrintService()`,
  and `printReceiptWithSize()` are unchanged.
- **Only `pos/page.tsx` is edited** — a `useEffect` mount block and a `useState` for
  `onboardingOpen`, plus one modal component in JSX. The rest of the page is
  untouched.
- **`next.config.mjs` touch is minimal:** one `headers()` async function added.
- **`.bat` change is backward-compatible:** the `?kiosk=1` suffix on the `--app` URL
  is ignored by the POS if the kiosk check is not yet wired; after wiring, it only
  affects the suppression logic (no functional behavior change for printing).
- **LocalStorage keys are new, not colliding** with any existing keys in the codebase.

---

## Data Flow

```
FIRST LOAD — normal browser (no kiosk shortcut)
  → pos/page.tsx mounts
  → useEffect: persistKioskModeIfFlagged() → URL has no ?kiosk=1 → no-op
  → shouldShowOnboardingModal() → !false && !false → true
  → setOnboardingOpen(true)
  → SilentPrintOnboardingModal renders

OPERATOR CLICKS "ดาวน์โหลดตัวตั้งค่า"
  → <a href="/kiosk-print-setup.bat" download="kiosk-print-setup.bat">
  → browser downloads /kiosk-print-setup.bat (Content-Disposition: attachment)
  → modal stays open; operator follows the 3 steps

OPERATOR CLICKS "ตั้งค่าเสร็จแล้ว · ไม่ต้องแสดงอีก"
  → onDismissPermanently() → markDismissed() → localStorage[STORAGE_KEY_DISMISSED]='1'
  → setOnboardingOpen(false)
  → next page load: isDismissed() → true → modal stays hidden forever

OPERATOR CLICKS X / backdrop
  → onClose() → setOnboardingOpen(false) (no flag written)
  → next page load: shouldShowOnboardingModal() → true → modal reappears

FIRST LOAD — kiosk shortcut (?kiosk=1 in URL from .bat shortcut)
  → pos/page.tsx mounts
  → persistKioskModeIfFlagged() → detects ?kiosk=1 → localStorage[STORAGE_KEY_KIOSK]='1'
  → shouldShowOnboardingModal() → isKioskMode()=true → returns false
  → modal suppressed — cashier never sees it in the kiosk window

SUBSEQUENT KIOSK LOADS (URL no longer has ?kiosk=1 after client navigation)
  → persistKioskModeIfFlagged() → no param → no-op
  → isKioskMode() → localStorage[STORAGE_KEY_KIOSK] === '1' → true (persisted)
  → modal suppressed
```

---

## Implementation Checklist

### Step 1 — Edit `deploy/kiosk-print-setup.bat`: add `?kiosk=1` to `POS_URL`

File: `deploy/kiosk-print-setup.bat`, line 26.

Change:
```
set "POS_URL=https://krspos.innoveraappcenter.com"
```
to:
```
set "POS_URL=https://krspos.innoveraappcenter.com/?kiosk=1"
```

Also add a comment directly above the `POS_URL` line:
```
REM  NOTE: ?kiosk=1 tells the web app this is the kiosk shortcut session.
REM  The app persists this to localStorage → suppresses the onboarding modal.
REM  Keep in sync with public/kiosk-print-setup.bat (the in-product download copy).
```

No other lines in the `.bat` change. The resulting shortcut `Arguments` become:
```
--kiosk-printing --user-data-dir="..." --app=https://krspos.innoveraappcenter.com/?kiosk=1
```

### Step 2 — Create `public/kiosk-print-setup.bat`: in-product download copy

Create `public/kiosk-print-setup.bat` with **identical content** to the updated
`deploy/kiosk-print-setup.bat` (from Step 1).

Add a comment block at the very top (before the `@echo off` line, or just below
the `title` line) marking it as an in-product copy:
```
REM  *** IN-PRODUCT COPY — served at /kiosk-print-setup.bat by Next.js static asset ***
REM  *** Keep in sync with deploy/kiosk-print-setup.bat (the canonical source). ***
```

**Static asset serving:** Next.js automatically serves all files under `public/` at
the root URL, so `public/kiosk-print-setup.bat` is reachable at
`https://krspos.innoveraappcenter.com/kiosk-print-setup.bat` with no extra
configuration needed for routing.

**Sync policy (caller note):** These two files (`deploy/` and `public/`) must be kept
identical. The `deploy/` copy is the canonical source (checked into the repo for
operator deployment); the `public/` copy is the in-product mirror. Any future edit to
one must be mirrored to the other. A comment in both files documents this requirement.

**Multi-tenant future concern:** `POS_URL` is currently hardcoded to the prod URL.
For a multi-shop deployment, this `.bat` would need to be generated dynamically per
tenant (e.g., via an API route that injects the correct URL). This is not in scope
for Plan A.

### Step 3 — Edit `next.config.mjs`: add `Content-Disposition` header for `.bat` download

Add an `async headers()` function to `nextConfig` so that `/kiosk-print-setup.bat`
is served with `Content-Disposition: attachment` and `Content-Type: application/octet-stream`.
This forces browsers to download the file rather than rendering it as text.

**Why this is needed:** Without the `Content-Disposition: attachment` header, some
browsers (especially on macOS/Linux) open `.bat` files as plain text in the tab. The
`<a download>` attribute on the anchor element handles this in most modern browsers,
but the server-side header is the reliable fallback.

The `headers()` entry:
- `source`: `/kiosk-print-setup.bat`
- `headers`:
  - `Content-Disposition: attachment; filename="kiosk-print-setup.bat"`
  - `Content-Type: application/octet-stream`

The existing `output: "standalone"` and `distDir` entries remain unchanged.

**Windows SmartScreen warning:** `.bat` files downloaded from the internet trigger
Windows SmartScreen ("Windows protected your PC"). This is expected and cannot be
bypassed from the server. The onboarding modal (Step 5) must include an operator
note: "หากเห็นหน้าต่าง Windows protected your PC ให้กด 'More info' แล้ว 'Run anyway'"
/ "If Windows shows a security warning, click 'More info' then 'Run anyway'."

### Step 4 — Create `src/lib/kioskMode.ts`: localStorage helper

New file. All functions must guard against SSR (`typeof window === 'undefined'`).

**Exported constants:**
```
STORAGE_KEY_KIOSK     = 'krspos_kiosk_mode'
STORAGE_KEY_DISMISSED = 'krspos_silentprint_dismissed'
```

**Exported functions (signatures):**

`persistKioskModeIfFlagged(): void`
- Guard: if not in browser, return immediately.
- Parse `window.location.search` with `URLSearchParams`.
- If `params.get('kiosk') === '1'`, call
  `localStorage.setItem(STORAGE_KEY_KIOSK, '1')`.
- No-op in all other cases. Does NOT clear the flag if param is absent
  (because subsequent navigations lose the query param).

`isKioskMode(): boolean`
- Guard: if not in browser, return `false`.
- Returns `localStorage.getItem(STORAGE_KEY_KIOSK) === '1'`.

`isDismissed(): boolean`
- Guard: if not in browser, return `false`.
- Returns `localStorage.getItem(STORAGE_KEY_DISMISSED) === '1'`.

`markDismissed(): void`
- Guard: if not in browser, return immediately.
- Sets `localStorage.setItem(STORAGE_KEY_DISMISSED, '1')`.

`shouldShowOnboardingModal(): boolean`
- Returns `!isKioskMode() && !isDismissed()`.
- Safe to call server-side (both sub-functions guard → both return `false` →
  returns `false` on server, correct for SSR).

**Important: do NOT call `persistKioskModeIfFlagged` inside `shouldShowOnboardingModal`.**
The persist step is a side-effect and must be called explicitly (and first) in the
`pos/page.tsx` mount effect. `shouldShowOnboardingModal` is a pure read.

### Step 5 — Create `src/components/pos/SilentPrintOnboardingModal.tsx`

New file. Implement as a `"use client"` React component. Import `Modal` from
`@/components/Modal`.

**Props:**
```ts
type SilentPrintOnboardingModalProps = {
  open: boolean
  onClose: () => void
  onDismissPermanently: () => void
}
```

**Component structure (inside `<Modal open={open} onClose={onClose} label="ตั้งค่าพิมพ์ใบเสร็จ">`):**

Panel wrapper: white/near-white card, `max-w-md w-full`, `rounded-xl`, `p-6`,
`shadow-lg`, matches KRS POS Taste Redesign (forest-green/mint palette, IBM Plex
Sans Thai).

**Section 1 — Header**
- Title (Thai-first): "ตั้งค่าพิมพ์ใบเสร็จอัตโนมัติ"
- Subtitle (EN): "Silent Receipt Printing Setup"
- Close button (X icon, top-right): calls `onClose` (temporary close, no dismiss flag)

**Section 2 — Explanation**
Thai paragraph (primary): Why a print dialog appears; that a one-time setup is
needed; the benefit (no dialog after setup).

English paragraph (secondary, smaller/muted): Mirror of the Thai explanation in
concise English.

Key copy points (both languages):
- Browsers show a print dialog by default (`window.print()` opens a dialog).
- The setup creates a special shortcut that launches the browser with silent printing.
- This only needs to be done once per PC.

**Section 3 — Numbered Steps**
Numbered list (1–3):
1. Thai: "ตรวจสอบว่าติดตั้งเครื่องพิมพ์ XP-80C แล้ว และพิมพ์หน้าทดสอบของ Windows ได้"
   EN: "Ensure the XP-80C thermal printer is installed and prints a Windows test page."
2. Thai: "ดาวน์โหลดและดับเบิลคลิกไฟล์ตั้งค่า (ปุ่มด้านล่าง) ทำเพียงครั้งเดียวต่อเครื่อง"
   EN: "Download and double-click the setup file below. Run it once per PC."
3. Thai: "เปิด POS จากไอคอน 'KRS POS' บนเดสก์ท็อปเท่านั้น (อย่าเปิดจากเบราว์เซอร์ธรรมดา)"
   EN: "Always open the POS from the 'KRS POS' desktop icon — never from a plain browser window."

**Section 4 — Download button**
`<a href="/kiosk-print-setup.bat" download="kiosk-print-setup.bat">`
styled as a forest-green pill button (primary action), full-width:
Label: "ดาวน์โหลดตัวตั้งค่า  /  Download Setup File"
Icon: `Download` from `lucide-react` (left of text)

**SmartScreen warning note** (below the download button, small muted text):
Thai: "หากเห็นหน้าต่าง 'Windows protected your PC' ให้กด 'More info' แล้ว 'Run anyway'"
EN: "If Windows shows a security warning, click 'More info' then 'Run anyway'."

**Section 5 — Dismiss button**
Full-width outlined button (secondary style, mint/forest border):
Label: "ตั้งค่าเสร็จแล้ว · ไม่ต้องแสดงอีก  /  Setup complete — don't show again"
On click: calls `onDismissPermanently()`

**Design constraints (KRS POS Taste Redesign language):**
- Font: IBM Plex Sans Thai (already loaded via `globals.css` / Tailwind config)
- Primary action color: forest green (`#1a6b3a` or the closest Tailwind token in use —
  inspect existing PaymentModal/TotalsBar for the exact `bg-green-*` token in use)
- Secondary/outline: mint border, white background
- Rounded corners: `rounded-xl` for the panel, `rounded-lg` for buttons
- No heavy shadows — use the hairline border pattern already in Modal children
- Thai-first: Thai text is the primary typeface weight; English is smaller/muted

**Accessibility:**
- `Modal` already handles focus-trap, Escape, and `aria-modal`. The label prop
  provides the accessible name.
- The download anchor must have a descriptive `aria-label` ("ดาวน์โหลดไฟล์ตั้งค่า
  kiosk-print-setup.bat").
- The dismiss button must be a `<button>` (not an anchor).

### Step 6 — Edit `src/app/(shell)/pos/page.tsx`: wire the modal

**Imports to add:**
```
import { SilentPrintOnboardingModal } from "@/components/pos/SilentPrintOnboardingModal"
import {
  persistKioskModeIfFlagged,
  markDismissed,
  shouldShowOnboardingModal,
} from "@/lib/kioskMode"
```

**State to add (after the existing `heldBillsOpen` state block):**
```
const [onboardingOpen, setOnboardingOpen] = useState(false)
```

**Effect to add (new `useEffect` with `[]` deps, after the held-bill count effect):**
```
useEffect(() => {
  // 1. Persist ?kiosk=1 FIRST (before the shouldShow read).
  persistKioskModeIfFlagged()
  // 2. Show modal only if not kiosk mode and not previously dismissed.
  if (shouldShowOnboardingModal()) {
    setOnboardingOpen(true)
  }
}, [])
```

**Handlers to add (near the other close/dismiss handlers in the component):**
```
function handleOnboardingClose() {
  setOnboardingOpen(false)
  // Temporary close only — modal will re-appear on next page load unless
  // the operator clicks "ตั้งค่าเสร็จแล้ว" or opens via the kiosk shortcut.
}

function handleOnboardingDismiss() {
  markDismissed()
  setOnboardingOpen(false)
}
```

**JSX to add (after the last `<HeldBillsModal>` or at the end of the JSX return,
before the closing fragment/div):**
```jsx
<SilentPrintOnboardingModal
  open={onboardingOpen}
  onClose={handleOnboardingClose}
  onDismissPermanently={handleOnboardingDismiss}
/>
```

**No other changes to `pos/page.tsx`.** The checkout, payment, receipt, and held-bill
paths are entirely unaffected.

### Step 7 — Edit `deploy/RECEIPT-PRINTING.md`: add in-app onboarding section

Add a new section after the existing "Operator guide" section, before the
"Developer / architecture notes" section. Title:

```
## In-app setup guide / คู่มือตั้งค่าผ่านแอป
```

Content to include:
1. The POS now shows a setup guide the first time it is opened in a normal browser.
2. The guide provides a download button for `kiosk-print-setup.bat` directly at
   `/kiosk-print-setup.bat`.
3. After completing setup, clicking "ตั้งค่าเสร็จแล้ว · ไม่ต้องแสดงอีก" hides the
   guide permanently (localStorage `krspos_silentprint_dismissed`).
4. The kiosk shortcut (created by the `.bat`) now launches the app with `?kiosk=1`.
   On first kiosk load, the app sets `localStorage krspos_kiosk_mode=1` — this
   suppresses the modal in the kiosk session automatically.
5. The web app CANNOT confirm `--kiosk-printing` is active — it trusts the `?kiosk=1`
   signal and the operator's "setup complete" action.
6. LocalStorage keys: `krspos_kiosk_mode` and `krspos_silentprint_dismissed`.
7. Note the SmartScreen behavior on `.bat` download.

Also update the "How to set up a shop PC" numbered list to reference the in-app guide
as the recommended starting point (before copying the file manually), and note that the
`.bat` is also available at the in-app URL for download.

---

## Dependencies and Sequencing

Steps can be performed in any order logically, but the recommended sequence is:

1 → 2 (public bat needs the updated POS_URL from step 1)
3 (next.config.mjs, independent — can be done any time)
4 (kioskMode.ts, independent — create before step 6)
5 (SilentPrintOnboardingModal.tsx, depends on kioskMode.ts imports indirectly via step 6)
6 (pos/page.tsx, depends on steps 4 and 5)
7 (RECEIPT-PRINTING.md, independent — update last)

The two `.bat` edits (steps 1 and 2) must match exactly. Write step 1 first, then
replicate to step 2 to avoid divergence.

---

## Failure Modes and Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| `public/kiosk-print-setup.bat` and `deploy/kiosk-print-setup.bat` diverge | Operator downloads a different file than the deploy reference | Both files carry a "keep in sync" comment; plan notes that any edit to one must mirror to the other |
| Browser renders `.bat` as text instead of downloading | Operator confused; content visible but file not saved | Server header `Content-Disposition: attachment` (step 3) + `<a download>` attribute (step 5) both guard against this |
| SmartScreen blocks the `.bat` on Windows | Operator cannot run setup | Modal copy explicitly instructs "More info → Run anyway"; RECEIPT-PRINTING.md updated |
| `?kiosk=1` not present on first kiosk load (operator runs old .bat) | Modal appears in kiosk window | Non-fatal: operator clicks dismiss; old .bat can be re-run once updated |
| `localStorage` not available (private browsing, etc.) | `shouldShowOnboardingModal` always returns false → modal never shows | Acceptable: POS is a production cashier tool, not a public kiosk browser; private browsing is atypical; all kioskMode functions guard with `typeof window` checks so no crash |
| Modal appears on top of an active payment flow if page is force-reloaded mid-payment | Cashier distraction | Acceptable: page reload mid-payment already loses cart state; the modal is behind the payment modal in z-index (existing modals use z-50; both share the same portal) — in practice both can coexist; the payment modal's focus-trap takes precedence |
| `next.config.mjs` `headers()` not applied in `output: "standalone"` mode | `.bat` served without Content-Disposition | Next.js standalone mode DOES apply custom headers config; this is standard Next.js behavior |

---

## Verification Evidence

### Automated checks (required before "done")

1. `npm run type-check` passes with zero TypeScript errors.
2. `npm run build` passes (Next.js production build succeeds).

### Manual checks (operator/developer)

3. **Normal browser — first load:**
   Open `/pos` in a regular Chrome/Edge window (no kiosk flags). The onboarding modal
   appears. The title and bilingual body are rendered correctly. The download button is
   a link (not a button). The dismiss button is a button element.

4. **Download check:**
   Click "ดาวน์โหลดตัวตั้งค่า". Browser saves `kiosk-print-setup.bat` to the
   Downloads folder (not renders it as text). Content matches the updated
   `deploy/kiosk-print-setup.bat` including `POS_URL` with `?kiosk=1`.

5. **Temporary close:**
   Click X. Modal closes. Reload `/pos`. Modal reappears (flag was not written).

6. **Permanent dismiss:**
   Click "ตั้งค่าเสร็จแล้ว · ไม่ต้องแสดงอีก". Modal closes. Reload `/pos`. Modal
   does NOT reappear. Confirm `localStorage.getItem('krspos_silentprint_dismissed')`
   is `'1'` in DevTools.

7. **Kiosk suppression:**
   Open `/pos?kiosk=1` in any browser. Modal does NOT appear. Confirm
   `localStorage.getItem('krspos_kiosk_mode')` is `'1'` in DevTools. Navigate to
   `/pos` (without param). Modal still does NOT appear (persisted).

8. **No regression on checkout:**
   Add items to cart, open Payment modal, confirm checkout. Receipt auto-prints as
   before. The onboarding modal is not visible during or after checkout.

9. **`.bat` shortcut target (Windows — owner-verified):**
   Run the updated `kiosk-print-setup.bat` on a Windows PC. Open the created "KRS POS"
   desktop shortcut. Browser launches with `--kiosk-printing` and opens
   `https://krspos.innoveraappcenter.com/?kiosk=1`. The modal does NOT appear.
   Confirm a receipt prints silently on payment confirm.

### Note on actual silent-print verification

Silent printing still requires running the `.bat` on a real Windows PC with the
`XP-80C` driver installed and set as the default printer. The web app has no way to
confirm `--kiosk-printing` is active. Step 9 above is owner-verified offline.

---

## Acceptance Criteria

1. `npm run type-check` and `npm run build` both pass.
2. The onboarding modal appears on first normal-browser load of `/pos`.
3. The modal is suppressed after "ตั้งค่าเสร็จแล้ว" is clicked (localStorage flag set).
4. The modal is suppressed when `/pos?kiosk=1` is opened (kiosk flag persisted to localStorage).
5. The modal does not appear again after either suppression condition is met (cross-session).
6. The `.bat` download serves the file with correct `Content-Disposition: attachment`.
7. The downloaded `.bat` contains `POS_URL=https://krspos.innoveraappcenter.com/?kiosk=1`.
8. Checkout, payment, and auto-print flows are unaffected (no regression).

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Two-file sync drift (deploy/ vs public/) | Medium | Low — both files carry a sync comment | Comment in both files; plan instructs execute agent to write step 1 first, then copy |
| SmartScreen friction for operator | High (Windows default behavior) | Low — one-time inconvenience | Modal copy + doc cover the "More info → Run anyway" path |
| Old `.bat` already deployed on cashier PC | Low (admin can re-run) | Low — modal appears once in kiosk, operator clicks dismiss | Backward-compatible: old shortcut without `?kiosk=1` only means the modal appears once in the kiosk window, operator dismisses it |
| `localStorage` cleared by browser policy | Low | Low — operator sees modal once more, re-dismisses | No data loss; modal is non-blocking |

---

## Integration Notes

- **`Modal.tsx`** is reused as-is. The new component is a pure consumer of the
  existing `Modal` primitive (focus-trap, Escape, aria-modal already handled).
- **`lucide-react`** is already a project dependency — `Download` icon can be
  imported directly.
- **No new npm packages** are required.
- **`next.config.mjs` headers()** function: Next.js 14 App Router fully supports this
  pattern; existing `output: "standalone"` is compatible with custom response headers.
- **The `.bat` files** are UTF-8 with `chcp 65001` already set — Thai characters in
  the existing file render correctly. No encoding change needed.
- **`src/types/index.ts`** — no new types needed; all types are co-located with the
  new files or are primitives.

---

## Plan B — Future Phase (Outline Only)

**Goal:** Eliminate the kiosk shortcut requirement entirely. The web app pings a small
local service on `http://localhost:9100`; if present, it prints ESC/POS silently
without any browser dialog or OS-level launch flag.

**Architecture:**
- A small installable service (Node/Python/Rust) runs as a Windows background process,
  listening on `http://localhost:9100/print-receipt`.
- It accepts `POST` with `ReceiptData` JSON, renders ESC/POS, and writes directly to
  the `XP-80C` (or any configured thermal printer).
- CORS: `Access-Control-Allow-Origin: https://krspos.innoveraappcenter.com`.
  The `https:// → http://localhost` connection is exempt from mixed-content blocking
  (browser spec exception for localhost). However, the browser sends a **Private
  Network Access preflight** — the service must respond with
  `Access-Control-Allow-Private-Network: true` to the OPTIONS request, or the fetch
  will be blocked in Chrome/Edge 98+.
- `PrintAgentService` (already stubbed at `src/lib/print/printAgentService.ts`) is
  the web-app client. It already handles timeout, abort, and `failOpen`.

**Detection and swap:**
- On POS page load (or on payment confirm), ping the agent: `GET http://localhost:9100/health`.
  - Agent responds → use `PrintAgentService` via `getReceiptPrintService()` (one-line swap).
  - No response within 2s → fall back to `BrowserPrintService` + show "install agent" toast or modal.
- This replaces the `?kiosk=1` suppression with real capability detection: agent present
  = silent print confirmed, no kiosk shortcut needed.

**Onboarding modal update (Plan B):**
- The existing onboarding modal from Plan A is replaced or extended: the modal only
  appears when the agent is absent.
- The "download" button now points to an agent installer (not the `.bat`).
- After the agent is installed and running, the next ping succeeds and the modal
  never appears again — no localStorage suppression needed.

**Out of scope for Plan A. Do not implement in this session.**

The `ReceiptPrintService` abstraction (interface + factory) already makes this a
**one-line change** in `getReceiptPrintService()`. Plan B is the robust end-state;
Plan A is the pragmatic operational bridge until the agent ships.

---

## Resume and Execution Handoff

**Selected plan file:** `process/general-plans/active/silent-print-onboarding_PLAN_01-07-26.md`

**Supporting files for execute context:**
- `deploy/kiosk-print-setup.bat` — the canonical `.bat` to edit in Step 1
- `src/lib/print/index.ts` — print factory (read-only reference)
- `src/components/Modal.tsx` — shared modal primitive (read-only reference)
- `src/app/(shell)/pos/page.tsx` — POS page to edit in Step 6
- `next.config.mjs` — config to edit in Step 3

**Execute checklist sequence:** Steps 1 → 2 → 3 → 4 → 5 → 6 → 7 (in that order).

**Required verifications before "done":** `npm run type-check`, `npm run build`, then
all 8 manual checks in the Verification Evidence section.

**Plan B is explicitly deferred.** Do not implement any agent detection, localhost
fetch, or `PrintAgentService` wiring in this session.

**Validate this plan artifact:**
```
node .claude/skills/vc-generate-plan/scripts/validate-plan-artifact.mjs \
  process/general-plans/active/silent-print-onboarding_PLAN_01-07-26.md
```

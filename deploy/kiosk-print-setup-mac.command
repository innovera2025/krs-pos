#!/bin/bash
# ============================================================================
#  KRS POS — One-click silent thermal-receipt printing setup (macOS)
# ----------------------------------------------------------------------------
#  Mac counterpart of deploy/kiosk-print-setup.bat. Run ONCE on a Mac POS. It:
#    1. Sets the receipt printer as the macOS/CUPS default printer (lpoptions).
#    2. Creates a "KRS POS" app on the Desktop that opens the POS in Chrome (or
#       Edge) with Chromium's --kiosk-printing flag, so window.print() prints
#       SILENTLY to the default printer (no print dialog) — same behaviour as
#       the Windows .bat.
#
#  Safe to re-run: it just re-applies the default and rebuilds the Desktop app.
#
#  FIRST RUN (Gatekeeper): a downloaded .command is quarantined. In Terminal:
#      chmod +x "kiosk-print-setup-mac.command"
#      xattr -d com.apple.quarantine "kiosk-print-setup-mac.command"  2>/dev/null
#  then double-click it (or right-click > Open the first time).
# ============================================================================
set -u

# ---- CONFIG (edit per shop if needed) --------------------------------------
POS_URL="https://krspos.innoveraappcenter.com/?kiosk=1"
PRINTER="XP-80C"
PROFILE_DIR="$HOME/Library/Application Support/KrsPosKiosk"
# Desktop location (overridable for testing via KRS_DESKTOP_DIR).
DESKTOP_DIR="${KRS_DESKTOP_DIR:-$HOME/Desktop}"

echo ""
echo "============================================================"
echo "  KRS POS — Mac Kiosk Print Setup"
echo "============================================================"

# ---- Detect browser (Chrome first, then Edge) ------------------------------
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
EDGE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
if [ -x "$CHROME" ]; then
  BROWSER="$CHROME"; BROWSER_NAME="Google Chrome"
elif [ -x "$EDGE" ]; then
  BROWSER="$EDGE"; BROWSER_NAME="Microsoft Edge"
else
  echo "  [!] ไม่พบ Google Chrome หรือ Microsoft Edge — ติดตั้งก่อนแล้วรันไฟล์นี้ใหม่"
  echo "      Neither Google Chrome nor Microsoft Edge was found. Install one,"
  echo "      then run this file again."
  echo ""
  read -n 1 -s -r -p "Press any key to close..."; echo
  exit 1
fi
echo "  Browser : $BROWSER_NAME"
echo "  Printer : $PRINTER"
echo "  POS URL : $POS_URL"
echo "  Profile : $PROFILE_DIR"
echo ""

# ---- 1) Set the receipt printer as the CUPS default ------------------------
echo "[1/2] Setting \"$PRINTER\" as the default printer ..."
if lpstat -p "$PRINTER" >/dev/null 2>&1; then
  if lpoptions -d "$PRINTER" >/dev/null 2>&1; then
    echo "      OK — default printer = $PRINTER"
  else
    echo "      [!] ตั้ง default ไม่สำเร็จ (ลองรันซ้ำ)"
  fi
else
  echo "      [!] ยังไม่พบเครื่องพิมพ์ชื่อ \"$PRINTER\" ในระบบ"
  echo "          เพิ่มเครื่องพิมพ์ก่อนที่  System Settings > Printers & Scanners"
  echo "          Add the printer first (System Settings > Printers & Scanners)."
  echo "          เครื่องพิมพ์ที่มีตอนนี้ / printers found now:"
  if lpstat -a >/dev/null 2>&1 && [ -n "$(lpstat -a 2>/dev/null)" ]; then
    lpstat -a 2>/dev/null | awk '{print "            - " $1}'
  else
    echo "            (ยังไม่มี / none)"
  fi
  echo "          ถ้าชื่อเครื่องพิมพ์ไม่ใช่ \"$PRINTER\" ให้แก้ตัวแปร PRINTER"
  echo "          ที่ต้นไฟล์นี้ให้ตรงชื่อจริง แล้วรันใหม่."
fi
echo ""

# ---- 2) Create the "KRS POS" launcher app on the Desktop -------------------
echo "[2/2] Creating \"KRS POS\" app on the Desktop ..."
mkdir -p "$PROFILE_DIR"
APP_PATH="$DESKTOP_DIR/KRS POS.app"
rm -rf "$APP_PATH"

# The shell command the app runs: launch the browser in kiosk-printing mode,
# backgrounded + output discarded so `do shell script` returns immediately.
LAUNCH="\"$BROWSER\" --kiosk-printing --user-data-dir=\"$PROFILE_DIR\" --app=\"$POS_URL\" > /dev/null 2>&1 &"

# Wrap it in an AppleScript app (no Terminal window on double-click). Escape
# backslashes then double-quotes so it is a valid AppleScript string literal.
AS_TMP="$(mktemp -t krspos-launcher).applescript"
ESCAPED="$(printf '%s' "$LAUNCH" | sed 's/\\/\\\\/g; s/"/\\"/g')"
printf 'do shell script "%s"\n' "$ESCAPED" > "$AS_TMP"
if osacompile -o "$APP_PATH" "$AS_TMP" 2>/dev/null; then
  echo "      OK — $APP_PATH"
else
  echo "      [!] สร้างแอปไม่สำเร็จ (osacompile) — ลองรันซ้ำ"
fi
rm -f "$AS_TMP"
echo ""

echo "============================================================"
echo "  เสร็จสมบูรณ์!  /  SETUP COMPLETE!"
echo "============================================================"
echo ""
echo "  [TH] เปิดระบบขาย (POS) โดยดับเบิลคลิกแอป \"KRS POS\" บนหน้าจอ Desktop"
echo "       - ครั้งแรก: คลิกขวาที่แอป > Open (ผ่าน Gatekeeper) แล้วเข้าสู่ระบบ 1 ครั้ง"
echo "       - เมื่อกดยืนยันการชำระเงิน ใบเสร็จจะพิมพ์ออก \"$PRINTER\" ทันที ไม่มีหน้าต่างสั่งพิมพ์"
echo ""
echo "  [EN] Open the POS by double-clicking the \"KRS POS\" app on the Desktop."
echo "       First launch: right-click the app > Open. On payment confirm the"
echo "       receipt prints silently to \"$PRINTER\" with no print dialog."
echo ""
read -n 1 -s -r -p "Press any key to close..."; echo
